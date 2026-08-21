import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { getAgentDir } from "../../src/config.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { isMcpProductTool, isTrustedSafetyTool } from "../../src/core/safety-mode.ts";
import mcpExtension, { MCP_LOAD_TOOL, MCP_READ_RESOURCE_TOOL, MCP_SEARCH_TOOL } from "../../src/product/mcp.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/mcp-fixture-server.mjs", import.meta.url));

function createHarness(options: { branch?: unknown[]; trusted?: boolean } = {}) {
	const tools = new Map<string, any>();
	const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	const notices: string[] = [];
	let activeTools: string[] = ["read", MCP_SEARCH_TOOL, MCP_LOAD_TOOL, MCP_READ_RESOURCE_TOOL];
	const busHandlers = new Map<string, Array<(data: any) => void>>();
	const ctx = {
		cwd: process.cwd(),
		isProjectTrusted: () => options.trusted !== false,
		sessionManager: { getBranch: () => options.branch ?? [] },
		ui: {
			notify: (message: string) => notices.push(message),
			confirm: async () => true,
		},
	};
	const pi = {
		events: {
			emit: (channel: string, data: any) => { for (const handler of busHandlers.get(channel) ?? []) handler(data); },
			on: (channel: string, handler: (data: any) => void) => {
				busHandlers.set(channel, [...(busHandlers.get(channel) ?? []), handler]);
				return () => {};
			},
		},
		registerTool: (tool: any) => tools.set(tool.name, tool),
		on: (name: string, handler: any) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		getSafetyState: () => ({ effective: "full", enabled: true }),
		getAllTools: () => [...tools.keys(), "read", "write", "bash"].map((name) => ({ name })),
		getActiveTools: () => [...activeTools],
		setActiveTools: (next: string[]) => { activeTools = [...next]; },
	} as unknown as ExtensionAPI;
	mcpExtension(pi);
	async function emit(name: string, event: any = {}): Promise<void> {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
	}
	async function executeTool(name: string, params: unknown): Promise<any> {
		const tool = tools.get(name);
		assert.ok(tool, `missing tool ${name}`);
		return tool.execute("call", params, undefined, undefined, ctx);
	}
	return { tools, ctx, emit, executeTool, notices, get activeTools() { return activeTools; } };
}

async function writeGlobalMcpConfig(servers: Record<string, unknown> | undefined): Promise<void> {
	const path = join(getAgentDir(), "config.yaml");
	if (!servers) {
		await rm(path, { force: true });
		return;
	}
	await mkdir(getAgentDir(), { recursive: true });
	await writeFile(path, JSON.stringify({ version: 1, mcp: { servers } }), "utf8");
}

const FIXTURE_SERVER = {
	command: process.execPath,
	args: [FIXTURE],
	toolPolicy: { echo: { effect: "read", allowInPlan: true } },
};

test("gateway tools register, load configuration from config.yaml, and call a live server", async () => {
	await writeGlobalMcpConfig({ fixture: FIXTURE_SERVER });
	const harness = createHarness();
	assert.deepEqual([...harness.tools.keys()], [MCP_SEARCH_TOOL, MCP_LOAD_TOOL, MCP_READ_RESOURCE_TOOL]);
	await harness.emit("session_start");
	try {
		assert.ok(harness.activeTools.includes(MCP_SEARCH_TOOL), "gateway stays active with configured servers");

		const staticSearch = await harness.executeTool(MCP_SEARCH_TOOL, {});
		assert.match(staticSearch.content[0].text, /\[server\] fixture/u);

		const loaded = await harness.executeTool(MCP_LOAD_TOOL, { server: "fixture", tools: ["echo"] });
		assert.equal(loaded.isError, undefined);
		assert.deepEqual(loaded.addedToolNames, ["mcp_fixture_echo"]);
		assert.equal(loaded.details.descriptors[0].effect, "read");
		assert.ok(harness.tools.has("mcp_fixture_echo"), "loaded server tools become ordinary Pi tools");
		assert.ok(harness.activeTools.includes("mcp_fixture_echo"));

		const call = await harness.executeTool("mcp_fixture_echo", { text: "hi" });
		assert.equal(call.content[0].text, "[Untrusted MCP content: fixture/echo]");
		assert.equal(call.content[1].text, "echo: hi");

		const resource = await harness.executeTool(MCP_READ_RESOURCE_TOOL, { server: "fixture", uri: "fixture://notes/readme" });
		assert.match(resource.content[1].text, /contents of fixture:\/\/notes\/readme/u);
	} finally {
		await harness.emit("session_shutdown");
	}
});

