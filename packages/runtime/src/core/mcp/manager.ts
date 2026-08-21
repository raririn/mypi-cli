/**
 * Session-owned MCP manager: lazy server lifecycle, bounded catalogs, the
 * three gateway operations, loaded definitions, and policy-gated calls
 * (docs/31 sections 2, 4, 5, and 6).
 */

import { McpConnection, type McpClientInfo, type RawMcpTool } from "./connection.ts";
import { McpOAuthProvider } from "./oauth.ts";
import { evaluateMcpAction, classifyTool, resourceRuleAllows, toolRuleAllows, type McpPolicyState } from "./policy.ts";
import { convertCallResult, redactMcpText, untrustedFrame, type ConvertedMcpResult } from "./result.ts";
import { catalogFingerprint, exposedToolName, normalizeToolSchema, schemaFingerprint } from "./schema.ts";
import { McpProcessSupervisor } from "./process-supervisor.ts";
import {
	MCP_LIMITS,
	McpError,
	type McpConfig,
	type McpExcludedTool,
	type McpResourceDescriptor,
	type McpResourceTemplateDescriptor,
	type McpServerConfig,
	type McpToolDescriptor,
} from "./types.ts";

const SECRET_ARGUMENT_PATTERN =
	/(?:\b(?:sk|rk|pk|ghp|gho|xox[baprs])-[A-Za-z0-9_-]{16,}|-----BEGIN [^-]+ PRIVATE KEY-----|\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.)/u;

interface ServerCatalog {
	readonly tools: McpToolDescriptor[];
	readonly excluded: McpExcludedTool[];
	readonly resources: McpResourceDescriptor[];
	readonly templates: McpResourceTemplateDescriptor[];
	readonly revision: string;
	readonly instanceId: string;
}

interface LoadedTool {
	readonly descriptor: McpToolDescriptor;
	readonly loadInstanceId: string;
}

export interface McpSearchRecord {
	readonly kind: "server" | "tool" | "resource" | "template";
	readonly serverId: string;
	readonly name: string;
	readonly description: string;
	readonly detail?: string;
}

export interface McpSearchResult {
	readonly records: readonly McpSearchRecord[];
	readonly cursor?: string;
}

export interface McpManagerOptions {
	readonly workspaceCwd: string;
	readonly agentDir?: string;
	readonly clientInfo: McpClientInfo;
	readonly policyState: () => McpPolicyState;
	/** Absent approval capability fails closed for approval-requiring modes. */
	readonly approve?: (summary: string) => Promise<boolean>;
	/** Present an OAuth authorization URL; absent capability fails closed. */
	readonly authorize?: (url: string) => Promise<void>;
	/** Exposed names that already exist (built-in/SDK/extension tools). */
	readonly takenToolNames?: () => ReadonlySet<string>;
	readonly onLoadedToolsChanged?: () => void;
}

export class McpManager {
	private readonly config: McpConfig;
	private readonly options: McpManagerOptions;
	private readonly connections = new Map<string, McpConnection>();
	private readonly catalogs = new Map<string, ServerCatalog>();
	private readonly loaded = new Map<string, LoadedTool>();
	private readonly startApprovals = new Set<string>();
	private readonly leases = new Map<string, string>();
	private readonly supervisor?: McpProcessSupervisor;
	private sessionInFlight = 0;
	private degraded?: string;
	private shuttingDown = false;

	constructor(config: McpConfig, options: McpManagerOptions) {
		this.config = config;
		this.options = options;
		if (options.agentDir) this.supervisor = new McpProcessSupervisor(options.agentDir);
	}

	get hasConfiguredServers(): boolean {
		return [...this.config.servers.values()].some((server) => server.enabled);
	}

	loadedTools(): McpToolDescriptor[] {
		return [...this.loaded.values()].map((entry) => entry.descriptor);
	}

	/**
	 * Reconstruct loaded definitions from persisted load snapshots without
	 * starting servers. The empty load-instance marker forces a live schema
	 * fingerprint comparison before the first call executes.
	 */
	restoreLoaded(descriptors: readonly McpToolDescriptor[]): McpToolDescriptor[] {
		const restored: McpToolDescriptor[] = [];
		for (const descriptor of descriptors) {
			if (!this.config.servers.get(descriptor.serverId)) continue;
			if (this.loaded.has(descriptor.exposedName)) continue;
			if (this.options.takenToolNames?.().has(descriptor.exposedName)) continue;
			if (this.loaded.size >= MCP_LIMITS.maxActiveTools) break;
			this.loaded.set(descriptor.exposedName, { descriptor, loadInstanceId: "" });
			restored.push(descriptor);
		}
		if (restored.length) this.options.onLoadedToolsChanged?.();
		return restored;
	}

