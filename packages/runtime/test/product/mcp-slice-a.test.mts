import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildChildEnv, mergeMcpConfigs, parseMcpConfig, ruleAllows } from "../../src/core/mcp/config.ts";
import { JsonRpcReader, encodeMessage } from "../../src/core/mcp/protocol.ts";
import { canonicalJson, exposedToolName, normalizeToolSchema, schemaFingerprint } from "../../src/core/mcp/schema.ts";
import { evaluateMcpAction, type McpPolicyState } from "../../src/core/mcp/policy.ts";
import { convertCallResult } from "../../src/core/mcp/result.ts";
import { McpManager } from "../../src/core/mcp/manager.ts";
import { McpError, type McpConfig, type McpServerConfig } from "../../src/core/mcp/types.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/mcp-fixture-server.mjs", import.meta.url));

function fixtureServer(overrides: Partial<McpServerConfig> = {}, fixtureArgs: string[] = []): McpServerConfig {
	return {
		serverId: "fixture",
		enabled: true,
		description: "Adversarial fixture server",
		command: process.execPath,
		args: [FIXTURE, ...fixtureArgs],
		cwd: "workspace",
		env: {},
		passEnv: [],
		required: false,
		startupTimeoutMs: 8_000,
		callTimeoutMs: 8_000,
		allowUntrustedProjects: false,
		toolAllow: ["*"],
		toolDeny: [],
		toolPolicy: {
			echo: { effect: "read", allowInPlan: true },
			write_note: { effect: "mutate", allowInPlan: false },
		},
		resourceAllow: ["*"],
		resourceDeny: [],
		configScope: "global",
		...overrides,
	};
}

function managerFor(
	server: McpServerConfig,
	state: Partial<McpPolicyState> = {},
	options: { approve?: (summary: string) => Promise<boolean>; taken?: Set<string> } = {},
): McpManager {
	const config: McpConfig = { servers: new Map([[server.serverId, server]]) };
	return new McpManager(config, {
		workspaceCwd: process.cwd(),
		clientInfo: { name: "mypi-test", version: "0.0.0" },
		policyState: () => ({ safetyMode: "full", planning: false, projectTrusted: true, ...state }),
		...(options.approve ? { approve: options.approve } : {}),
		...(options.taken ? { takenToolNames: () => options.taken! } : {}),
	});
}

test("mcp config parsing validates IDs, scopes, rules, and secret literals", () => {
	const parsed = parseMcpConfig({
		servers: {
			good: { command: "/usr/bin/true", toolPolicy: { fetch: { effect: "read", allowInPlan: true } } },
			"Bad ID": { command: "/usr/bin/true" },
			relative: { command: "/usr/bin/true", cwd: "relative/path" },
			secret: { command: "/usr/bin/true", env: { TOKEN: "sk-" + "a".repeat(24) } },
			badrule: { command: "/usr/bin/true", toolAllow: ["prefix*"] },
		},
	}, "global");
	assert.deepEqual([...parsed.config.servers.keys()], ["good"]);
	assert.equal(parsed.config.servers.get("good")!.startupTimeoutMs, 10_000);
	assert.equal(parsed.config.servers.get("good")!.callTimeoutMs, 60_000);
	assert.equal(parsed.config.servers.get("good")!.allowUntrustedProjects, false);
	assert.equal(parsed.diagnostics.length, 4);
	assert.match(parsed.diagnostics.map((d) => d.message).join("\n"), /credential/u);

	const project = parseMcpConfig({ servers: { proj: { command: "/usr/bin/true", cwd: "/abs" } } }, "project");
	assert.equal(project.config.servers.size, 0, "project scope cannot select absolute cwd");

	const merged = mergeMcpConfigs(
		parseMcpConfig({ servers: { shared: { command: "/global" }, only: { command: "/g2" } } }, "global").config,
		parseMcpConfig({ servers: { shared: { command: "/project" } } }, "project").config,
	);
	assert.equal(merged.servers.get("shared")!.command, "/project", "project record atomically replaces the global ID");
	assert.equal(merged.servers.get("shared")!.configScope, "project");
	assert.equal(merged.servers.get("only")!.command, "/g2");

	assert.equal(ruleAllows(["*"], ["deny_me"], "deny_me"), false, "deny wins over allow");
	assert.equal(ruleAllows(["only"], [], "other"), false);
});

