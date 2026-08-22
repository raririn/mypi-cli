/**
 * FEAT-067 Slice A: validated configuration, provenance, status, and error
 * types for the execution-host-native MCP STDIO client. This module is
 * dependency-free so every other MCP unit and test can import it cheaply.
 */

export type McpEffect = "read" | "mutate" | "unknown";

export interface McpToolPolicyEntry {
	readonly effect: McpEffect;
	readonly allowInPlan: boolean;
}

export type McpConfigScope = "global" | "project";

export type McpTransportKind = "stdio" | "http";

/** OAuth 2.1 client settings for one Streamable HTTP server (Slice B). */
export interface McpOAuthConfig {
	/** Static client ID; omitted when dynamic client registration is expected. */
	readonly clientId?: string;
	/**
	 * client_name sent to dynamic client registration. Some providers key
	 * provisioned clients on known agent names and ignore unknown ones.
	 * Default: "MyPi".
	 */
	readonly clientName?: string;
	/**
	 * Fixed loopback redirect port. Some providers pre-register redirect URIs
	 * for provisioned clients (keyed by clientName) and reject other ports.
	 * When set, the flow fails instead of falling back to an ephemeral port.
	 */
	readonly redirectPort?: number;
	/** Requested scopes; the authorization server may narrow them. */
	readonly scopes: readonly string[];
}

/** One validated server record. For stdio, `command`/`args` are argv, never a shell string. */
export interface McpServerConfig {
	readonly serverId: string;
	readonly enabled: boolean;
	readonly description: string;
	readonly transport: McpTransportKind;
	/** Streamable HTTP endpoint; https required except loopback. */
	readonly url?: string;
	/** Bearer-token indirection: host env var name holding the token. Never a literal. */
	readonly authBearerEnv?: string;
	/** OAuth 2.1 authorization-code + PKCE settings. */
	readonly oauth?: McpOAuthConfig;
	readonly command: string;
	readonly args: readonly string[];
	/** `"workspace"` or an absolute execution-host directory (global scope only). */
	readonly cwd: string;
	/** Literal non-secret environment values. */
	readonly env: Readonly<Record<string, string>>;
	/** Exact host environment variable names forwarded to the child. */
	readonly passEnv: readonly string[];
	readonly required: boolean;
	readonly startupTimeoutMs: number;
	readonly callTimeoutMs: number;
	readonly allowUntrustedProjects: boolean;
	readonly toolAllow: readonly string[];
	readonly toolDeny: readonly string[];
	readonly toolPolicy: Readonly<Record<string, McpToolPolicyEntry>>;
	readonly resourceAllow: readonly string[];
	readonly resourceDeny: readonly string[];
	readonly configScope: McpConfigScope;
}

export interface McpConfig {
	readonly servers: ReadonlyMap<string, McpServerConfig>;
}

export interface McpConfigDiagnostic {
	readonly serverId?: string;
	readonly message: string;
}

/** Non-secret launch/identity record for approval text and diagnostics. */
export interface McpServerProvenance {
	readonly serverId: string;
	readonly configScope: McpConfigScope;
	readonly canonicalExecutable: string;
	readonly executableSha256: string;
	readonly argvSha256: string;
	readonly passedEnvNames: readonly string[];
	readonly serverInfo: { readonly name: string; readonly version: string };
	readonly negotiatedProtocol: string;
	readonly instanceId: string;
	readonly catalogRevision: string;
}

export type McpConnectionState =
	| "cold"
	| "starting"
	| "ready"
	| "stale"
	| "stopping"
	| "crashed"
	| "failed";

export interface McpToolDescriptor {
	readonly serverId: string;
	readonly remoteName: string;
	readonly exposedName: string;
	readonly description: string;
	readonly inputSchema: Record<string, unknown>;
	readonly schemaFingerprint: string;
	readonly effect: McpEffect;
	readonly allowInPlan: boolean;
}

export interface McpResourceDescriptor {
	readonly serverId: string;
	readonly uri: string;
	readonly name: string;
	readonly description: string;
	readonly mimeType?: string;
}

export interface McpResourceTemplateDescriptor {
	readonly serverId: string;
	readonly uriTemplate: string;
	readonly name: string;
	readonly description: string;
	readonly mimeType?: string;
}

/** Catalog entry for a tool the server advertises but Slice A excludes. */
export interface McpExcludedTool {
	readonly serverId: string;
	readonly remoteName: string;
	readonly reason: string;
}

export type McpErrorCode =
	| "MCP_CONFIG_INVALID"
	| "MCP_SERVER_UNKNOWN"
	| "MCP_SERVER_DISABLED"
	| "MCP_SERVER_UNAVAILABLE"
	| "MCP_SERVER_RECYCLED"
	| "MCP_PROTOCOL_ERROR"
	| "MCP_UNSUPPORTED"
	| "MCP_TIMEOUT"
	| "MCP_CANCELLED"
	| "MCP_POLICY_BLOCKED"
	| "MCP_APPROVAL_REQUIRED"
	| "MCP_TOOL_UNKNOWN"
	| "MCP_TOOL_EXCLUDED"
	| "MCP_TOOL_CHANGED"
	| "MCP_NAME_COLLISION"
	| "MCP_RESOURCE_BLOCKED"
	| "MCP_LIMIT_EXCEEDED"
	| "MCP_CREDENTIAL_BLOCKED"
	| "MCP_AUTH_REQUIRED"
	| "MCP_AUTH_FAILED";

export class McpError extends Error {
	readonly code: McpErrorCode;
	readonly serverId?: string;
	constructor(code: McpErrorCode, message: string, serverId?: string) {
		super(message);
		this.name = "McpError";
		this.code = code;
		this.serverId = serverId;
	}
}

/* ------------------------------------------------------------------ */
/*  Slice A hard limits (docs/31 section 8)                            */
/* ------------------------------------------------------------------ */

export const MCP_LIMITS = {
	maxServers: 32,
	maxPagesPerKind: 100,
	maxEntriesPerKind: 1_000,
	maxMessageBytes: 4 * 1024 * 1024,
	maxBufferedBytes: 8 * 1024 * 1024,
	stderrRingBytes: 64 * 1024,
	maxSchemaBytes: 64 * 1024,
	maxSchemaDepth: 16,
	maxSchemaProperties: 256,
	maxActiveTools: 32,
	maxActiveSchemaBytes: 512 * 1024,
	maxResultTextBytes: 128 * 1024,
	maxContentBlocks: 16,
	maxImages: 4,
	maxImageBytes: 5 * 1024 * 1024,
	maxCombinedImageBytes: 10 * 1024 * 1024,
	minTimeoutMs: 1_000,
	maxTimeoutMs: 10 * 60_000,
	defaultStartupTimeoutMs: 10_000,
	defaultCallTimeoutMs: 60_000,
	maxConcurrentPerServer: 4,
	maxConcurrentPerSession: 8,
	maxLoadTools: 8,
	searchDefaultLimit: 20,
	searchMaxLimit: 50,
} as const;

export const MCP_SERVER_ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/u;