	/** Drop loaded definitions (branch navigation before their load). */
	clearLoaded(): void {
		if (!this.loaded.size) return;
		this.loaded.clear();
		this.options.onLoadedToolsChanged?.();
	}

	/** Startup preflight: initialize and collect catalogs for required servers. */
	async startRequired(): Promise<void> {
		await this.supervisor?.pruneStale().catch(() => 0);
		for (const server of this.config.servers.values()) {
			if (!server.enabled || !server.required) continue;
			try {
				await this.ensureCatalog(server, { preflight: true });
			} catch (error) {
				this.degraded = `required MCP server ${server.serverId} failed: ${error instanceof Error ? error.message : String(error)}`;
				throw error instanceof McpError ? error : new McpError("MCP_SERVER_UNAVAILABLE", this.degraded, server.serverId);
			}
		}
	}

	async search(params: {
		query?: string;
		server?: string;
		kind?: "tool" | "resource" | "template" | "all";
		limit?: number;
		cursor?: string;
	}): Promise<McpSearchResult> {
		const limit = Math.min(Math.max(params.limit ?? MCP_LIMITS.searchDefaultLimit, 1), MCP_LIMITS.searchMaxLimit);
		const query = (params.query ?? "").trim().toLowerCase();
		const records: McpSearchRecord[] = [];
		if (!params.server) {
			// Static search only: configured IDs/descriptions, no process starts.
			for (const server of this.config.servers.values()) {
				if (query && !`${server.serverId} ${server.description}`.toLowerCase().includes(query)) continue;
				records.push({
					kind: "server",
					serverId: server.serverId,
					name: server.serverId,
					description: server.description || "(no description)",
					detail: server.enabled ? `scope=${server.configScope}` : "disabled",
				});
			}
			return pageRecords(records, limit, params.cursor);
		}
		const server = this.requireServer(params.server);
		const catalog = await this.ensureCatalog(server, {});
		const kind = params.kind ?? "all";
		if (kind === "tool" || kind === "all") {
			for (const tool of catalog.tools) {
				if (query && !`${tool.remoteName} ${tool.description}`.toLowerCase().includes(query)) continue;
				records.push({
					kind: "tool",
					serverId: server.serverId,
					name: tool.remoteName,
					description: redactMcpText(tool.description).slice(0, 300),
					detail: `effect=${tool.effect}`,
				});
			}
		}
		if (kind === "resource" || kind === "all") {
			for (const resource of catalog.resources) {
				if (query && !`${resource.uri} ${resource.name} ${resource.description}`.toLowerCase().includes(query)) continue;
				records.push({
					kind: "resource",
					serverId: server.serverId,
					name: resource.uri,
					description: redactMcpText(`${resource.name} ${resource.description}`.trim()).slice(0, 300),
					...(resource.mimeType ? { detail: resource.mimeType } : {}),
				});
			}
		}
		if (kind === "template" || kind === "all") {
			for (const template of catalog.templates) {
				if (query && !`${template.uriTemplate} ${template.name}`.toLowerCase().includes(query)) continue;
				records.push({
					kind: "template",
					serverId: server.serverId,
					name: template.uriTemplate,
					description: redactMcpText(`${template.name} ${template.description}`.trim()).slice(0, 300),
				});
			}
		}
		return pageRecords(records, limit, params.cursor);
	}

