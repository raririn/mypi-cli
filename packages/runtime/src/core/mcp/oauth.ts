/**
 * OAuth 2.1 client for Streamable HTTP MCP servers (FEAT-067 Slice B).
 *
 * Implements protected-resource metadata discovery (RFC 9728), authorization
 * server metadata (RFC 8414), optional dynamic client registration (RFC 7591),
 * authorization-code + PKCE (S256) with a loopback redirect listener, the
 * RFC 8707 `resource` parameter, refresh, and a mode-0600 per-server token
 * store below `<agentDir>/runtime/mcp/oauth/`.
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { McpError, type McpOAuthConfig } from "./types.ts";

const DISCOVERY_TIMEOUT_MS = 20_000;
const AUTHORIZATION_TIMEOUT_MS = 5 * 60_000;
const MAX_METADATA_BYTES = 256 * 1024;

export interface McpOAuthTokens {
	readonly version: 1;
	readonly serverId: string;
	readonly resource: string;
	readonly clientId: string;
	readonly accessToken: string;
	readonly refreshToken?: string;
	readonly expiresAt?: number;
	readonly scope?: string;
	readonly tokenEndpoint: string;
}

export interface McpOAuthProviderOptions {
	readonly agentDir: string;
	readonly serverId: string;
	readonly serverUrl: string;
	readonly config: McpOAuthConfig;
	/**
	 * Present the authorization URL to the user (browser hand-off). Headless
	 * surfaces without this capability fail closed with MCP_AUTH_REQUIRED.
	 */
	readonly authorize?: (url: string) => Promise<void>;
}

interface McpOAuthClientRegistration {
	readonly version: 1;
	readonly serverId: string;
	readonly issuer: string;
	readonly clientId: string;
	/** Loopback redirect port the client was registered with; reused when free. */
	readonly redirectPort: number;
}

export class McpOAuthProvider {
	private readonly options: McpOAuthProviderOptions;
	private readonly storePath: string;
	private readonly clientStorePath: string;
	private tokens?: McpOAuthTokens;
	private flight?: Promise<string>;

	constructor(options: McpOAuthProviderOptions) {
		this.options = options;
		this.storePath = resolve(options.agentDir, "runtime", "mcp", "oauth", `${options.serverId}.json`);
		this.clientStorePath = resolve(options.agentDir, "runtime", "mcp", "oauth", `${options.serverId}.client.json`);
	}

	/** Return a bearer token, refreshing when expired. Never starts a browser flow. */
	async cachedToken(): Promise<string | undefined> {
		await this.loadStore();
		if (!this.tokens) return undefined;
		if (this.tokens.expiresAt !== undefined && Date.now() > this.tokens.expiresAt - 30_000) {
			if (!this.tokens.refreshToken) return undefined;
			try {
				return await this.refresh();
			} catch {
				return undefined;
			}
		}
		return this.tokens.accessToken;
	}

	/** Full interactive acquisition after a 401 challenge. Coalesces concurrent callers. */
	async acquireToken(wwwAuthenticate: string | undefined): Promise<string> {
		this.flight ??= this.performAcquisition(wwwAuthenticate).finally(() => {
			this.flight = undefined;
		});
		return this.flight;
	}

	async forget(): Promise<void> {
		this.tokens = undefined;
		await rm(this.storePath, { force: true });
		await rm(this.clientStorePath, { force: true });
	}

