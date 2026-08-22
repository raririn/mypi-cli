import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { getAgentDir } from "../../src/config.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { probeHttpMcp, suggestServerName, tokenizeCommandLine } from "../../src/product/mcp-command.ts";
import mcpExtension from "../../src/product/mcp.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/mcp-fixture-server.mjs", import.meta.url));

function createHarness() {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	const notices: string[] = [];
	const scripted: { inputs: Array<string | undefined>; selects: Array<string | undefined>; confirms: boolean[] } = { inputs: [], selects: [], confirms: [] };
	let activeTools: string[] = ["read", "mcp_search", "mcp_load", "mcp_read_resource"];
	const selectPrompts: Array<{ title: string; options: string[] }> = [];
	const ctx = {
		cwd: process.cwd(),
		isProjectTrusted: () => true,
		sessionManager: { getBranch: () => [] },
		ui: {
			notify: (message: string) => notices.push(message),
			confirm: async () => scripted.confirms.shift() ?? true,
			input: async () => scripted.inputs.shift(),
			select: async (title: string, options: string[]) => {
				selectPrompts.push({ title, options });
				const wanted = scripted.selects.shift();
				return wanted === undefined ? options[0] : options.find((option) => option.startsWith(wanted));
			},
			editor: async () => {},
		},
	};
	const pi = {
		events: { on: () => () => {}, emit: () => {} },
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		on: (name: string, handler: any) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		getSafetyState: () => ({ effective: "full", enabled: true }),
		getAllTools: () => [...tools.keys(), "read"].map((name) => ({ name })),
		getActiveTools: () => [...activeTools],
		setActiveTools: (next: string[]) => { activeTools = [...next]; },
	} as unknown as ExtensionAPI;
	mcpExtension(pi);
	return { commands, ctx, notices, scripted, selectPrompts };
}

test("command tokenizing and name suggestions are wizard-friendly", () => {
	assert.deepEqual(tokenizeCommandLine('npx -y "@modelcontextprotocol/server-everything" --flag \'a b\''), ["npx", "-y", "@modelcontextprotocol/server-everything", "--flag", "a b"]);
	assert.equal(suggestServerName("https://mcp.linear.app/mcp"), "mcp");
	assert.equal(suggestServerName("https://www.example.com/api/mcp"), "example");
	assert.equal(suggestServerName("/opt/homebrew/bin/mcp-server-everything run"), "everything");
	assert.equal(suggestServerName("npx -y foo"), "npx");
	assert.match(suggestServerName("123weird!!"), /^[a-z][a-z0-9_-]*$/u);
});

test("http probe classifies open, authenticated, and unreachable endpoints", async () => {
	const server = createServer((request, response) => {
		const url = request.url ?? "/";
		if (url === "/open") {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", serverInfo: { name: "probe-fixture" } } }));
		} else if (url === "/sse") {
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "sse-fixture" } } })}\n\n`);
		} else if (url === "/auth") {
			response.writeHead(401, { "www-authenticate": 'Bearer resource_metadata="https://x/.well-known/oauth-protected-resource"' });
			response.end();
		} else {
			response.writeHead(500);
			response.end("boom");
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	try {
		assert.equal((await probeHttpMcp(`${origin}/open`)).serverName, "probe-fixture");
		assert.equal((await probeHttpMcp(`${origin}/sse`)).serverName, "sse-fixture");
		assert.equal((await probeHttpMcp(`${origin}/auth`)).status, "auth");
		assert.equal((await probeHttpMcp(`${origin}/broken`)).status, "unreachable");
		assert.equal((await probeHttpMcp("http://127.0.0.1:9/nothing")).status, "unreachable");
	} finally {
		server.close();
	}
});

test("/mcp add wizard probes a URL, offers auth choices, and persists without touching other config", async () => {
	const server = createServer((_request, response) => {
		response.writeHead(401, { "www-authenticate": "Bearer" });
		response.end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
	const harness = createHarness();
	try {
		// Existing unrelated configuration must survive the wizard byte-for-value.
		const { updateHistoryConfig } = await import("../../src/product/global-config.ts");
		await updateHistoryConfig("maxActive", 42);

		harness.scripted.inputs.push(url, "", "", "");   // target, suggested name, default client name, random redirect port
		harness.scripted.selects.push("OAuth");
		harness.scripted.confirms.push(true);
		await harness.commands.get("mcp").handler("add", harness.ctx);
		assert.match(harness.notices.at(-1) ?? "", /Added MCP server mcp-127-0-0-1|Added MCP server \S+/u);
		assert.equal(harness.selectPrompts[0]!.options.length, 3, "auth choice offered for 401 endpoints");

		const configText = await readFile(join(getAgentDir(), "config.yaml"), "utf8");
		assert.match(configText, /oauth: true/u);
		assert.match(configText, new RegExp(url.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
		assert.match(configText, /maxActive: 42/u, "unrelated configuration is preserved");

		// List shows the server; remove deletes it and preserves history config.
		await harness.commands.get("mcp").handler("", harness.ctx);
		const listed = harness.notices.at(-1) ?? "";
		assert.match(listed, /scope=global/u);
		const serverId = listed.split(" ")[0]!;
		harness.scripted.confirms.push(true);
		await harness.commands.get("mcp").handler(`remove ${serverId}`, harness.ctx);
		const afterRemove = await readFile(join(getAgentDir(), "config.yaml"), "utf8");
		assert.doesNotMatch(afterRemove, /oauth: true/u);
		assert.match(afterRemove, /maxActive: 42/u);
	} finally {
		server.close();
	}
});

test("/mcp add configures a stdio command line and /mcp test reaches its live catalog", async () => {
	const harness = createHarness();
	harness.scripted.inputs.push("fixture");            // accept name prompt with explicit value
	harness.scripted.confirms.push(true);
	await harness.commands.get("mcp").handler(`add ${process.execPath} ${FIXTURE}`, harness.ctx);
	// "add <name> <target>" form: name=execPath invalid -> fall back to two-token direct form check
	if (!(harness.notices.at(-1) ?? "").includes("Added")) {
		harness.scripted.inputs.length = 0;
		harness.scripted.inputs.push(`"${process.execPath}" "${FIXTURE}"`, "fixture");
		harness.scripted.confirms.push(true);
		await harness.commands.get("mcp").handler("add", harness.ctx);
	}
	assert.match(harness.notices.at(-1) ?? "", /Added MCP server fixture/u);
	const configText = await readFile(join(getAgentDir(), "config.yaml"), "utf8");
	assert.match(configText, /fixture:/u);

	await harness.commands.get("mcp").handler("test fixture", harness.ctx);
	assert.match(harness.notices.at(-1) ?? "", /fixture is reachable: \d+ tool\(s\)/u);
	assert.match(harness.notices.at(-1) ?? "", /echo/u);

	harness.scripted.confirms.push(true);
	await harness.commands.get("mcp").handler("remove fixture", harness.ctx);
	assert.match(harness.notices.at(-1) ?? "", /Removed MCP server fixture/u);
});
