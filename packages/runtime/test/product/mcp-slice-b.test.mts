import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { getAgentDir } from "../../src/config.ts";
import { parseMcpConfig } from "../../src/core/mcp/config.ts";
import { McpManager } from "../../src/core/mcp/manager.ts";
import { McpError, type McpConfig, type McpServerConfig } from "../../src/core/mcp/types.ts";

interface HttpFixtureOptions {
	requireBearer?: string;
	oauth?: boolean;
	sse?: boolean;
}

interface HttpFixture {
	server: Server;
	url: string;
	origin: string;
	issued: { accessTokens: string[]; refreshUsed: number; registrations: number };
	close: () => Promise<void>;
}

async function startHttpFixture(options: HttpFixtureOptions = {}): Promise<HttpFixture> {
	const issued = { accessTokens: [] as string[], refreshUsed: 0, registrations: 0 };
	const codes = new Map<string, { challenge: string }>();
	let origin = "";
	const valid = () => options.requireBearer ?? issued.accessTokens.at(-1);

	const server = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => { body += chunk.toString(); });
		request.on("end", () => {
			const url = new URL(request.url ?? "/", origin);
			if (url.pathname === "/.well-known/oauth-protected-resource") {
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ["internal"] }));
				return;
			}
			if (url.pathname === "/.well-known/oauth-authorization-server") {
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({
					issuer: origin,
					authorization_endpoint: `${origin}/authorize`,
					token_endpoint: `${origin}/token`,
					registration_endpoint: `${origin}/register`,
				}));
				return;
			}
			if (url.pathname === "/register") {
				issued.registrations += 1;
				response.writeHead(201, { "content-type": "application/json" });
				response.end(JSON.stringify({ client_id: "dyn-client-1" }));
				return;
			}
			if (url.pathname === "/authorize") {
				const redirect = new URL(url.searchParams.get("redirect_uri")!);
				const code = `code-${codes.size + 1}`;
				codes.set(code, { challenge: url.searchParams.get("code_challenge")! });
				redirect.searchParams.set("code", code);
				redirect.searchParams.set("state", url.searchParams.get("state")!);
				response.writeHead(302, { location: redirect.toString() });
				response.end();
				return;
			}
			if (url.pathname === "/token") {
				const form = new URLSearchParams(body);
				if (form.get("grant_type") === "refresh_token") {
					if (form.get("refresh_token") !== "refresh-1") {
						response.writeHead(400, { "content-type": "application/json" });
						response.end(JSON.stringify({ error: "invalid_grant" }));
						return;
					}
					issued.refreshUsed += 1;
				} else {
					const grant = codes.get(form.get("code") ?? "");
					const expected = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
					if (!grant || grant.challenge !== expected || form.get("client_id") !== "dyn-client-1") {
						response.writeHead(400, { "content-type": "application/json" });
						response.end(JSON.stringify({ error: "invalid_grant" }));
						return;
					}
				}
				const accessToken = `at-${issued.accessTokens.length + 1}`;
				issued.accessTokens.push(accessToken);
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ access_token: accessToken, token_type: "Bearer", expires_in: 3600, refresh_token: "refresh-1" }));
				return;
			}
			if (url.pathname !== "/mcp") {
				response.writeHead(404).end();
				return;
			}
			if (request.method === "DELETE") {
				response.writeHead(204).end();
				return;
			}
			if ((options.requireBearer || options.oauth) && request.headers.authorization !== `Bearer ${valid()}`) {
				response.writeHead(401, {
					"content-type": "application/json",
					"www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
				});
				response.end(JSON.stringify({ error: "unauthorized" }));
				return;
			}
			const message = JSON.parse(body);
			const reply = (result: Record<string, unknown>) => {
				const payload = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
				if (options.sse) {
					response.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "session-1" });
					response.end(`event: message\ndata: ${payload}\n\n`);
				} else {
					response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "session-1" });
					response.end(payload);
				}
			};
			if (message.id === undefined) {
				response.writeHead(202).end();
				return;
			}
			if (message.method === "initialize") {
				reply({
					protocolVersion: message.params.protocolVersion,
					capabilities: { tools: {} },
					serverInfo: { name: "http-fixture", version: "1.0.0" },
				});
			} else if (message.method === "tools/list") {
				reply({ tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] });
			} else if (message.method === "tools/call") {
				reply({ content: [{ type: "text", text: `echo: ${message.params.arguments.text}` }], isError: false });
			} else {
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "nope" } }));
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	origin = `http://127.0.0.1:${address.port}`;
	return {
		server,
		url: `${origin}/mcp`,
		origin,
		issued,
		close: () => new Promise((resolve) => server.close(() => resolve())),
	};
}