	/**
	 * Ensure a usable token exists before the MCP initialize request, so the
	 * interactive browser flow runs under the authorization budget instead of
	 * the connection's short startup timeout. Returns false when the endpoint
	 * answered the anonymous probe without a challenge.
	 */
	async preflight(): Promise<boolean> {
		const cached = await this.cachedToken();
		if (cached) return true;
		let challenge: string | undefined;
		try {
			const response = await fetch(this.options.serverUrl, {
				method: "POST",
				headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "initialize",
					params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "MyPi", version: "1.0" } },
				}),
				signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
			});
			await response.body?.cancel().catch(() => undefined);
			if (response.status !== 401 && response.status !== 403) return false;
			challenge = response.headers.get("www-authenticate") ?? undefined;
		} catch {
			// Unreachable endpoints surface through the ordinary connection path.
			return false;
		}
		await this.acquireToken(challenge);
		return true;
	}

	/* ---------------------------------------------------------------- */

	private async performAcquisition(wwwAuthenticate: string | undefined): Promise<string> {
		const cached = await this.cachedToken();
		if (cached) return cached;
		if (!this.options.authorize) {
			throw new McpError(
				"MCP_AUTH_REQUIRED",
				`MCP server ${this.options.serverId} requires OAuth authorization, and this surface cannot open the authorization URL`,
				this.options.serverId,
			);
		}
		const resourceMetadataUrl = parseResourceMetadataUrl(wwwAuthenticate)
			?? new URL("/.well-known/oauth-protected-resource", this.options.serverUrl).toString();
		const resourceMetadata = await fetchJson(resourceMetadataUrl).catch(() => undefined);
		const resourceId = typeof resourceMetadata?.resource === "string" ? resourceMetadata.resource : canonicalResource(this.options.serverUrl);
		const authServer = Array.isArray(resourceMetadata?.authorization_servers) && typeof resourceMetadata.authorization_servers[0] === "string"
			? resourceMetadata.authorization_servers[0]
			: new URL(this.options.serverUrl).origin;
		const asMetadata = await this.fetchAuthServerMetadata(authServer);
		const authorizationEndpoint = requireString(asMetadata, "authorization_endpoint", this.options.serverId);
		const tokenEndpoint = requireString(asMetadata, "token_endpoint", this.options.serverId);
		// Without configured scopes, request what the protected resource (or the
		// authorization server) advertises; providers such as Robinhood reject
		// authorization requests that omit their published scope.
		const scopes = this.options.config.scopes.length
			? [...this.options.config.scopes]
			: advertisedScopes(resourceMetadata) ?? advertisedScopes(asMetadata) ?? [];
		const issuer = typeof asMetadata.issuer === "string" ? asMetadata.issuer : authServer;

		const storedClient = this.options.config.clientId ? undefined : await this.loadClientRegistration(issuer);
		const { server, redirectUri, port, callback } = await this.startLoopbackListener(storedClient?.redirectPort);
		try {
			// A persisted dynamic client is bound to its registered redirect port;
			// when that port is unavailable this run, register a fresh client.
			let clientId = this.options.config.clientId
				?? (storedClient && storedClient.redirectPort === port ? storedClient.clientId : undefined);
			if (!clientId) {
				clientId = await this.registerClient(asMetadata, redirectUri) ?? undefined;
				if (clientId && !this.options.config.clientId) {
					await this.saveClientRegistration({ version: 1, serverId: this.options.serverId, issuer, clientId, redirectPort: port });
				}
			}
			if (!clientId) {
				throw new McpError("MCP_AUTH_FAILED", "no OAuth client ID is configured and the authorization server does not support dynamic client registration", this.options.serverId);
			}
			const verifier = randomBytes(48).toString("base64url");
			const challenge = createHash("sha256").update(verifier).digest("base64url");
			const state = randomBytes(24).toString("base64url");
			const authorizeUrl = new URL(authorizationEndpoint);
			authorizeUrl.searchParams.set("response_type", "code");
			authorizeUrl.searchParams.set("client_id", clientId);
			authorizeUrl.searchParams.set("redirect_uri", redirectUri);
			authorizeUrl.searchParams.set("code_challenge", challenge);
			authorizeUrl.searchParams.set("code_challenge_method", "S256");
			authorizeUrl.searchParams.set("state", state);
			authorizeUrl.searchParams.set("resource", resourceId);
			if (scopes.length) authorizeUrl.searchParams.set("scope", scopes.join(" "));

			await this.options.authorize(authorizeUrl.toString());
			const result = await callback;
			if (result.state !== state) throw new McpError("MCP_AUTH_FAILED", "OAuth state mismatch on the redirect callback", this.options.serverId);
			const tokenResponse = await postForm(tokenEndpoint, {
				grant_type: "authorization_code",
				code: result.code,
				redirect_uri: redirectUri,
				client_id: clientId,
				code_verifier: verifier,
				resource: resourceId,
			}, this.options.serverId);
			await this.storeTokens(tokenResponse, clientId, resourceId, tokenEndpoint);
			return this.tokens!.accessToken;
		} finally {
			server.close();
		}
	}

	private async refresh(): Promise<string> {
		const tokens = this.tokens!;
		const response = await postForm(tokens.tokenEndpoint, {
			grant_type: "refresh_token",
			refresh_token: tokens.refreshToken!,
			client_id: tokens.clientId,
			resource: tokens.resource,
		}, this.options.serverId);
		await this.storeTokens(response, tokens.clientId, tokens.resource, tokens.tokenEndpoint, tokens.refreshToken);
		return this.tokens!.accessToken;
	}

	private async fetchAuthServerMetadata(issuer: string): Promise<Record<string, unknown>> {
		const base = new URL(issuer);
		const candidates = [
			new URL(`/.well-known/oauth-authorization-server${base.pathname === "/" ? "" : base.pathname}`, base.origin),
			new URL(`/.well-known/openid-configuration${base.pathname === "/" ? "" : base.pathname}`, base.origin),
		];
		for (const candidate of candidates) {
			const metadata = await fetchJson(candidate.toString()).catch(() => undefined);
			if (metadata && typeof metadata.token_endpoint === "string") return metadata;
		}
		throw new McpError("MCP_AUTH_FAILED", `OAuth authorization server metadata is unavailable for ${issuer}`, this.options.serverId);
	}

	private async registerClient(asMetadata: Record<string, unknown>, redirectUri: string): Promise<string | undefined> {
		const endpoint = asMetadata.registration_endpoint;
		if (typeof endpoint !== "string") return undefined;
		const response = await fetch(endpoint, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				client_name: "MyPi",
				redirect_uris: [redirectUri],
				grant_types: ["authorization_code", "refresh_token"],
				response_types: ["code"],
				token_endpoint_auth_method: "none",
			}),
			signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
		});
		if (!response.ok) return undefined;
		const body = await boundedJson(response);
		return typeof body?.client_id === "string" ? body.client_id : undefined;
	}

	private startLoopbackListener(preferredPort?: number): Promise<{
		server: ReturnType<typeof createServer>;
		redirectUri: string;
		port: number;
		callback: Promise<{ code: string; state: string }>;
	}> {
		return new Promise((resolveListener, rejectListener) => {
			let settle: (value: { code: string; state: string }) => void;
			let fail: (error: Error) => void;
			const callback = new Promise<{ code: string; state: string }>((resolveCallback, rejectCallback) => {
				settle = resolveCallback;
				fail = rejectCallback;
			});
			const timer = setTimeout(
				() => fail(new McpError("MCP_AUTH_FAILED", "timed out waiting for the OAuth redirect", this.options.serverId)),
				AUTHORIZATION_TIMEOUT_MS,
			);
			timer.unref?.();
			const server = createServer((request, response) => {
				const url = new URL(request.url ?? "/", "http://127.0.0.1");
				if (url.pathname !== "/callback") {
					response.writeHead(404).end();
					return;
				}
				const code = url.searchParams.get("code");
				const state = url.searchParams.get("state");
				const errorParam = url.searchParams.get("error");
				response.writeHead(200, { "content-type": "text/plain" });
				response.end(errorParam ? `Authorization failed: ${errorParam}. Return to MyPi.` : "Authorization complete. Return to MyPi.");
				clearTimeout(timer);
				if (errorParam || !code || !state) {
					fail(new McpError("MCP_AUTH_FAILED", `OAuth authorization was rejected: ${errorParam ?? "missing code"}`, this.options.serverId));
					return;
				}
				settle({ code, state });
			});
			let retried = false;
			server.on("error", (error) => {
				// Fall back to an ephemeral port when the preferred one is taken.
				if (!retried && preferredPort && (error as NodeJS.ErrnoException).code === "EADDRINUSE") {
					retried = true;
					server.listen(0, "127.0.0.1");
					return;
				}
				rejectListener(error);
			});
			server.listen(preferredPort ?? 0, "127.0.0.1", () => {
				const address = server.address();
				if (!address || typeof address !== "object") {
					rejectListener(new McpError("MCP_AUTH_FAILED", "loopback redirect listener failed to bind", this.options.serverId));
					return;
				}
				resolveListener({ server, redirectUri: `http://127.0.0.1:${address.port}/callback`, port: address.port, callback });
			});
		});
	}

	private async storeTokens(
		response: Record<string, unknown>,
		clientId: string,
		resource: string,
		tokenEndpoint: string,
		previousRefreshToken?: string,
	): Promise<void> {
		const accessToken = response.access_token;
		if (typeof accessToken !== "string" || !accessToken) {
			throw new McpError("MCP_AUTH_FAILED", "token endpoint returned no access token", this.options.serverId);
		}
		const expiresIn = typeof response.expires_in === "number" && Number.isFinite(response.expires_in) ? response.expires_in : undefined;
		this.tokens = {
			version: 1,
			serverId: this.options.serverId,
			resource,
			clientId,
			accessToken,
			...(typeof response.refresh_token === "string"
				? { refreshToken: response.refresh_token }
				: previousRefreshToken
					? { refreshToken: previousRefreshToken }
					: {}),
			...(expiresIn !== undefined ? { expiresAt: Date.now() + expiresIn * 1_000 } : {}),
			...(typeof response.scope === "string" ? { scope: response.scope } : {}),
			tokenEndpoint,
		};
		await mkdir(resolve(this.options.agentDir, "runtime", "mcp", "oauth"), { recursive: true, mode: 0o700 });
		await writeFile(this.storePath, `${JSON.stringify(this.tokens, null, 2)}\n`, { mode: 0o600 });
		await chmod(this.storePath, 0o600);
	}

	private async loadClientRegistration(issuer: string): Promise<McpOAuthClientRegistration | undefined> {
		try {
			const parsed = JSON.parse(await readFile(this.clientStorePath, "utf8")) as McpOAuthClientRegistration;
			if (
				parsed.version === 1 &&
				parsed.serverId === this.options.serverId &&
				parsed.issuer === issuer &&
				typeof parsed.clientId === "string" &&
				Number.isInteger(parsed.redirectPort)
			) {
				return parsed;
			}
		} catch {
			// No stored registration.
		}
		return undefined;
	}

	private async saveClientRegistration(registration: McpOAuthClientRegistration): Promise<void> {
		await mkdir(resolve(this.options.agentDir, "runtime", "mcp", "oauth"), { recursive: true, mode: 0o700 });
		await writeFile(this.clientStorePath, `${JSON.stringify(registration, null, 2)}\n`, { mode: 0o600 });
		await chmod(this.clientStorePath, 0o600);
	}

	private async loadStore(): Promise<void> {
		if (this.tokens) return;
		try {
			const parsed = JSON.parse(await readFile(this.storePath, "utf8")) as McpOAuthTokens;
			if (parsed.version === 1 && parsed.serverId === this.options.serverId && typeof parsed.accessToken === "string") {
				this.tokens = parsed;
			}
		} catch {
			// No stored tokens.
		}
	}
}

