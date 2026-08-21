/**
 * One MCP server connection: initialize handshake, capability negotiation,
 * bounded pagination, tool calls, cancellation, restart state
 * (docs/31 sections 4 and 7).
 */

import { randomUUID } from "node:crypto";
import {
	JSONRPC_METHOD_NOT_FOUND,
	MCP_PROTOCOL_VERSION,
	MCP_SUPPORTED_PROTOCOL_VERSIONS,
	isNotification,
	isRequest,
	isResponse,
	type JsonRpcId,
	type JsonRpcMessage,
	type JsonRpcRequest,
	type JsonRpcResponse,
} from "./protocol.ts";
import { McpStdioTransport } from "./transport.ts";
import { MCP_LIMITS, McpError, type McpConnectionState, type McpServerConfig } from "./types.ts";

export interface McpClientInfo {
	readonly name: string;
	readonly version: string;
}

export interface RawMcpTool {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: Record<string, unknown>;
}

export interface RawMcpResource {
	readonly uri: string;
	readonly name: string;
	readonly description: string;
	readonly mimeType?: string;
}

export interface RawMcpResourceTemplate {
	readonly uriTemplate: string;
	readonly name: string;
	readonly description: string;
	readonly mimeType?: string;
}

export interface RawMcpContent {
	readonly type: string;
	readonly [key: string]: unknown;
}

export interface RawMcpCallResult {
	readonly content: readonly RawMcpContent[];
	readonly isError: boolean;
}

export interface RawMcpResourceContents {
	readonly contents: readonly Record<string, unknown>[];
}

interface PendingRequest {
	resolve: (result: Record<string, unknown>) => void;
	reject: (error: McpError) => void;
	timer?: ReturnType<typeof setTimeout>;
}

const RECYCLE_GRACE_MS = 2_000;

export class McpConnection {
	readonly config: McpServerConfig;
	private readonly clientInfo: McpClientInfo;
	private readonly workspaceCwd: string;
	private transport?: McpStdioTransport;
	private readonly pending = new Map<JsonRpcId, PendingRequest>();
	private nextId = 1;
	private stateValue: McpConnectionState = "cold";
	private inFlight = 0;
	private readonly waiters: Array<() => void> = [];
	readonly instanceId = randomUUID();
	serverInfo: { name: string; version: string } = { name: "", version: "" };
	negotiatedProtocol = "";
	capabilities: Record<string, unknown> = {};
	/** list_changed notifications only mark catalogs stale; never inject turns. */
	catalogStale = false;
	private lastExit?: { code: number | null; signal: NodeJS.Signals | null };

	constructor(config: McpServerConfig, workspaceCwd: string, clientInfo: McpClientInfo) {
		this.config = config;
		this.workspaceCwd = workspaceCwd;
		this.clientInfo = clientInfo;
	}

	get state(): McpConnectionState {
		return this.stateValue;
	}

	get stderrTail(): string {
		return this.transport?.stderrTail ?? "";
	}

	async start(): Promise<void> {
		if (this.stateValue === "ready" || this.stateValue === "starting") return;
		this.stateValue = "starting";
		const cwd = this.config.cwd === "workspace" ? this.workspaceCwd : this.config.cwd;
		this.transport = McpStdioTransport.start(this.config, cwd, {
			onMessage: (message) => this.handleMessage(message),
			onProtocolError: (error) => this.failAllPending(error),
			onExit: (info) => {
				this.lastExit = info;
				const wasStopping = this.stateValue === "stopping";
				this.stateValue = wasStopping ? "cold" : "crashed";
				this.failAllPending(new McpError(
					"MCP_SERVER_UNAVAILABLE",
					`MCP server exited (${info.signal ?? info.code ?? "unknown"})`,
					this.config.serverId,
				));
			},
		});
		try {
			const result = await this.request(
				"initialize",
				{
					protocolVersion: MCP_PROTOCOL_VERSION,
					capabilities: {},
					clientInfo: { name: this.clientInfo.name, version: this.clientInfo.version },
				},
				this.config.startupTimeoutMs,
			);
			const negotiated = typeof result.protocolVersion === "string" ? result.protocolVersion : "";
			if (!MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(negotiated)) {
				throw new McpError("MCP_UNSUPPORTED", `MCP server negotiated an unsupported protocol revision: ${negotiated || "(missing)"}`, this.config.serverId);
			}
			this.negotiatedProtocol = negotiated;
			const serverInfo = result.serverInfo as { name?: unknown; version?: unknown } | undefined;
			this.serverInfo = {
				name: typeof serverInfo?.name === "string" ? serverInfo.name : "unknown",
				version: typeof serverInfo?.version === "string" ? serverInfo.version : "unknown",
			};
			this.capabilities = (result.capabilities as Record<string, unknown> | undefined) ?? {};
			this.notify("notifications/initialized", {});
			this.stateValue = "ready";
		} catch (error) {
			this.stateValue = "failed";
			await this.stop();
			throw error instanceof McpError
				? error
				: new McpError("MCP_SERVER_UNAVAILABLE", `MCP initialize failed: ${error instanceof Error ? error.message : String(error)}`, this.config.serverId);
		}
	}