function httpServerConfig(url: string, overrides: Partial<McpServerConfig> = {}): McpServerConfig {
	return {
		serverId: "httpfixture",
		enabled: true,
		description: "http fixture",
		transport: "http",
		url,
		command: "",
		args: [],
		cwd: "workspace",
		env: {},
		passEnv: [],
		required: false,
		startupTimeoutMs: 8_000,
		callTimeoutMs: 8_000,
		allowUntrustedProjects: false,
		toolAllow: ["*"],
		toolDeny: [],
		toolPolicy: { echo: { effect: "read", allowInPlan: true } },
		resourceAllow: ["*"],
		resourceDeny: [],
		configScope: "global",
		...overrides,
	};
}

function managerFor(server: McpServerConfig, options: { authorize?: (url: string) => Promise<void> } = {}): McpManager {
	const config: McpConfig = { servers: new Map([[server.serverId, server]]) };
	return new McpManager(config, {
		workspaceCwd: process.cwd(),
		agentDir: getAgentDir(),
		clientInfo: { name: "mypi-test", version: "0.0.0" },
		policyState: () => ({ safetyMode: "full", planning: false, projectTrusted: true }),
		...(options.authorize ? { authorize: options.authorize } : {}),
	});
}

test("http transport config validation requires https-or-loopback and separates auth modes", () => {
	const parsed = parseMcpConfig({
		servers: {
			good: { transport: "http", url: "https://example.com/mcp" },
			loop: { transport: "http", url: "http://127.0.0.1:8080/mcp" },
			plain: { transport: "http", url: "http://example.com/mcp" },
			creds: { transport: "http", url: "https://user:pw@example.com/mcp" },
			both: { transport: "http", url: "https://example.com/mcp", authBearerEnv: "T", oauth: true },
			mixed: { transport: "http", url: "https://example.com/mcp", command: "/bin/true" },
			stray: { command: "/bin/true", oauth: true },
		},
	}, "global");
	assert.deepEqual([...parsed.config.servers.keys()], ["good", "loop"]);
	assert.equal(parsed.config.servers.get("good")!.transport, "http");
	assert.equal(parsed.diagnostics.length, 5);
	const oauthParsed = parseMcpConfig({
		servers: { o: { transport: "http", url: "https://example.com/mcp", oauth: { clientId: "c", scopes: ["read:user"] } } },
	}, "global");
	assert.deepEqual(oauthParsed.config.servers.get("o")!.oauth, { clientId: "c", scopes: ["read:user"] });
});

test("streamable http transport lists and calls tools over JSON and SSE bodies", async () => {
	for (const sse of [false, true]) {
		const fixture = await startHttpFixture({ sse });
		const manager = managerFor(httpServerConfig(fixture.url));
		try {
			const catalog = await manager.search({ server: "httpfixture", kind: "tool" });
			assert.deepEqual(catalog.records.map((record) => record.name), ["echo"], `sse=${sse}`);
			await manager.load({ server: "httpfixture", tools: ["echo"] });
			const result = await manager.callTool("mcp_httpfixture_echo", { text: "hi" });
			assert.equal((result.content[1] as { text: string }).text, "echo: hi");
		} finally {
			await manager.shutdown();
			await fixture.close();
		}
	}
});

test("bearer-token indirection reads the exact env variable and fails closed", async () => {
	const fixture = await startHttpFixture({ requireBearer: "sekrit-token" });
	const key = "MYPI_TEST_MCP_BEARER";
	try {
		process.env[key] = "sekrit-token";
		const manager = managerFor(httpServerConfig(fixture.url, { authBearerEnv: key }));
		const catalog = await manager.search({ server: "httpfixture", kind: "tool" });
		assert.deepEqual(catalog.records.map((record) => record.name), ["echo"]);
		await manager.shutdown();

		process.env[key] = "wrong-token";
		const rejected = managerFor(httpServerConfig(fixture.url, { authBearerEnv: key }));
		await assert.rejects(rejected.search({ server: "httpfixture" }), (error: unknown) => {
			assert.ok(error instanceof McpError);
			assert.equal(error.code, "MCP_AUTH_FAILED");
			return true;
		});
		await rejected.shutdown();

		delete process.env[key];
		const missing = managerFor(httpServerConfig(fixture.url, { authBearerEnv: key }));
		await assert.rejects(missing.search({ server: "httpfixture" }), /is not set on this host/u);
		await missing.shutdown();
	} finally {
		delete process.env[key];
		await fixture.close();
	}
});

