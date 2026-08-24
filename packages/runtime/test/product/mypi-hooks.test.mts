import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import hooksExtension from "../../src/product/hooks.ts";

function createHarness() {
	const tools = new Map<string, unknown>();
	const commands = new Map<string, any>();
	const handlers = new Map<string, unknown[]>();
	const pi = {
		registerTool: (tool: { name: string }) => tools.set(tool.name, tool),
		registerCommand: (name: string, command: unknown) => commands.set(name, command),
		on: (event: string, handler: unknown) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		sendMessage() {},
	} as unknown as ExtensionAPI;
	hooksExtension(pi);
	return { tools, commands, handlers };
}

test("model-callable agent hook tools are hidden while user hook lifecycle remains active", async () => {
	const harness = createHarness();
	assert.deepEqual([...harness.tools.keys()], []);
	assert.deepEqual([...harness.commands.keys()], ["hooks"]);
	for (const event of ["session_start", "tool_call", "tool_result", "input", "session_before_compact", "agent_settled"]) {
		assert.equal(harness.handlers.has(event), true, `missing user hook lifecycle ${event}`);
	}

	let help = "";
	await harness.commands.get("hooks").handler("--help", {
		ui: { editor: async (_title: string, content: string) => { help = content; } },
	});
	assert.match(help, /schedule_prompt and watch_files agent-hook tools are\s+temporarily disabled/u);
});