	async listTools(): Promise<RawMcpTool[]> {
		if (this.capabilities.tools === undefined) return [];
		const items = await this.paginate("tools/list", "tools");
		this.catalogStale = false;
		return items.flatMap((item) => {
			const name = item.name;
			if (typeof name !== "string" || !name) return [];
			const schema = item.inputSchema;
			return [{
				name,
				description: typeof item.description === "string" ? item.description : "",
				inputSchema: schema && typeof schema === "object" && !Array.isArray(schema)
					? schema as Record<string, unknown>
					: { type: "object" },
			}];
		});
	}

	async listResources(): Promise<RawMcpResource[]> {
		if (this.capabilities.resources === undefined) return [];
		const items = await this.paginate("resources/list", "resources");
		return items.flatMap((item) =>
			typeof item.uri === "string" && item.uri
				? [{
						uri: item.uri,
						name: typeof item.name === "string" ? item.name : item.uri,
						description: typeof item.description === "string" ? item.description : "",
						...(typeof item.mimeType === "string" ? { mimeType: item.mimeType } : {}),
					}]
				: [],
		);
	}

	async listResourceTemplates(): Promise<RawMcpResourceTemplate[]> {
		if (this.capabilities.resources === undefined) return [];
		let items: Record<string, unknown>[];
		try {
			items = await this.paginate("resources/templates/list", "resourceTemplates");
		} catch (error) {
			// Templates are optional server surface; method-not-found is not a failure.
			if (error instanceof McpError && error.code === "MCP_UNSUPPORTED") return [];
			throw error;
		}
		return items.flatMap((item) =>
			typeof item.uriTemplate === "string" && item.uriTemplate
				? [{
						uriTemplate: item.uriTemplate,
						name: typeof item.name === "string" ? item.name : item.uriTemplate,
						description: typeof item.description === "string" ? item.description : "",
						...(typeof item.mimeType === "string" ? { mimeType: item.mimeType } : {}),
					}]
				: [],
		);
	}

