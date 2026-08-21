/**
 * Streamable HTTP transport (FEAT-067 Slice B): each JSON-RPC message is an
 * HTTP POST; responses arrive as `application/json` or `text/event-stream`
 * bodies. Bearer authentication uses either configured env-var indirection or
 * the OAuth 2.1 provider; a 401 triggers exactly one acquisition/refresh and
 * one replay of the failed message.
 */

import { MCP_LIMITS, McpError, type McpServerConfig } from "./types.ts";
import type { JsonRpcMessage } from "./protocol.ts";
import { JsonRpcReader } from "./protocol.ts";
import type { McpOAuthProvider } from "./oauth.ts";
import type { McpTransport, McpTransportEvents } from "./transport.ts";

const HTTP_REQUEST_TIMEOUT_MS = 5 * 60_000;

export interface McpHttpTransportOptions {
	readonly oauth?: McpOAuthProvider;
}

export class McpHttpTransport implements McpTransport {
	private readonly config: McpServerConfig;
	private readonly events: McpTransportEvents;
	private readonly oauth?: McpOAuthProvider;
	private readonly url: string;
	private sessionId?: string;
	private closed = false;
	private inFlight = 0;
	private authFlight?: Promise<string>;

	constructor(config: McpServerConfig, events: McpTransportEvents, options: McpHttpTransportOptions = {}) {
		if (!config.url) throw new McpError("MCP_CONFIG_INVALID", "http transport requires a url", config.serverId);
		this.config = config;
		this.events = events;
		this.oauth = options.oauth;
		this.url = config.url;
	}

	get alive(): boolean {
		return !this.closed;
	}

	get stderrTail(): string {
		return "";
	}

	get pid(): undefined {
		return undefined;
	}

	send(message: JsonRpcMessage): void {
		if (this.closed) throw new McpError("MCP_SERVER_UNAVAILABLE", "MCP HTTP transport is closed", this.config.serverId);
		this.inFlight += 1;
		void this.post(message, true)
			.catch((error) => {
				// Requests surface failures as JSON-RPC errors so the connection's
				// pending-request map settles them; notification failures are silent.
				const id = (message as { id?: unknown }).id;
				if (id !== undefined && (typeof id === "string" || typeof id === "number")) {
					this.events.onMessage({
						jsonrpc: "2.0",
						id,
						error: {
							code: -32000,
							message: error instanceof Error ? error.message : String(error),
							// Preserve the typed MyPi error across the transport boundary.
							...(error instanceof McpError ? { data: { mypiCode: error.code } } : {}),
						},
					});
				}
			})
			.finally(() => {
				this.inFlight -= 1;
			});
	}

	async stop(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		if (this.sessionId) {
			// Best-effort session teardown per the Streamable HTTP spec.
			void fetch(this.url, {
				method: "DELETE",
				headers: { "mcp-session-id": this.sessionId },
				signal: AbortSignal.timeout(5_000),
			}).catch(() => undefined);
		}
		this.events.onExit({ code: 0, signal: null });
	}

	/* ---------------------------------------------------------------- */

	private async bearerToken(interactive: boolean, challenge?: string): Promise<string | undefined> {
		if (this.config.authBearerEnv) {
			const token = process.env[this.config.authBearerEnv];
			if (!token) {
				throw new McpError(
					"MCP_AUTH_REQUIRED",
					`bearer variable ${this.config.authBearerEnv} is not set on this host`,
					this.config.serverId,
				);
			}
			return token;
		}
		if (!this.oauth) return undefined;
		if (!interactive) return this.oauth.cachedToken();
		this.authFlight ??= this.oauth.acquireToken(challenge).finally(() => {
			this.authFlight = undefined;
		});
		return this.authFlight;
	}

	private async post(message: JsonRpcMessage, allowAuthRetry: boolean): Promise<void> {
		const token = await this.bearerToken(false);
		const response = await fetch(this.url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
				...(token ? { authorization: `Bearer ${token}` } : {}),
			},
			body: JSON.stringify(message),
			signal: AbortSignal.timeout(HTTP_REQUEST_TIMEOUT_MS),
		});
		const newSession = response.headers.get("mcp-session-id");
		if (newSession) this.sessionId = newSession;

		if (response.status === 401 || response.status === 403) {
			await response.body?.cancel().catch(() => undefined);
			if (!allowAuthRetry || (!this.oauth && !this.config.authBearerEnv)) {
				throw new McpError("MCP_AUTH_REQUIRED", `MCP server rejected authentication (HTTP ${response.status})`, this.config.serverId);
			}
			if (this.config.authBearerEnv) {
				throw new McpError("MCP_AUTH_FAILED", `bearer token from ${this.config.authBearerEnv} was rejected (HTTP ${response.status})`, this.config.serverId);
			}
			const challenge = response.headers.get("www-authenticate") ?? undefined;
			const acquired = await this.bearerToken(true, challenge);
			if (!acquired) throw new McpError("MCP_AUTH_REQUIRED", "OAuth acquisition returned no token", this.config.serverId);
			await this.postWithToken(message, acquired);
			return;
		}
		await this.consume(response, message);
	}

	private async postWithToken(message: JsonRpcMessage, token: string): Promise<void> {
		const response = await fetch(this.url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify(message),
			signal: AbortSignal.timeout(HTTP_REQUEST_TIMEOUT_MS),
		});
		const newSession = response.headers.get("mcp-session-id");
		if (newSession) this.sessionId = newSession;
		if (response.status === 401 || response.status === 403) {
			await response.body?.cancel().catch(() => undefined);
			throw new McpError("MCP_AUTH_FAILED", `MCP server rejected the freshly acquired token (HTTP ${response.status})`, this.config.serverId);
		}
		await this.consume(response, message);
	}

	private async consume(response: Response, message: JsonRpcMessage): Promise<void> {
		const isNotification = (message as { id?: unknown }).id === undefined;
		if (response.status === 202 || response.status === 204) {
			await response.body?.cancel().catch(() => undefined);
			return;
		}
		if (!response.ok) {
			await response.body?.cancel().catch(() => undefined);
			throw new McpError("MCP_SERVER_UNAVAILABLE", `MCP HTTP request failed (HTTP ${response.status})`, this.config.serverId);
		}
		if (isNotification) {
			await response.body?.cancel().catch(() => undefined);
			return;
		}
		const contentType = response.headers.get("content-type") ?? "";
		const body = await this.boundedBody(response);
		if (contentType.includes("text/event-stream")) {
			const reader = new JsonRpcReader(this.config.serverId);
			for (const block of body.split("\n\n")) {
				const data = block
					.split("\n")
					.filter((line) => line.startsWith("data:"))
					.map((line) => line.slice(5).trim())
					.join("");
				if (!data) continue;
				for (const parsed of reader.push(`${data}\n`)) this.events.onMessage(parsed);
			}
			return;
		}
		const trimmed = body.trim();
		if (!trimmed) return;
		const reader = new JsonRpcReader(this.config.serverId);
		for (const parsed of reader.push(`${trimmed.replace(/\n/gu, " ")}\n`)) this.events.onMessage(parsed);
	}

	private async boundedBody(response: Response): Promise<string> {
		const text = await response.text();
		if (Buffer.byteLength(text, "utf8") > MCP_LIMITS.maxBufferedBytes) {
			throw new McpError("MCP_LIMIT_EXCEEDED", "MCP HTTP response exceeds the 8 MiB bound", this.config.serverId);
		}
		return text;
	}
}
