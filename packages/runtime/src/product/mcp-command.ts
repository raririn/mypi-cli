/**
 * `/mcp` — user-facing MCP server management with a setup wizard, so adding a
 * server never requires hand-editing YAML. A URL is probed to detect the
 * transport and authentication requirement; a command line configures a STDIO
 * server. Records persist atomically into the global `config.yaml` `mcp`
 * section and the live session reloads immediately.
 */

import type { ExtensionAPI, ExtensionContext } from "../core/extensions/types.ts";
import { parseMcpConfig } from "../core/mcp/config.ts";
import { MCP_SERVER_ID_PATTERN, McpError } from "../core/mcp/types.ts";
import { loadGlobalConfig, updateMcpServer } from "./global-config.ts";
import type { McpProductRuntime } from "./mcp.ts";

const MCP_HELP = `# /mcp — manage MCP servers

/mcp                      List configured servers and live status
/mcp add                  Interactive wizard (URL or command line)
/mcp add <url|command>    Wizard with the target prefilled
/mcp add <name> <target>  Direct add; URLs are probed for auth automatically
/mcp remove <name>        Remove one server (asks for confirmation)
/mcp enable <name>        Enable a disabled server
/mcp disable <name>       Disable without removing configuration
/mcp test <name>          Connect and list the live tool catalog

URLs become Streamable HTTP servers (https, or http on localhost). The wizard
probes the endpoint: open endpoints need no auth, 401-challenged endpoints
offer OAuth (browser sign-in) or a bearer token read from an environment
variable you name; token literals are never stored in settings. Anything else
is treated as a STDIO command line (argv, no shell). Advanced fields
(toolPolicy effect classification, allow/deny lists, timeouts, required
startup) remain editable in ~/.mypi/agent/config.yaml under mcp.servers.`;

export interface McpProbeResult {
	readonly status: "open" | "auth" | "unreachable";
	readonly serverName?: string;
	readonly detail?: string;
}

/** Probe a Streamable HTTP endpoint with one anonymous initialize request. */
export async function probeHttpMcp(url: string, fetcher: typeof fetch = fetch): Promise<McpProbeResult> {
	try {
		const response = await fetcher(url, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "MyPi", version: "1.0" } },
			}),
			signal: AbortSignal.timeout(10_000),
		});
		if (response.status === 401 || response.status === 403) {
			await response.body?.cancel().catch(() => undefined);
			return { status: "auth" };
		}
		const body = await response.text();
		if (!response.ok) return { status: "unreachable", detail: `HTTP ${response.status}` };
		const data = body.includes("data:")
			? body.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5)).join("")
			: body;
		try {
			const parsed = JSON.parse(data) as { result?: { serverInfo?: { name?: string } } };
			return { status: "open", serverName: parsed.result?.serverInfo?.name };
		} catch {
			return { status: "open" };
		}
	} catch (error) {
		return { status: "unreachable", detail: error instanceof Error ? error.message : String(error) };
	}
}

/** Split a command line into argv honoring single/double quotes; no shell semantics. */
export function tokenizeCommandLine(line: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	let seen = false;
	for (const character of line) {
		if (quote) {
			if (character === quote) quote = undefined;
			else current += character;
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
			seen = true;
			continue;
		}
		if (/\s/u.test(character)) {
			if (current || seen) tokens.push(current);
			current = "";
			seen = false;
			continue;
		}
		current += character;
	}
	if (current || seen) tokens.push(current);
	return tokens;
}