	async load(params: { server: string; tools: string[]; refresh?: boolean }): Promise<McpToolDescriptor[]> {
		if (params.tools.length < 1 || params.tools.length > MCP_LIMITS.maxLoadTools) {
			throw new McpError("MCP_LIMIT_EXCEEDED", `mcp_load accepts 1-${MCP_LIMITS.maxLoadTools} exact remote tool names`);
		}
		const server = this.requireServer(params.server);
		const catalog = await this.ensureCatalog(server, { refresh: params.refresh === true });
		const loadedNow: McpToolDescriptor[] = [];
		for (const remoteName of params.tools) {
			const descriptor = catalog.tools.find((tool) => tool.remoteName === remoteName);
			if (!descriptor) {
				const excluded = catalog.excluded.find((entry) => entry.remoteName === remoteName);
				if (excluded) throw new McpError("MCP_TOOL_EXCLUDED", `MCP tool ${remoteName} was excluded: ${excluded.reason}`, server.serverId);
				throw new McpError("MCP_TOOL_UNKNOWN", `MCP server ${server.serverId} does not advertise a tool named ${remoteName}`, server.serverId);
			}
			const existing = this.loaded.get(descriptor.exposedName);
			if (existing && !params.refresh && existing.descriptor.schemaFingerprint !== descriptor.schemaFingerprint) {
				throw new McpError("MCP_TOOL_CHANGED", `MCP tool ${remoteName} changed since it was loaded; call mcp_load with refresh: true`, server.serverId);
			}
			if (!existing && this.options.takenToolNames?.().has(descriptor.exposedName)) {
				throw new McpError("MCP_NAME_COLLISION", `exposed name ${descriptor.exposedName} collides with an existing tool; MCP never overrides another definition`, server.serverId);
			}
			this.loaded.set(descriptor.exposedName, { descriptor, loadInstanceId: catalog.instanceId });
			loadedNow.push(descriptor);
		}
		this.assertActiveBounds();
		this.options.onLoadedToolsChanged?.();
		return loadedNow;
	}

	async readResource(params: { server: string; uri: string }, signal?: AbortSignal): Promise<ConvertedMcpResult> {
		const server = this.requireServer(params.server);
		const catalog = await this.ensureCatalog(server, {});
		const cataloged = catalog.resources.some((resource) => resource.uri === params.uri)
			|| catalog.templates.some((template) => templateMatches(template.uriTemplate, params.uri));
		if (!cataloged) throw new McpError("MCP_RESOURCE_BLOCKED", "URI must match a cataloged resource or resource template", server.serverId);
		if (!resourceRuleAllows(server, params.uri)) {
			throw new McpError("MCP_RESOURCE_BLOCKED", `configured resource rules block ${params.uri}`, server.serverId);
		}
		await this.gate("read-resource", server, undefined, `Read MCP resource ${params.uri} from ${server.serverId}`);
		const connection = await this.ensureConnection(server);
		const result = await this.withSessionSlot(() => connection.readResource(params.uri, { signal }));
		const parts = result.contents.flatMap((entry) => {
			if (typeof entry.text === "string") return [{ type: "text", text: entry.text } as const];
			return [];
		});
		return convertCallResult(server.serverId, `resource:${params.uri}`, parts, false);
	}

	async callTool(exposedName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ConvertedMcpResult> {
		const entry = this.loaded.get(exposedName);
		if (!entry) throw new McpError("MCP_TOOL_UNKNOWN", `no loaded MCP tool is named ${exposedName}`);
		const descriptor = entry.descriptor;
		const server = this.requireServer(descriptor.serverId);
		if (SECRET_ARGUMENT_PATTERN.test(JSON.stringify(args))) {
			throw new McpError("MCP_CREDENTIAL_BLOCKED", "call arguments contain a high-confidence credential value; pass credentials through passEnv instead", server.serverId);
		}
		await this.gate("call", server, descriptor, `Call MCP tool ${descriptor.remoteName} (${descriptor.effect}) on ${server.serverId}`);
		const catalog = await this.ensureCatalog(server, {});
		if (catalog.instanceId !== entry.loadInstanceId) {
			// Reconnected since load: compare the live schema before executing.
			const live = catalog.tools.find((tool) => tool.remoteName === descriptor.remoteName);
			if (!live || live.schemaFingerprint !== descriptor.schemaFingerprint) {
				throw new McpError("MCP_TOOL_CHANGED", `MCP tool ${descriptor.remoteName} changed since it was loaded; call mcp_load with refresh: true`, server.serverId);
			}
			this.loaded.set(exposedName, { descriptor, loadInstanceId: catalog.instanceId });
		}
		const connection = await this.ensureConnection(server);
		const raw = await this.withSessionSlot(() => connection.callTool(descriptor.remoteName, args, { signal }));
		return convertCallResult(server.serverId, descriptor.remoteName, raw.content, raw.isError);
	}

	status(): Array<Record<string, unknown>> {
		return [...this.config.servers.values()].map((server) => {
			const connection = this.connections.get(server.serverId);
			const catalog = this.catalogs.get(server.serverId);
			return {
				serverId: server.serverId,
				scope: server.configScope,
				enabled: server.enabled,
				required: server.required,
				state: connection?.state ?? "cold",
				tools: catalog?.tools.length ?? 0,
				resources: catalog?.resources.length ?? 0,
				catalogRevision: catalog?.revision,
				...(this.degraded ? { degraded: this.degraded } : {}),
			};
		});
	}

	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		const connections = [...this.connections.values()];
		this.connections.clear();
		await Promise.all(connections.map((connection) => connection.stop().catch(() => undefined)));
		for (const [serverId, leaseId] of this.leases) {
			await this.supervisor?.removeLease(leaseId).catch(() => undefined);
			this.leases.delete(serverId);
		}
	}