function advertisedScopes(metadata: Record<string, unknown> | undefined): string[] | undefined {
	const raw = metadata?.scopes_supported;
	if (!Array.isArray(raw)) return undefined;
	const scopes = raw.filter((scope): scope is string => typeof scope === "string" && scope.length > 0).slice(0, 16);
	return scopes.length ? scopes : undefined;
}

function canonicalResource(serverUrl: string): string {
	const url = new URL(serverUrl);
	url.hash = "";
	url.search = "";
	return url.toString().replace(/\/$/u, "");
}

function parseResourceMetadataUrl(wwwAuthenticate: string | undefined): string | undefined {
	if (!wwwAuthenticate) return undefined;
	const match = wwwAuthenticate.match(/resource_metadata="([^"]+)"/u);
	return match?.[1];
}

function requireString(record: Record<string, unknown>, key: string, serverId: string): string {
	const value = record[key];
	if (typeof value !== "string" || !value) {
		throw new McpError("MCP_AUTH_FAILED", `OAuth metadata is missing ${key}`, serverId);
	}
	return value;
}

async function fetchJson(url: string): Promise<Record<string, unknown> | undefined> {
	const response = await fetch(url, {
		headers: { accept: "application/json" },
		signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
	});
	if (!response.ok) return undefined;
	return boundedJson(response);
}

async function postForm(endpoint: string, form: Record<string, string>, serverId: string): Promise<Record<string, unknown>> {
	const response = await fetch(endpoint, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
		body: new URLSearchParams(form).toString(),
		signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
	});
	const body = await boundedJson(response).catch(() => undefined);
	if (!response.ok) {
		const detail = typeof body?.error === "string" ? body.error : `HTTP ${response.status}`;
		throw new McpError("MCP_AUTH_FAILED", `OAuth token request failed: ${detail}`, serverId);
	}
	if (!body) throw new McpError("MCP_AUTH_FAILED", "OAuth token endpoint returned a non-JSON body", serverId);
	return body;
}

async function boundedJson(response: Response): Promise<Record<string, unknown> | undefined> {
	const text = await response.text();
	if (Buffer.byteLength(text, "utf8") > MAX_METADATA_BYTES) return undefined;
	try {
		const parsed = JSON.parse(text) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
	} catch {
		return undefined;
	}
}

export const MCP_OAUTH_STORE_DIR = (agentDir: string): string => join(agentDir, "runtime", "mcp", "oauth");