test("oauth discovery, registration, PKCE, token storage, and cached reuse", { timeout: 30_000 }, async () => {
	const fixture = await startHttpFixture({ oauth: true });
	const authorizations: string[] = [];
	const authorize = async (url: string) => {
		authorizations.push(url);
		const response = await fetch(url, { redirect: "follow" });
		assert.equal(response.status, 200);
	};
	const server = httpServerConfig(fixture.url, { oauth: { scopes: ["read:user"] } });
	const manager = managerFor(server, { authorize });
	try {
		const catalog = await manager.search({ server: "httpfixture", kind: "tool" });
		assert.deepEqual(catalog.records.map((record) => record.name), ["echo"]);
		assert.equal(authorizations.length, 1, "one interactive authorization");
		assert.match(authorizations[0]!, /code_challenge_method=S256/u);
		assert.match(authorizations[0]!, /resource=/u);
		assert.match(authorizations[0]!, /scope=read%3Auser/u);
		assert.equal(fixture.issued.registrations, 1, "dynamic client registration ran once");

		const storePath = join(getAgentDir(), "runtime", "mcp", "oauth", "httpfixture.json");
		const stored = JSON.parse(await readFile(storePath, "utf8"));
		assert.equal(stored.accessToken, fixture.issued.accessTokens.at(-1));
		assert.equal(stored.refreshToken, "refresh-1");
		if (process.platform !== "win32") assert.equal((await stat(storePath)).mode & 0o777, 0o600);
	} finally {
		await manager.shutdown();
	}

	// A fresh manager reuses the stored token without any interactive flow.
	const cached = managerFor(server, {
		authorize: async () => {
			throw new Error("cached token must be used; no authorization expected");
		},
	});
	try {
		const catalog = await cached.search({ server: "httpfixture", kind: "tool" });
		assert.deepEqual(catalog.records.map((record) => record.name), ["echo"]);
	} finally {
		await cached.shutdown();
		await fixture.close();
	}
});

test("oauth defaults to advertised scopes, reuses the registered client, and outlives the startup timeout", { timeout: 40_000 }, async () => {
	const fixture = await startHttpFixture({ oauth: true });
	const { rm } = await import("node:fs/promises");
	const authorizations: string[] = [];
	// The redirect follow is deliberately slower than the connection startup
	// timeout: the interactive flow must run under the authorization budget.
	const authorize = async (url: string) => {
		authorizations.push(url);
		await new Promise((resolve) => setTimeout(resolve, 2_600));
		const response = await fetch(url, { redirect: "follow" });
		assert.equal(response.status, 200);
	};
	const server = httpServerConfig(fixture.url, { serverId: "oauthreuse", oauth: { scopes: [] }, startupTimeoutMs: 1_500 });
	const first = managerFor(server, { authorize });
	try {
		const catalog = await first.search({ server: "oauthreuse", kind: "tool" });
		assert.deepEqual(catalog.records.map((record) => record.name), ["echo"], "slow authorization still beats the startup timeout");
		assert.match(authorizations[0]!, /scope=internal/u, "unconfigured scopes default to the resource metadata");
	} finally {
		await first.shutdown();
	}

	// Drop only the tokens: the next acquisition reuses the persisted dynamic
	// client and its registered redirect port instead of registering again.
	await rm(join(getAgentDir(), "runtime", "mcp", "oauth", "oauthreuse.json"), { force: true });
	const second = managerFor(server, { authorize });
	try {
		await second.search({ server: "oauthreuse", kind: "tool" });
	} finally {
		await second.shutdown();
		await fixture.close();
	}
	assert.equal(fixture.issued.registrations, 1, "dynamic client registration happens once across acquisitions");
	assert.equal(authorizations.length, 2);
	const portOf = (url: string) => new URL(new URL(url).searchParams.get("redirect_uri")!).port;
	assert.equal(portOf(authorizations[0]!), portOf(authorizations[1]!), "the registered redirect port is pinned and reused");
});

test("oauth without an authorization surface fails closed with MCP_AUTH_REQUIRED", async () => {
	const fixture = await startHttpFixture({ oauth: true });
	const manager = managerFor(httpServerConfig(fixture.url, { serverId: "headlessoauth", oauth: { scopes: [] } }));
	try {
		await assert.rejects(manager.search({ server: "headlessoauth" }), (error: unknown) => {
			assert.ok(error instanceof McpError);
			assert.equal(error.code, "MCP_AUTH_REQUIRED");
			return true;
		});
	} finally {
		await manager.shutdown();
		await fixture.close();
	}
});