	async callTool(name: string, args: Record<string, unknown>, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<RawMcpCallResult> {
		const result = await this.request(
			"tools/call",
			{ name, arguments: args },
			options?.timeoutMs ?? this.config.callTimeoutMs,
			options?.signal,
		);
		const content = Array.isArray(result.content)
			? result.content.filter((part): part is RawMcpContent =>
					Boolean(part) && typeof part === "object" && typeof (part as { type?: unknown }).type === "string")
			: [];
		return { content, isError: result.isError === true };
	}

	async readResource(uri: string, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<RawMcpResourceContents> {
		const result = await this.request(
			"resources/read",
			{ uri },
			options?.timeoutMs ?? this.config.callTimeoutMs,
			options?.signal,
		);
		const contents = Array.isArray(result.contents)
			? result.contents.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
			: [];
		return { contents };
	}

	async stop(): Promise<void> {
		if (this.stateValue !== "crashed" && this.stateValue !== "failed") this.stateValue = "stopping";
		const transport = this.transport;
		this.transport = undefined;
		this.failAllPending(new McpError("MCP_SERVER_RECYCLED", "MCP connection is closing", this.config.serverId));
		await transport?.stop();
		if (this.stateValue === "stopping") this.stateValue = "cold";
	}

	/* ---------------------------------------------------------------- */

	private async paginate(method: string, key: string): Promise<Record<string, unknown>[]> {
		const collected: Record<string, unknown>[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < MCP_LIMITS.maxPagesPerKind; page++) {
			const result = await this.request(method, cursor ? { cursor } : {}, this.config.callTimeoutMs);
			const items = result[key];
			if (Array.isArray(items)) {
				for (const item of items) {
					if (collected.length >= MCP_LIMITS.maxEntriesPerKind) return collected;
					if (item && typeof item === "object" && !Array.isArray(item)) collected.push(item as Record<string, unknown>);
				}
			}
			cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
			if (!cursor) return collected;
		}
		return collected;
	}

	private async acquireSlot(): Promise<void> {
		while (this.inFlight >= MCP_LIMITS.maxConcurrentPerServer) {
			await new Promise<void>((resolve) => this.waiters.push(resolve));
		}
		this.inFlight += 1;
	}

	private releaseSlot(): void {
		this.inFlight -= 1;
		this.waiters.shift()?.();
	}

	private async request(
		method: string,
		params: Record<string, unknown>,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<Record<string, unknown>> {
		if (method !== "initialize" && this.stateValue !== "ready") {
			throw new McpError("MCP_SERVER_UNAVAILABLE", `MCP server is not ready (${this.stateValue})`, this.config.serverId);
		}
		if (signal?.aborted) throw new McpError("MCP_CANCELLED", "MCP request aborted before dispatch", this.config.serverId);
		await this.acquireSlot();
		const id = this.nextId++;
		try {
			return await new Promise<Record<string, unknown>>((resolve, reject) => {
				const settle = (fn: () => void) => {
					const entry = this.pending.get(id);
					if (!entry) return;
					this.pending.delete(id);
					if (entry.timer) clearTimeout(entry.timer);
					signal?.removeEventListener("abort", onAbort);
					fn();
				};
				const cancelThenRecycle = (error: McpError) => {
					// Send MCP cancellation; if the request does not settle within the
					// grace period the whole connection is recycled (docs/31 sec. 7).
					try {
						this.notify("notifications/cancelled", { requestId: id, reason: error.code });
					} catch {
						// Transport already gone; recycle below.
					}
					const grace = setTimeout(() => {
						if (this.pending.has(id)) {
							settle(() => reject(error));
							void this.recycle();
						}
					}, RECYCLE_GRACE_MS);
					grace.unref?.();
				};
				const onAbort = () => cancelThenRecycle(new McpError("MCP_CANCELLED", "MCP request aborted", this.config.serverId));
				const timer = setTimeout(
					() => cancelThenRecycle(new McpError("MCP_TIMEOUT", `MCP ${method} timed out after ${timeoutMs} ms`, this.config.serverId)),
					timeoutMs,
				);
				timer.unref?.();
				this.pending.set(id, {
					resolve: (result) => settle(() => resolve(result)),
					reject: (error) => settle(() => reject(error)),
					timer,
				});
				signal?.addEventListener("abort", onAbort, { once: true });
				try {
					this.transport!.send({ jsonrpc: "2.0", id, method, ...(Object.keys(params).length ? { params } : { params: {} }) });
				} catch (error) {
					settle(() => reject(error instanceof McpError ? error : new McpError("MCP_SERVER_UNAVAILABLE", String(error), this.config.serverId)));
				}
			});
		} finally {
			this.releaseSlot();
		}
	}

	private notify(method: string, params: Record<string, unknown>): void {
		this.transport?.send({ jsonrpc: "2.0", method, params });
	}

	private handleMessage(message: JsonRpcMessage): void {
		if (isResponse(message)) {
			this.handleResponse(message);
			return;
		}
		if (isRequest(message)) {
			// Server-to-client sampling/elicitation/roots/tasks are out of scope:
			// answer with a typed method-not-supported error (docs/31 sec. 7).
			try {
				this.transport?.send({
					jsonrpc: "2.0",
					id: message.id,
					error: { code: JSONRPC_METHOD_NOT_FOUND, message: `MyPi Slice A does not support ${message.method}` },
				});
			} catch {
				// Connection teardown races are fine.
			}
			return;
		}
		if (isNotification(message)) {
			if (message.method === "notifications/tools/list_changed" || message.method === "notifications/resources/list_changed") {
				this.catalogStale = true;
			}
			// Other notifications (progress, logging) are intentionally ignored.
		}
	}

	private handleResponse(message: JsonRpcResponse): void {
		const entry = this.pending.get(message.id);
		if (!entry) return;
		if (message.error) {
			const code = message.error.code === JSONRPC_METHOD_NOT_FOUND ? "MCP_UNSUPPORTED" : "MCP_PROTOCOL_ERROR";
			entry.reject(new McpError(code, `MCP server error ${message.error.code}: ${message.error.message}`.slice(0, 500), this.config.serverId));
			return;
		}
		const result = message.result;
		entry.resolve(result && typeof result === "object" && !Array.isArray(result) ? result : {});
	}

	private failAllPending(error: McpError): void {
		for (const entry of [...this.pending.values()]) entry.reject(error);
		this.pending.clear();
	}

	private async recycle(): Promise<void> {
		const transport = this.transport;
		this.transport = undefined;
		this.stateValue = "failed";
		this.failAllPending(new McpError("MCP_SERVER_RECYCLED", "MCP connection was recycled after an unsettled cancellation", this.config.serverId));
		await transport?.stop();
	}
}
