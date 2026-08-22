/**
 * Parse, validate, merge, and redact MCP settings (docs/31 section 3).
 *
 * Global configuration lives in the versioned product config under an `mcp`
 * section; trusted-project configuration may add or atomically replace whole
 * server records. Untrusted project input must never reach this module.
 */

import { isAbsolute } from "node:path";
import {
	MCP_LIMITS,
	MCP_SERVER_ID_PATTERN,
	McpError,
	type McpConfig,
	type McpConfigDiagnostic,
	type McpConfigScope,
	type McpEffect,
	type McpServerConfig,
	type McpToolPolicyEntry,
} from "./types.ts";

const EFFECTS: readonly McpEffect[] = ["read", "mutate", "unknown"];
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
// Conservative high-confidence secret shapes; literal env values must not be secrets.
const SECRET_VALUE_PATTERN =
	/(?:\b(?:sk|rk|pk|ghp|gho|xox[baprs])-[A-Za-z0-9_-]{16,}|-----BEGIN [^-]+ PRIVATE KEY-----|\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.)/u;

export interface ParsedMcpConfig {
	readonly config: McpConfig;
	readonly diagnostics: readonly McpConfigDiagnostic[];
}

/** Parse one scope's raw `mcp` section into validated server records. */
export function parseMcpConfig(raw: unknown, scope: McpConfigScope): ParsedMcpConfig {
	const diagnostics: McpConfigDiagnostic[] = [];
	const servers = new Map<string, McpServerConfig>();
	if (raw === undefined || raw === null) return { config: { servers }, diagnostics };
	if (typeof raw !== "object" || Array.isArray(raw)) {
		diagnostics.push({ message: "mcp section must be an object" });
		return { config: { servers }, diagnostics };
	}
	const section = (raw as { servers?: unknown }).servers;
	if (section === undefined) return { config: { servers }, diagnostics };
	if (!section || typeof section !== "object" || Array.isArray(section)) {
		diagnostics.push({ message: "mcp.servers must be an object" });
		return { config: { servers }, diagnostics };
	}
	for (const [serverId, value] of Object.entries(section as Record<string, unknown>)) {
		if (servers.size >= MCP_LIMITS.maxServers) {
			diagnostics.push({ serverId, message: `at most ${MCP_LIMITS.maxServers} servers are supported; ignoring the rest` });
			break;
		}
		const parsed = parseServer(serverId, value, scope, diagnostics);
		if (parsed) servers.set(serverId, parsed);
	}
	return { config: { servers }, diagnostics };
}

/** Project records atomically replace the same global server ID; no deep merge. */
export function mergeMcpConfigs(global: McpConfig, project: McpConfig): McpConfig {
	const servers = new Map(global.servers);
	for (const [serverId, record] of project.servers) servers.set(serverId, record);
	while (servers.size > MCP_LIMITS.maxServers) {
		const last = [...servers.keys()].at(-1)!;
		servers.delete(last);
	}
	return { servers };
}

/** Redacted, log-safe projection of one server record (no env values). */
export function redactServerConfig(config: McpServerConfig): Record<string, unknown> {
	return {
		serverId: config.serverId,
		configScope: config.configScope,
		enabled: config.enabled,
		description: config.description,
		transport: config.transport,
		...(config.url ? { url: config.url } : {}),
		...(config.authBearerEnv ? { authBearerEnv: config.authBearerEnv } : {}),
		...(config.oauth ? { oauth: { scopes: [...config.oauth.scopes] } } : {}),
		command: config.command,
		argCount: config.args.length,
		cwd: config.cwd,
		envNames: Object.keys(config.env),
		passEnv: [...config.passEnv],
		required: config.required,
		startupTimeoutMs: config.startupTimeoutMs,
		callTimeoutMs: config.callTimeoutMs,
		allowUntrustedProjects: config.allowUntrustedProjects,
	};
}