	/* ---------------------------------------------------------------- */

	private requireServer(serverId: string): McpServerConfig {
		const server = this.config.servers.get(serverId);
		if (!server) throw new McpError("MCP_SERVER_UNKNOWN", `no configured MCP server is named ${serverId}`);
		if (!server.enabled) throw new McpError("MCP_SERVER_DISABLED", `MCP server ${serverId} is disabled`, serverId);
		return server;
	}

	private async gate(
		kind: "start" | "call" | "read-resource",
		server: McpServerConfig,
		descriptor: McpToolDescriptor | undefined,
		summary: string,
	): Promise<void> {
		if (this.degraded) throw new McpError("MCP_SERVER_UNAVAILABLE", `MCP is degraded until reload: ${this.degraded}`, server.serverId);
		const decision = evaluateMcpAction(
			kind,
			server,
			this.options.policyState(),
			descriptor ? { remoteName: descriptor.remoteName, effect: descriptor.effect, allowInPlan: descriptor.allowInPlan } : undefined,
		);
		if (!decision.allow) throw new McpError("MCP_POLICY_BLOCKED", decision.reason ?? "MCP policy blocked this action", server.serverId);
		if (!decision.requireApproval) return;
		if (kind === "start" && this.startApprovals.has(server.serverId)) return;
		if (!this.options.approve) {
			throw new McpError("MCP_APPROVAL_REQUIRED", `${summary} requires approval, and this surface cannot ask`, server.serverId);
		}
		const approved = await this.options.approve(
			`${summary}. This MCP server executes outside the Bash sandbox on this execution host.`,
		);
		if (!approved) throw new McpError("MCP_APPROVAL_REQUIRED", `${summary} was not approved`, server.serverId);
		if (kind === "start") this.startApprovals.add(server.serverId);
	}

	private async ensureConnection(server: McpServerConfig): Promise<McpConnection> {
		if (this.shuttingDown) throw new McpError("MCP_SERVER_UNAVAILABLE", "MCP manager is shutting down", server.serverId);
		let connection = this.connections.get(server.serverId);
		if (connection && (connection.state === "ready" || connection.state === "starting")) return connection;
		if (connection) {
			// One explicit restart of an optional/crashed server; no call replay.
			await connection.stop().catch(() => undefined);
			this.connections.delete(server.serverId);
			this.catalogs.delete(server.serverId);
		}
		await this.gate(
			"start",
			server,
			undefined,
			`Start MCP server ${server.serverId} (${server.transport === "http" ? server.url : server.command})`,
		);
		const oauth = server.transport === "http" && server.oauth && server.url && this.options.agentDir
			? new McpOAuthProvider({
					agentDir: this.options.agentDir,
					serverId: server.serverId,
					serverUrl: server.url,
					config: server.oauth,
					...(this.options.authorize ? { authorize: this.options.authorize } : {}),
				})
			: undefined;
		if (oauth) {
			// Interactive OAuth must complete before initialize so the browser
			// round-trip runs under the authorization budget, never the short
			// connection startup timeout (BUG: initialize timed out mid sign-in).
			await oauth.preflight();
		}
		connection = new McpConnection(server, this.options.workspaceCwd, this.options.clientInfo, oauth ? { oauth } : undefined);
		this.connections.set(server.serverId, connection);
		await connection.start();
		if (this.supervisor && server.transport === "stdio") {
			const pid = connection.serverPid;
			// Lease bookkeeping is best-effort; connection teardown remains exact.
			if (typeof pid === "number") {
				this.leases.set(server.serverId, await this.supervisor.writeLease(server.serverId, pid).catch(() => ""));
			}
		}
		return connection;
	}

