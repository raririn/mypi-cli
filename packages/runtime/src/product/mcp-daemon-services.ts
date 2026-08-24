import { getAgentDir } from "../config.ts";
import { parseMcpConfig } from "../core/mcp/config.ts";
import { McpManager } from "../core/mcp/manager.ts";
import { redactServerConfig } from "../core/mcp/config.ts";
import { loadGlobalConfig, resolveGlobalConfigPath, updateMcpServer } from "./global-config.ts";
import { probeHttpMcp, suggestServerName, tokenizeCommandLine } from "./mcp-command.ts";

type RecordMap = Record<string, unknown>;

export interface McpWizardInput {
	readonly serverId: string;
	readonly description?: string;
	readonly enabled?: boolean;
	readonly transport: "http" | "stdio";
	readonly target: string;
	readonly authMode?: "none" | "bearer-env" | "oauth";
	readonly bearerEnv?: string;
	readonly oauthClientName?: string;
}

export async function listMcpServerSettings(path = resolveGlobalConfigPath()): Promise<{
	servers: RecordMap[];
	diagnostics: readonly { serverId?: string; message: string }[];
}> {
	const loaded = await loadGlobalConfig(path);
	const parsed = parseMcpConfig(loaded.config.mcp, "global");
	return {
		servers: [...parsed.config.servers.values()].map(redactServerConfig),
		diagnostics: parsed.diagnostics.map((item) => ({ ...(item.serverId ? { serverId: item.serverId } : {}), message: item.message.slice(0, 500) })),
	};
}

export async function probeMcpWizardTarget(target: string): Promise<RecordMap> {
	const trimmed = target.trim();
	if (!trimmed) throw new Error("MCP target is required.");
	if (/^https?:\/\//u.test(trimmed)) return { transport: "http", suggestedId: suggestServerName(trimmed), ...(await probeHttpMcp(trimmed)) };
	const argv = tokenizeCommandLine(trimmed);
	if (!argv.length) throw new Error("MCP command line is empty or invalid.");
	return { transport: "stdio", suggestedId: suggestServerName(trimmed), command: argv[0], argCount: argv.length - 1, status: "ready" };
}

export async function saveMcpWizardServer(input: McpWizardInput, path = resolveGlobalConfigPath()): Promise<Awaited<ReturnType<typeof listMcpServerSettings>>> {
	const target = input.target.trim();
	let record: RecordMap;
	if (input.transport === "http") {
		record = {
			transport: "http",
			url: target,
			...(input.authMode === "bearer-env" ? { authBearerEnv: input.bearerEnv?.trim() } : {}),
			...(input.authMode === "oauth" ? { oauth: { clientName: input.oauthClientName?.trim() || "MyPi" } } : {}),
		};
	} else {
		const argv = tokenizeCommandLine(target);
		if (!argv.length) throw new Error("MCP command line is empty or invalid.");
		record = { transport: "stdio", command: argv[0], args: argv.slice(1) };
	}
	record.enabled = input.enabled !== false;
	if (input.description?.trim()) record.description = input.description.trim();
	const parsed = parseMcpConfig({ servers: { [input.serverId]: record } }, "global");
	if (!parsed.config.servers.has(input.serverId)) throw new Error(parsed.diagnostics[0]?.message ?? "Invalid MCP server configuration.");
	await updateMcpServer(input.serverId, record, path);
	return listMcpServerSettings(path);
}

export async function setMcpWizardServerEnabled(serverId: string, enabled: boolean, path = resolveGlobalConfigPath()): Promise<Awaited<ReturnType<typeof listMcpServerSettings>>> {
	const record = await rawServerRecord(serverId, path);
	await updateMcpServer(serverId, { ...record, enabled }, path);
	return listMcpServerSettings(path);
}

export async function removeMcpWizardServer(serverId: string, path = resolveGlobalConfigPath()): Promise<Awaited<ReturnType<typeof listMcpServerSettings>>> {
	await rawServerRecord(serverId, path);
	await updateMcpServer(serverId, undefined, path);
	return listMcpServerSettings(path);
}

export async function testMcpWizardServer(serverId: string, options: { path?: string; workspaceCwd?: string; agentDir?: string } = {}): Promise<RecordMap> {
	const path = options.path ?? resolveGlobalConfigPath();
	const loaded = await loadGlobalConfig(path);
	const parsed = parseMcpConfig(loaded.config.mcp, "global");
	const server = parsed.config.servers.get(serverId);
	if (!server) throw new Error(`Unknown MCP server: ${serverId}`);
	const manager = new McpManager({ servers: new Map([[serverId, server]]) }, {
		workspaceCwd: options.workspaceCwd ?? process.cwd(),
		agentDir: options.agentDir ?? getAgentDir(),
		clientInfo: { name: "MyPi Settings", version: "1.0" },
		policyState: () => ({ safetyMode: "full", planning: false, projectTrusted: true }),
		approve: async () => true,
	});
	try {
		const result = await manager.search({ server: serverId, kind: "all", limit: 20 });
		return { status: "ready", records: result.records };
	} finally {
		await manager.shutdown();
	}
}

async function rawServerRecord(serverId: string, path: string): Promise<RecordMap> {
	const loaded = await loadGlobalConfig(path);
	const mcp = isRecord(loaded.config.mcp) ? loaded.config.mcp : {};
	const servers = isRecord(mcp.servers) ? mcp.servers : {};
	const record = servers[serverId];
	if (!isRecord(record)) throw new Error(`Unknown MCP server: ${serverId}`);
	return { ...record };
}

function isRecord(value: unknown): value is RecordMap {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