test("mcp child environment is minimal, literal, and exact-passEnv only", () => {
	const server = fixtureServer({ env: { LITERAL: "yes" }, passEnv: ["MYPI_TEST_MCP_TOKEN"] });
	const env = buildChildEnv(server, { PATH: "/bin", HOME: "/home/u", MYPI_TEST_MCP_TOKEN: "tok", OPENAI_API_KEY: "leak" });
	assert.equal(env.LITERAL, "yes");
	assert.equal(env.MYPI_TEST_MCP_TOKEN, "tok");
	assert.equal(env.OPENAI_API_KEY, undefined, "the complete host environment is never inherited");
	assert.throws(() => buildChildEnv(server, { PATH: "/bin" }), /passEnv variable is not set/u);
});

test("json-rpc framing enforces newline delimiting and hard bounds", () => {
	const reader = new JsonRpcReader("s");
	const messages = reader.push(Buffer.concat([
		encodeMessage({ jsonrpc: "2.0", id: 1, method: "a", params: {} }),
		Buffer.from('{"jsonrpc":"2.0","id":2,"result":{}}\n'),
	]));
	assert.equal(messages.length, 2);
	assert.throws(() => reader.push("not json\n"), /non-JSON/u);
	const big = new JsonRpcReader("s");
	assert.throws(() => big.push(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "x", params: { blob: "y".repeat(4 * 1024 * 1024) } })}\n`), /4 MiB/u);
});

test("schema normalization and exposed names are bounded and deterministic", () => {
	assert.equal(normalizeToolSchema({ type: "object", properties: { a: { type: "string" } } }).ok, true);
	assert.equal(normalizeToolSchema({ type: "array" }).ok, false);
	assert.equal(normalizeToolSchema({ type: "object", $ref: "#/x" }).ok, false);
	let deep: Record<string, unknown> = { type: "object" };
	for (let index = 0; index < 20; index++) deep = { type: "object", properties: { nest: deep } };
	assert.equal(normalizeToolSchema(deep).ok, false);

	assert.equal(exposedToolName("obscura", "fetch"), "mcp_obscura_fetch");
	const normalized = exposedToolName("obscura", "weird/na me");
	assert.match(normalized, /^mcp_obscura_weird_na_me_[0-9a-f]{8}$/u);
	assert.equal(normalized, exposedToolName("obscura", "weird/na me"), "deterministic across calls");
	assert.ok(exposedToolName("srv", "x".repeat(200)).length <= 64);

	assert.equal(
		schemaFingerprint({ a: 1, b: { c: 2, d: 3 } }),
		schemaFingerprint(JSON.parse('{"b":{"d":3,"c":2},"a":1}')),
		"fingerprints ignore key order",
	);
	assert.equal(canonicalJson([1, { b: 2, a: 1 }]), '[1,{"a":1,"b":2}]');
});

test("the policy matrix intersects safety, read modes, planning, and trust", () => {
	const server = fixtureServer();
	const projectServer = fixtureServer({ serverId: "proj", configScope: "project" });
	const readTool = { remoteName: "echo", effect: "read" as const, allowInPlan: true };
	const mutateTool = { remoteName: "write_note", effect: "mutate" as const, allowInPlan: false };
	const unknownTool = { remoteName: "mystery", effect: "unknown" as const, allowInPlan: false };
	const base: McpPolicyState = { safetyMode: "full", planning: false, projectTrusted: true };

	assert.equal(evaluateMcpAction("call", server, base, mutateTool).allow, true);
	assert.equal(evaluateMcpAction("start", server, { ...base, safetyMode: "safe" }).allow, false);
	assert.equal(evaluateMcpAction("start", server, { ...base, safetyMode: "sandbox" }).allow, false);
	assert.deepEqual(evaluateMcpAction("call", server, { ...base, safetyMode: "ask" }, readTool), { allow: true, requireApproval: true });
	assert.deepEqual(evaluateMcpAction("call", server, { ...base, safetyMode: "sandbox-ask" }, readTool), { allow: true, requireApproval: true });
	assert.equal(evaluateMcpAction("call", server, { ...base, accessMode: "readonly" }, readTool).allow, true);
	assert.equal(evaluateMcpAction("call", server, { ...base, accessMode: "readonly" }, mutateTool).allow, false);
	assert.equal(evaluateMcpAction("call", server, { ...base, accessMode: "readonly" }, unknownTool).allow, false, "unknown fails closed");
	assert.equal(evaluateMcpAction("start", server, { ...base, accessMode: "noread" }).allow, false);
	assert.equal(evaluateMcpAction("call", server, { ...base, planning: true }, readTool).allow, true);
	assert.equal(evaluateMcpAction("call", server, { ...base, planning: true }, { ...readTool, allowInPlan: false }).allow, false);
	assert.equal(evaluateMcpAction("read-resource", server, { ...base, accessMode: "readonly" }).allow, true);
	assert.equal(evaluateMcpAction("start", projectServer, { ...base, projectTrusted: false }).allow, false);
	assert.equal(evaluateMcpAction("start", server, { ...base, projectTrusted: false }).allow, false);
	assert.equal(
		evaluateMcpAction("start", fixtureServer({ allowUntrustedProjects: true }), { ...base, projectTrusted: false }).allow,
		true,
	);
});

test("result conversion frames untrusted content, bounds it, and reports omissions", () => {
	const converted = convertCallResult("srv", "tool", [
		{ type: "text", text: `token sk-${"a".repeat(24)} end` },
		{ type: "image", data: "aGk=", mimeType: "image/png" },
		{ type: "image", data: "aGk=", mimeType: "image/tiff" },
		{ type: "audio", data: "aGk=", mimeType: "audio/wav" },
		{ type: "resource", resource: { uri: "fixture://x", text: "embedded" } },
		{ type: "resource_link", uri: "fixture://linked" },
	], true);
	assert.equal(converted.content[0], converted.content.find((part) => part.type === "text"));
	assert.match((converted.content[0] as { text: string }).text, /^\[Untrusted MCP content: srv\/tool\]$/u);
	assert.match((converted.content[1] as { text: string }).text, /\[REDACTED\]/u);
	assert.equal(converted.content.filter((part) => part.type === "image").length, 1);
	assert.deepEqual(converted.omitted.map((part) => part.type), ["image", "audio"]);
	assert.match((converted.content.at(-1) as { text: string }).text, /not followed/u);
	assert.equal(converted.isError, true);

	const huge = convertCallResult("srv", "tool", [{ type: "text", text: "y".repeat(200 * 1024) }], false);
	assert.match((huge.content[1] as { text: string }).text, /\[truncated by MyPi\]$/u);
});

test("lazy catalog, load, call, and unsupported-callback rejection against a live fixture server", async () => {
	const manager = managerFor(fixtureServer({}, ["--client-request-probe"]));
	try {
		const staticSearch = await manager.search({});
		assert.deepEqual(staticSearch.records.map((record) => record.kind), ["server"], "static search starts no process");
		assert.deepEqual(manager.status()[0]!.state, "cold");

		const live = await manager.search({ server: "fixture", kind: "tool" });
		const names = live.records.map((record) => record.name);
		assert.ok(names.includes("echo") && names.includes("weird/na me"));
		assert.ok(!names.includes("bad_schema"), "schema-rejected tools stay out of the catalog");
		assert.equal(live.records.find((record) => record.name === "echo")!.detail, "effect=read");

		await assert.rejects(manager.load({ server: "fixture", tools: ["bad_schema"] }), /excluded/u);
		await assert.rejects(manager.load({ server: "fixture", tools: ["nope"] }), /does not advertise/u);

		const loaded = await manager.load({ server: "fixture", tools: ["echo", "client_probe"] });
		assert.equal(loaded[0]!.exposedName, "mcp_fixture_echo");
		assert.match(loaded[0]!.description, /untrusted external description/u);

		const echoed = await manager.callTool("mcp_fixture_echo", { text: "hi" });
		assert.equal((echoed.content[0] as { text: string }).text, "[Untrusted MCP content: fixture/echo]");
		assert.equal((echoed.content[1] as { text: string }).text, "echo: hi");

		const probe = await manager.callTool("mcp_fixture_client_probe", {});
		assert.match((probe.content[1] as { text: string }).text, /client-rejected-sampling=true/u, "server-to-client requests get a typed -32601");

		const resource = await manager.readResource({ server: "fixture", uri: "fixture://notes/readme" });
		assert.match((resource.content[1] as { text: string }).text, /contents of fixture:\/\/notes\/readme/u);
		const templated = await manager.readResource({ server: "fixture", uri: "fixture://notes/42" });
		assert.match((templated.content[1] as { text: string }).text, /contents of fixture:\/\/notes\/42/u);
		await assert.rejects(manager.readResource({ server: "fixture", uri: "other://x" }), /cataloged/u);

		await assert.rejects(manager.callTool("mcp_fixture_echo", { text: `sk-${"b".repeat(24)}` }), /credential/u);
	} finally {
		await manager.shutdown();
	}
});

test("configured deny rules, approval gating, and name collisions fail closed", async () => {
	const denied = managerFor(fixtureServer({ toolDeny: ["write_note"] }));
	try {
		const catalog = await denied.search({ server: "fixture", kind: "tool" });
		assert.ok(!catalog.records.some((record) => record.name === "write_note"));
		await assert.rejects(denied.load({ server: "fixture", tools: ["write_note"] }), /allow\/deny/u);
	} finally {
		await denied.shutdown();
	}

	const approvals: string[] = [];
	const asked = managerFor(fixtureServer(), { safetyMode: "ask" }, { approve: async (summary) => { approvals.push(summary); return true; } });
	try {
		await asked.load({ server: "fixture", tools: ["echo"] });
		await asked.callTool("mcp_fixture_echo", { text: "ok" });
		assert.ok(approvals[0]!.includes("Start MCP server fixture"), "one session-scoped start approval");
		assert.ok(approvals.some((summary) => summary.includes("Call MCP tool echo")), "per-call approval");
		assert.ok(approvals.every((summary) => summary.includes("outside the Bash sandbox")));
	} finally {
		await asked.shutdown();
	}

	const headless = managerFor(fixtureServer(), { safetyMode: "ask" });
	await assert.rejects(headless.search({ server: "fixture" }), /cannot ask/u);
	await headless.shutdown();

	const collided = managerFor(fixtureServer(), {}, { taken: new Set(["mcp_fixture_echo"]) });
	try {
		await assert.rejects(collided.load({ server: "fixture", tools: ["echo"] }), /collides|never overrides/u);
	} finally {
		await collided.shutdown();
	}
});

test("safe mode, no-read, and planning block live MCP through the manager gate", async () => {
	const safe = managerFor(fixtureServer(), { safetyMode: "safe" });
	await assert.rejects(safe.search({ server: "fixture" }), /Safe mode/u);
	await safe.shutdown();

	const noread = managerFor(fixtureServer(), { accessMode: "noread" });
	const staticOnly = await noread.search({});
	assert.equal(staticOnly.records.length, 1, "static IDs remain searchable");
	await assert.rejects(noread.search({ server: "fixture" }), /no-read/u);
	await noread.shutdown();

	const planning = managerFor(fixtureServer(), { planning: true });
	try {
		await planning.load({ server: "fixture", tools: ["echo", "write_note"] });
		const allowed = await planning.callTool("mcp_fixture_echo", { text: "plan" });
		assert.equal((allowed.content[1] as { text: string }).text, "echo: plan");
		await assert.rejects(planning.callTool("mcp_fixture_write_note", { path: "a", text: "b" }), /allowInPlan/u);
	} finally {
		await planning.shutdown();
	}
});

test("timeouts cancel then recycle, crashes fail pending calls, and oversized frames reject", { timeout: 30_000 }, async () => {
	const slow = managerFor(fixtureServer({ callTimeoutMs: 1_000 }, ["--slow-tool", "60000", "--no-cancel-ack"]));
	try {
		await slow.load({ server: "fixture", tools: ["echo"] });
		await assert.rejects(slow.callTool("mcp_fixture_echo", { text: "never" }), (error: unknown) => {
			assert.ok(error instanceof McpError);
			assert.equal(error.code, "MCP_TIMEOUT");
			return true;
		});
		assert.equal(slow.status()[0]!.state, "failed", "unsettled cancellation recycles the connection");
	} finally {
		await slow.shutdown();
	}

	const crashy = managerFor(fixtureServer({}, ["--crash-on-call"]));
	try {
		await crashy.load({ server: "fixture", tools: ["echo"] });
		await assert.rejects(crashy.callTool("mcp_fixture_echo", { text: "boom" }), /exited/u);
	} finally {
		await crashy.shutdown();
	}

	const oversized = managerFor(fixtureServer({}, ["--oversized-list"]));
	try {
		await assert.rejects(oversized.search({ server: "fixture" }), /4 MiB|closing|exited/u);
	} finally {
		await oversized.shutdown();
	}

	const wrong = managerFor(fixtureServer({}, ["--wrong-protocol"]));
	try {
		await assert.rejects(wrong.search({ server: "fixture" }), /unsupported protocol/u);
	} finally {
		await wrong.shutdown();
	}
});

test("shutdown terminates the server process tree and pagination stays bounded", { timeout: 30_000 }, async () => {
	const paginated = managerFor(fixtureServer({}, ["--paginate", "3"]));
	let pid: number | undefined;
	try {
		const catalog = await paginated.search({ server: "fixture", kind: "tool", limit: 50 });
		assert.ok(catalog.records.some((record) => record.name === "echo"), "paginated catalogs collect across pages");
		pid = (paginated as unknown as { connections: Map<string, { transport?: { pid?: number } }> })
			.connections.get("fixture")?.transport?.pid;
		assert.ok(typeof pid === "number");
	} finally {
		await paginated.shutdown();
	}
	await new Promise((resolve) => setTimeout(resolve, 200));
	assert.throws(() => process.kill(pid!, 0), "the fixture process is gone after shutdown");
});