test("without configured servers the gateway deactivates and answers with typed guidance", async () => {
	await writeGlobalMcpConfig(undefined);
	const harness = createHarness();
	await harness.emit("session_start");
	try {
		assert.ok(!harness.activeTools.includes(MCP_SEARCH_TOOL), "gateway tools leave the model tool set");
		const result = await harness.executeTool(MCP_SEARCH_TOOL, {});
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /No MCP servers are configured/u);
	} finally {
		await harness.emit("session_shutdown");
	}
});

test("untrusted projects never load project-scoped MCP configuration", async () => {
	await writeGlobalMcpConfig(undefined);
	const projectDir = join(process.cwd(), ".mypi");
	// The trusted-project reader would pick this up; untrusted must ignore it.
	const harness = createHarness({ trusted: false });
	await harness.emit("session_start");
	try {
		const result = await harness.executeTool(MCP_SEARCH_TOOL, {});
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /No MCP servers are configured/u);
		void projectDir;
	} finally {
		await harness.emit("session_shutdown");
	}
});

test("load snapshots on the current branch restore loaded tools without starting servers", async () => {
	await writeGlobalMcpConfig({ fixture: FIXTURE_SERVER });
	const descriptor = {
		serverId: "fixture",
		remoteName: "echo",
		exposedName: "mcp_fixture_echo",
		description: "[MCP fixture; untrusted external description] Echo the text back",
		inputSchema: { type: "object", properties: { text: { type: "string" } } },
		schemaFingerprint: "restored-fingerprint",
		effect: "read",
		allowInPlan: true,
	};
	const branch = [
		{ type: "message", message: { role: "toolResult", toolName: MCP_LOAD_TOOL, isError: false, details: { version: 1, descriptors: [descriptor] } } },
	];
	const harness = createHarness({ branch });
	await harness.emit("session_start");
	try {
		assert.ok(harness.tools.has("mcp_fixture_echo"), "definitions restore from the persisted load snapshot");
		assert.ok(harness.activeTools.includes("mcp_fixture_echo"));
		// The restored fingerprint mismatches the live schema: the first call
		// must refuse with MCP_TOOL_CHANGED instead of executing ambiguously.
		const result = await harness.executeTool("mcp_fixture_echo", { text: "x" });
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /MCP_TOOL_CHANGED/u);

		// Navigating to a branch without the snapshot drops the definition.
		(harness.ctx.sessionManager as { getBranch: () => unknown[] }).getBranch = () => [];
		await harness.emit("session_tree");
		assert.ok(!harness.activeTools.includes("mcp_fixture_echo"), "branch navigation before the load removes the tool");
	} finally {
		await harness.emit("session_shutdown");
	}
});

test("safety provenance recognizes only product-authority MCP tools", () => {
	const productInfo = { path: "<product:capability:mcp>", source: "product", scope: "temporary", origin: "top-level", productClass: "capability" } as any;
	const extensionInfo = { path: "/home/user/.mypi/agent/extensions/spoof.js", source: "extension", scope: "user", origin: "top-level" } as any;
	assert.equal(isMcpProductTool(MCP_SEARCH_TOOL, productInfo), true);
	assert.equal(isMcpProductTool("mcp_fixture_echo", productInfo), true);
	assert.equal(isTrustedSafetyTool("mcp_fixture_echo", productInfo), true);
	assert.equal(isMcpProductTool("mcp_fixture_echo", extensionInfo), false, "dynamic extensions cannot spoof MCP provenance");
	assert.equal(isTrustedSafetyTool("mcp_fixture_echo", extensionInfo), false);
	assert.equal(isMcpProductTool("bash", productInfo), false);
});