	private async ensureCatalog(server: McpServerConfig, options: { refresh?: boolean; preflight?: boolean }): Promise<ServerCatalog> {
		const connection = await this.ensureConnection(server);
		const cached = this.catalogs.get(server.serverId);
		if (cached && cached.instanceId === connection.instanceId && !options.refresh && !connection.catalogStale) return cached;
		const [rawTools, resources, templates] = await Promise.all([
			connection.listTools(),
			connection.listResources(),
			connection.listResourceTemplates(),
		]);
		const tools: McpToolDescriptor[] = [];
		const excluded: McpExcludedTool[] = [];
		const seen = new Set<string>();
		for (const raw of rawTools) {
			const admitted = this.admitTool(server, raw, seen);
			if ("reason" in admitted) excluded.push({ serverId: server.serverId, remoteName: raw.name, reason: admitted.reason });
			else tools.push(admitted.descriptor);
		}
		const catalog: ServerCatalog = {
			tools,
			excluded,
			resources: resources.map((resource) => ({ serverId: server.serverId, ...resource })),
			templates: templates.map((template) => ({ serverId: server.serverId, ...template })),
			revision: catalogFingerprint([rawTools, resources, templates]),
			instanceId: connection.instanceId,
		};
		this.catalogs.set(server.serverId, catalog);
		return catalog;
	}

	private admitTool(
		server: McpServerConfig,
		raw: RawMcpTool,
		seen: Set<string>,
	): { descriptor: McpToolDescriptor } | { reason: string } {
		if (!toolRuleAllows(server, raw.name)) return { reason: "configured allow/deny rules exclude this tool" };
		const normalized = normalizeToolSchema(raw.inputSchema);
		if (!normalized.ok || !normalized.schema) return { reason: normalized.reason ?? "schema rejected" };
		const exposedName = exposedToolName(server.serverId, raw.name);
		if (seen.has(exposedName)) return { reason: "exposed-name collision inside this server catalog" };
		seen.add(exposedName);
		const policy = classifyTool(server, raw.name);
		return {
			descriptor: {
				serverId: server.serverId,
				remoteName: raw.name,
				exposedName,
				description: `[MCP ${server.serverId}; untrusted external description] ${redactMcpText(raw.description)}`.slice(0, 1_024),
				inputSchema: normalized.schema,
				schemaFingerprint: schemaFingerprint(normalized.schema),
				effect: policy.effect,
				allowInPlan: policy.allowInPlan,
			},
		};
	}

	private assertActiveBounds(): void {
		if (this.loaded.size > MCP_LIMITS.maxActiveTools) {
			throw new McpError("MCP_LIMIT_EXCEEDED", `at most ${MCP_LIMITS.maxActiveTools} MCP tools may be active in one session`);
		}
		const bytes = [...this.loaded.values()]
			.reduce((total, entry) => total + Buffer.byteLength(JSON.stringify(entry.descriptor.inputSchema), "utf8"), 0);
		if (bytes > MCP_LIMITS.maxActiveSchemaBytes) {
			throw new McpError("MCP_LIMIT_EXCEEDED", "combined active MCP schemas exceed 512 KiB");
		}
	}

	private async withSessionSlot<T>(operation: () => Promise<T>): Promise<T> {
		if (this.sessionInFlight >= MCP_LIMITS.maxConcurrentPerSession) {
			throw new McpError("MCP_LIMIT_EXCEEDED", `at most ${MCP_LIMITS.maxConcurrentPerSession} concurrent MCP requests per session`);
		}
		this.sessionInFlight += 1;
		try {
			return await operation();
		} finally {
			this.sessionInFlight -= 1;
		}
	}
}

export { untrustedFrame };

function pageRecords(records: McpSearchRecord[], limit: number, cursor?: string): McpSearchResult {
	let offset = 0;
	if (cursor) {
		const parsed = Number.parseInt(Buffer.from(cursor, "base64url").toString("utf8"), 10);
		if (Number.isSafeInteger(parsed) && parsed >= 0) offset = parsed;
	}
	const page = records.slice(offset, offset + limit);
	const next = offset + limit < records.length
		? Buffer.from(String(offset + limit), "utf8").toString("base64url")
		: undefined;
	return { records: page, ...(next ? { cursor: next } : {}) };
}

/** RFC 6570 level-1 template match for cataloged resource templates. */
function templateMatches(template: string, uri: string): boolean {
	const pattern = template
		.split(/(\{[^}]+\})/u)
		.map((part) => (part.startsWith("{") && part.endsWith("}") ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")))
		.join("");
	try {
		return new RegExp(`^${pattern}$`, "u").test(uri);
	} catch {
		return false;
	}
}