/** Derive a valid server ID suggestion from a URL host or executable name. */
export function suggestServerName(target: string): string {
	let base = target;
	try {
		if (/^https?:\/\//u.test(target)) base = new URL(target).hostname.replace(/^www\./u, "").split(".")[0] ?? "server";
		else base = (tokenizeCommandLine(target)[0] ?? "server").split(/[\\/]/u).at(-1) ?? "server";
	} catch {
		base = "server";
	}
	const cleaned = base.toLowerCase().replace(/^mcp-server-|^server-|^mcp-/u, "").replace(/[^a-z0-9_-]+/gu, "-").replace(/^[-_]+|[-_]+$/gu, "");
	const named = cleaned && /^[a-z]/u.test(cleaned) ? cleaned : `mcp-${cleaned || "server"}`;
	return named.slice(0, 32).replace(/[-_]+$/u, "") || "server";
}

async function validateRecord(serverId: string, record: Record<string, unknown>): Promise<string | undefined> {
	const parsed = parseMcpConfig({ servers: { [serverId]: record } }, "global");
	if (parsed.config.servers.size === 1) return undefined;
	return parsed.diagnostics[0]?.message ?? "invalid server record";
}

async function configuredServerIds(): Promise<string[]> {
	const loaded = await loadGlobalConfig();
	const parsed = parseMcpConfig(loaded.config.mcp, "global");
	return [...parsed.config.servers.keys()];
}

export function registerMcpCommand(pi: ExtensionAPI, runtime: McpProductRuntime): void {
	const addFlow = async (ctx: ExtensionContext, nameArgument: string | undefined, targetArgument: string | undefined): Promise<void> => {
		let target = targetArgument?.trim();
		if (!target) {
			target = (await ctx.ui.input(
				"Add MCP server",
				"paste a server URL (https://...) or a command line (e.g. npx -y @modelcontextprotocol/server-everything)",
			))?.trim();
		}
		if (!target) return;

		const isUrl = /^https?:\/\//u.test(target);
		let serverId = nameArgument?.trim() ?? "";
		if (!serverId) {
			const suggestion = suggestServerName(target);
			serverId = (await ctx.ui.input(`Server name (enter keeps "${suggestion}")`, suggestion))?.trim() || suggestion;
		}
		if (!MCP_SERVER_ID_PATTERN.test(serverId)) {
			ctx.ui.notify(`Server names use lowercase letters, digits, - and _ (max 32, starting with a letter): ${serverId}`, "warning");
			return;
		}
		const existing = await configuredServerIds();
		if (existing.includes(serverId)) {
			const replace = await ctx.ui.confirm("Replace server?", `${serverId} is already configured. Replace its record?`);
			if (!replace) return;
		}

		let record: Record<string, unknown>;
		let summary: string;
		if (isUrl) {
			ctx.ui.notify(`Probing ${target} ...`, "info");
			const probe = await probeHttpMcp(target);
			record = { transport: "http", url: target };
			if (probe.status === "auth") {
				const auth = await ctx.ui.select(`${serverId} requires authentication`, [
					"OAuth (sign in through your browser on first use)",
					"Bearer token from an environment variable",
					"None (configure anyway)",
				]);
				if (auth === undefined) return;
				if (auth.startsWith("OAuth")) record.oauth = true;
				else if (auth.startsWith("Bearer")) {
					const envName = (await ctx.ui.input("Environment variable holding the token", `MCP_${serverId.toUpperCase().replace(/[^A-Z0-9]/gu, "_")}_TOKEN`))?.trim();
					if (!envName) return;
					record.authBearerEnv = envName;
				}
			} else if (probe.status === "unreachable") {
				const anyway = await ctx.ui.confirm(
					"Endpoint not reachable",
					`The probe failed (${probe.detail ?? "unknown"}). Configure it anyway?`,
				);
				if (!anyway) return;
			}
			summary = `${serverId}: http ${target}${record.oauth ? " (OAuth)" : record.authBearerEnv ? ` (bearer from $${record.authBearerEnv})` : ""}${probe.serverName ? ` — reports "${probe.serverName}"` : ""}`;
		} else {
			const argv = tokenizeCommandLine(target);
			if (argv.length === 0) {
				ctx.ui.notify("A STDIO server needs a command line.", "warning");
				return;
			}
			record = { command: argv[0], ...(argv.length > 1 ? { args: argv.slice(1) } : {}) };
			summary = `${serverId}: stdio ${argv.join(" ")}`;
		}

		const invalid = await validateRecord(serverId, record);
		if (invalid) {
			ctx.ui.notify(`Cannot add ${serverId}: ${invalid}`, "error");
			return;
		}
		const confirmed = await ctx.ui.confirm("Add MCP server?", summary);
		if (!confirmed) return;
		await updateMcpServer(serverId, record);
		await runtime.reload(ctx);
		ctx.ui.notify(`Added MCP server ${serverId}. Ask the model to use it, or run /mcp test ${serverId}.`, "info");
	};

	const requireConfigured = async (ctx: ExtensionContext, serverId: string): Promise<boolean> => {
		if ((await configuredServerIds()).includes(serverId)) return true;
		ctx.ui.notify(`No configured MCP server is named ${serverId}. /mcp lists the configured servers.`, "warning");
		return false;
	};

	pi.registerCommand("mcp", {
		description: "Manage MCP servers: add (wizard), remove, enable, disable, test, list",
		getArgumentCompletions: async (prefix) => {
			const trimmed = prefix.trimStart();
			const [head, ...rest] = trimmed.split(/\s+/u);
			if (rest.length === 0 && !trimmed.endsWith(" ")) {
				const subcommands = ["add", "remove", "enable", "disable", "test", "--help"];
				const matches = subcommands.filter((value) => value.startsWith(head ?? "")).map((value) => ({ value: `${value} `, label: value }));
				return matches.length ? matches : null;
			}
			if (["remove", "enable", "disable", "test"].includes(head ?? "")) {
				const partial = rest.join(" ");
				const ids = (await configuredServerIds()).filter((id) => id.startsWith(partial));
				return ids.length ? ids.map((id) => ({ value: `${head} ${id}`, label: id })) : null;
			}
			return null;
		},
		handler: async (args, ctx) => {
			runtime.setContext(ctx);
			const tokens = tokenizeCommandLine(args.trim());
			const subcommand = tokens[0] ?? "";
			try {
				if (!subcommand) {
					const ids = await configuredServerIds();
					if (ids.length === 0) {
						ctx.ui.notify("No MCP servers configured. Run /mcp add and paste a URL or command line.", "info");
						return;
					}
					const lines = runtime.statusLines();
					ctx.ui.notify(lines.length ? lines.join("\n") : `Configured: ${ids.join(", ")}`, "info");
					return;
				}
				if (subcommand === "--help" || subcommand === "help") {
					await ctx.ui.editor("MCP servers", MCP_HELP);
					return;
				}
				if (subcommand === "add") {
					// /mcp add [target] | /mcp add <name> <target...>
					if (tokens.length >= 3) await addFlow(ctx, tokens[1], tokens.slice(2).join(" "));
					else await addFlow(ctx, undefined, tokens[1]);
					return;
				}
				if (subcommand === "remove") {
					const serverId = tokens[1] ?? "";
					if (!(await requireConfigured(ctx, serverId))) return;
					const confirmed = await ctx.ui.confirm("Remove MCP server?", `Remove ${serverId} from the global configuration?`);
					if (!confirmed) return;
					await updateMcpServer(serverId, undefined);
					await runtime.reload(ctx);
					ctx.ui.notify(`Removed MCP server ${serverId}.`, "info");
					return;
				}
				if (subcommand === "enable" || subcommand === "disable") {
					const serverId = tokens[1] ?? "";
					if (!(await requireConfigured(ctx, serverId))) return;
					const loaded = await loadGlobalConfig();
					const raw = ((loaded.config.mcp as { servers?: Record<string, unknown> } | undefined)?.servers?.[serverId] ?? {}) as Record<string, unknown>;
					await updateMcpServer(serverId, { ...raw, enabled: subcommand === "enable" });
					await runtime.reload(ctx);
					ctx.ui.notify(`MCP server ${serverId} is now ${subcommand}d.`, "info");
					return;
				}
				if (subcommand === "test") {
					const serverId = tokens[1] ?? "";
					if (!(await requireConfigured(ctx, serverId))) return;
					const result = await runtime.requireManager().search({ server: serverId, kind: "all", limit: 50 });
					const tools = result.records.filter((record) => record.kind === "tool").map((record) => record.name);
					const resources = result.records.filter((record) => record.kind !== "tool").length;
					ctx.ui.notify(
						`${serverId} is reachable: ${tools.length} tool(s)${tools.length ? ` (${tools.slice(0, 8).join(", ")}${tools.length > 8 ? ", …" : ""})` : ""}${resources ? `, ${resources} resource/template record(s)` : ""}.`,
						"info",
					);
					return;
				}
				ctx.ui.notify("Usage: /mcp [add|remove|enable|disable|test|--help]", "warning");
			} catch (error) {
				const message = error instanceof McpError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`/mcp failed: ${message}`, "error");
			}
		},
	});
}