function parseServer(
	serverId: string,
	value: unknown,
	scope: McpConfigScope,
	diagnostics: McpConfigDiagnostic[],
): McpServerConfig | undefined {
	const fail = (message: string): undefined => {
		diagnostics.push({ serverId, message });
		return undefined;
	};
	if (!MCP_SERVER_ID_PATTERN.test(serverId)) return fail("server ID must match [a-z][a-z0-9_-]{0,31}");
	if (!value || typeof value !== "object" || Array.isArray(value)) return fail("server record must be an object");
	const record = value as Record<string, unknown>;

	const transport = record.transport === undefined ? "stdio" : record.transport;
	if (transport !== "stdio" && transport !== "http") return fail('transport must be "stdio" or "http"');

	let url: string | undefined;
	let authBearerEnv: string | undefined;
	let oauth: { clientId?: string; scopes: string[] } | undefined;
	if (transport === "http") {
		if (typeof record.url !== "string" || record.url.length > 2_048) return fail("http transport requires a bounded url string");
		let parsedUrl: URL;
		try {
			parsedUrl = new URL(record.url);
		} catch {
			return fail("url is not a valid URL");
		}
		const loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(parsedUrl.hostname);
		if (parsedUrl.protocol !== "https:" && !(parsedUrl.protocol === "http:" && loopback)) {
			return fail("http transport requires https, or http on loopback only");
		}
		if (parsedUrl.username || parsedUrl.password) return fail("url must not embed credentials");
		url = record.url;
		if (record.authBearerEnv !== undefined) {
			if (typeof record.authBearerEnv !== "string" || !ENV_NAME_PATTERN.test(record.authBearerEnv)) {
				return fail("authBearerEnv must be a valid environment variable name");
			}
			authBearerEnv = record.authBearerEnv;
		}
		if (record.oauth !== undefined) {
			if (record.oauth === true) oauth = { scopes: [] };
			else if (record.oauth && typeof record.oauth === "object" && !Array.isArray(record.oauth)) {
				const raw = record.oauth as Record<string, unknown>;
				if (raw.clientId !== undefined && (typeof raw.clientId !== "string" || raw.clientId.length > 256)) return fail("oauth.clientId must be a bounded string");
				if (raw.clientName !== undefined && (typeof raw.clientName !== "string" || raw.clientName.length === 0 || raw.clientName.length > 64 || /[\0\r\n]/u.test(raw.clientName))) return fail("oauth.clientName must be a bounded string");
				const scopes: string[] = [];
				if (raw.scopes !== undefined) {
					if (!Array.isArray(raw.scopes) || raw.scopes.length > 16) return fail("oauth.scopes must be an array of at most 16 scopes");
					for (const scope of raw.scopes) {
						if (typeof scope !== "string" || !/^[\x21\x23-\x5B\x5D-\x7E]{1,128}$/u.test(scope)) return fail("oauth scopes must be printable tokens");
						scopes.push(scope);
					}
				}
				oauth = {
					...(typeof raw.clientId === "string" ? { clientId: raw.clientId } : {}),
					...(typeof raw.clientName === "string" ? { clientName: raw.clientName } : {}),
					scopes,
				};
			} else return fail("oauth must be true or an object");
		}
		if (authBearerEnv && oauth) return fail("configure either authBearerEnv or oauth, not both");
		if (record.command !== undefined) return fail("http transport does not accept a command");
	}

	let command = "";
	if (transport === "stdio") {
		const rawCommand = record.command;
		if (typeof rawCommand !== "string" || !rawCommand.trim()) return fail("command must be a non-empty string");
		if (/[\0\r\n]/u.test(rawCommand)) return fail("command contains control characters");
		if (record.url !== undefined || record.authBearerEnv !== undefined || record.oauth !== undefined) {
			return fail("url, authBearerEnv, and oauth apply only to http transport");
		}
		command = rawCommand;
	}

	const args: string[] = [];
	if (record.args !== undefined) {
		if (!Array.isArray(record.args) || record.args.length > 64) return fail("args must be an array of at most 64 strings");
		for (const arg of record.args) {
			if (typeof arg !== "string" || arg.length > 4_096 || /[\0]/u.test(arg)) return fail("every arg must be a bounded string");
			args.push(arg);
		}
	}

	let cwd = "workspace";
	if (record.cwd !== undefined) {
		if (typeof record.cwd !== "string") return fail("cwd must be a string");
		if (record.cwd !== "workspace") {
			if (scope === "project") return fail('project configuration may select only "workspace" as cwd');
			if (!isAbsolute(record.cwd)) return fail("global cwd must be \"workspace\" or an absolute directory");
			cwd = record.cwd;
		}
	}

	const env: Record<string, string> = {};
	if (record.env !== undefined) {
		if (!record.env || typeof record.env !== "object" || Array.isArray(record.env)) return fail("env must be an object");
		for (const [name, envValue] of Object.entries(record.env as Record<string, unknown>)) {
			if (!ENV_NAME_PATTERN.test(name)) return fail(`env name is invalid: ${name}`);
			if (typeof envValue !== "string" || envValue.length > 8_192) return fail(`env value for ${name} must be a bounded string`);
			if (SECRET_VALUE_PATTERN.test(envValue)) {
				return fail(`env value for ${name} looks like a credential; use passEnv instead of a settings literal`);
			}
			env[name] = envValue;
		}
	}

	const passEnv: string[] = [];
	if (record.passEnv !== undefined) {
		if (!Array.isArray(record.passEnv) || record.passEnv.length > 32) return fail("passEnv must be an array of at most 32 names");
		for (const name of record.passEnv) {
			if (typeof name !== "string" || !ENV_NAME_PATTERN.test(name)) return fail("every passEnv entry must be a valid variable name");
			passEnv.push(name);
		}
	}

	const timeout = (key: "startupTimeoutMs" | "callTimeoutMs", fallback: number): number | undefined => {
		const raw = record[key];
		if (raw === undefined) return fallback;
		if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < MCP_LIMITS.minTimeoutMs || raw > MCP_LIMITS.maxTimeoutMs) {
			fail(`${key} must be an integer between ${MCP_LIMITS.minTimeoutMs} and ${MCP_LIMITS.maxTimeoutMs}`);
			return undefined;
		}
		return raw;
	};
	const startupTimeoutMs = timeout("startupTimeoutMs", MCP_LIMITS.defaultStartupTimeoutMs);
	if (startupTimeoutMs === undefined) return undefined;
	const callTimeoutMs = timeout("callTimeoutMs", MCP_LIMITS.defaultCallTimeoutMs);
	if (callTimeoutMs === undefined) return undefined;

	const rules = (key: "toolAllow" | "toolDeny" | "resourceAllow" | "resourceDeny", fallback: string[]): string[] | undefined => {
		const raw = record[key];
		if (raw === undefined) return fallback;
		if (!Array.isArray(raw) || raw.length > 256) {
			fail(`${key} must be an array of at most 256 rules`);
			return undefined;
		}
		const out: string[] = [];
		for (const rule of raw) {
			// Exact names or the single wildcard "*"; no regex/glob interpretation.
			if (typeof rule !== "string" || rule.length === 0 || rule.length > 256 || (rule.includes("*") && rule !== "*")) {
				fail(`${key} rules must be exact names or the single wildcard "*"`);
				return undefined;
			}
			out.push(rule);
		}
		return out;
	};
	const toolAllow = rules("toolAllow", ["*"]);
	const toolDeny = rules("toolDeny", []);
	const resourceAllow = rules("resourceAllow", ["*"]);
	const resourceDeny = rules("resourceDeny", []);
	if (!toolAllow || !toolDeny || !resourceAllow || !resourceDeny) return undefined;

	const toolPolicy: Record<string, McpToolPolicyEntry> = {};
	if (record.toolPolicy !== undefined) {
		if (!record.toolPolicy || typeof record.toolPolicy !== "object" || Array.isArray(record.toolPolicy)) return fail("toolPolicy must be an object");
		for (const [name, entryValue] of Object.entries(record.toolPolicy as Record<string, unknown>)) {
			if (!entryValue || typeof entryValue !== "object" || Array.isArray(entryValue)) return fail(`toolPolicy.${name} must be an object`);
			const entry = entryValue as Record<string, unknown>;
			const effect = entry.effect;
			if (typeof effect !== "string" || !EFFECTS.includes(effect as McpEffect)) return fail(`toolPolicy.${name}.effect must be read, mutate, or unknown`);
			const allowInPlan = entry.allowInPlan;
			if (allowInPlan !== undefined && typeof allowInPlan !== "boolean") return fail(`toolPolicy.${name}.allowInPlan must be boolean`);
			toolPolicy[name] = { effect: effect as McpEffect, allowInPlan: allowInPlan === true };
		}
	}

	const bool = (key: string, fallback: boolean): boolean | undefined => {
		const raw = record[key];
		if (raw === undefined) return fallback;
		if (typeof raw !== "boolean") {
			fail(`${key} must be boolean`);
			return undefined;
		}
		return raw;
	};
	const enabled = bool("enabled", true);
	const required = bool("required", false);
	const allowUntrustedProjects = bool("allowUntrustedProjects", false);
	if (enabled === undefined || required === undefined || allowUntrustedProjects === undefined) return undefined;

	const description = typeof record.description === "string" ? record.description.slice(0, 500) : "";

	return {
		serverId,
		enabled,
		description,
		transport,
		...(url !== undefined ? { url } : {}),
		...(authBearerEnv !== undefined ? { authBearerEnv } : {}),
		...(oauth !== undefined ? { oauth } : {}),
		command,
		args,
		cwd,
		env,
		passEnv,
		required,
		startupTimeoutMs,
		callTimeoutMs,
		allowUntrustedProjects,
		toolAllow,
		toolDeny,
		toolPolicy,
		resourceAllow,
		resourceDeny,
		configScope: scope,
	};
}

/** Deny wins over allow; rules are exact names or the single wildcard "*". */
export function ruleAllows(allow: readonly string[], deny: readonly string[], name: string): boolean {
	if (deny.some((rule) => rule === "*" || rule === name)) return false;
	return allow.some((rule) => rule === "*" || rule === name);
}

/** Resolve the child environment: minimal platform base + literals + exact passEnv. */
export function buildChildEnv(
	config: McpServerConfig,
	hostEnv: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
	const base = process.platform === "win32"
		? ["SystemRoot", "SystemDrive", "ComSpec", "PATHEXT", "windir", "PATH", "TEMP", "TMP", "USERPROFILE"]
		: ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM", "USER", "SHELL"];
	const env: Record<string, string> = {};
	for (const name of base) {
		const value = hostEnv[name];
		if (value !== undefined) env[name] = value;
	}
	Object.assign(env, config.env);
	for (const name of config.passEnv) {
		const value = hostEnv[name];
		if (value === undefined) {
			throw new McpError("MCP_CONFIG_INVALID", `passEnv variable is not set on this host: ${name}`, config.serverId);
		}
		env[name] = value;
	}
	return env;
}
