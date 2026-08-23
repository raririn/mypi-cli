import assert from "node:assert/strict";
import test from "node:test";
import { convertResponsesMessages } from "../../../ai/src/api/openai-responses-shared.ts";

// BUG-101 (2026-08-21, installed test 8 follow-up): CLIProxy-fronted thinking
// models (deepseek-v4-flash) intermittently rejected tool loops with
// "The reasoning_content in the thinking mode must be passed back to the API"
// because a signature-less thinking block was silently dropped from the
// replayed input. With requiresReasoningItemReplay, the retained thinking text
// is replayed as a plain reasoning item; first-party OpenAI (which rejects
// unsigned reasoning items) keeps the drop behavior by default.

function makeModel(compat: Record<string, unknown>): any {
	return {
		id: "deepseek-v4-flash",
		name: "Test",
		api: "openai-codex-responses",
		provider: "cliproxyapi",
		baseUrl: "https://example.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 64_000,
		maxTokens: 8_000,
		compat,
	};
}

function assistantTurn(modelId: string): any {
	return {
		role: "assistant",
		api: "openai-codex-responses",
		provider: "cliproxyapi",
		model: modelId,
		content: [
			{ type: "thinking", thinking: "I should call the echo tool." },
			{ type: "toolCall", id: "call_1|fc_1", name: "mcp_everything_echo", arguments: { message: "hello" } },
		],
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse",
		timestamp: 1,
	};
}

test("signature-less thinking replays as a reasoning item only under requiresReasoningItemReplay", () => {
	const context = { messages: [
		{ role: "user", content: "echo hello", timestamp: 0 },
		assistantTurn("deepseek-v4-flash"),
		{ role: "toolResult", toolCallId: "call_1|fc_1", toolName: "mcp_everything_echo", content: [{ type: "text", text: "Echo: hello" }], isError: false, timestamp: 2 },
	] } as any;

	const withReplay = convertResponsesMessages(makeModel({ requiresReasoningItemReplay: true }), context, new Set(["cliproxyapi"]));
	const reasoning = withReplay.filter((item: any) => item.type === "reasoning");
	assert.equal(reasoning.length, 1, "every replayed step carries its reasoning");
	assert.deepEqual((reasoning[0] as any).content, [{ type: "reasoning_text", text: "I should call the echo tool." }]);
	assert.match((reasoning[0] as any).id, /^rs_pi_/u);
	const kinds = withReplay.map((item: any) => item.type ?? item.role);
	assert.deepEqual(kinds, ["user", "reasoning", "function_call", "function_call_output"]);

	const withoutFlag = convertResponsesMessages(makeModel({}), context, new Set(["cliproxyapi"]));
	assert.equal(withoutFlag.filter((item: any) => item.type === "reasoning").length, 0, "default keeps the safe drop for unsigned items");

	// Cross-model transcripts stay dropped even with the flag: another model's
	// thinking cannot be replayed as this model's reasoning.
	const crossModel = { messages: [context.messages[0], assistantTurn("other-model"), context.messages[2]] } as any;
	const crossReplay = convertResponsesMessages(makeModel({ requiresReasoningItemReplay: true }), crossModel, new Set(["cliproxyapi"]));
	assert.equal(crossReplay.filter((item: any) => item.type === "reasoning").length, 0);

	// Signed thinking blocks keep replaying the exact provider item.
	const signed = structuredClone(context);
	signed.messages[1].content[0].thinkingSignature = JSON.stringify({ type: "reasoning", id: "rs_real", summary: [], encrypted_content: "abc" });
	const signedReplay = convertResponsesMessages(makeModel({ requiresReasoningItemReplay: true }), signed, new Set(["cliproxyapi"]));
	const signedItems = signedReplay.filter((item: any) => item.type === "reasoning");
	assert.equal(signedItems.length, 1);
	assert.equal((signedItems[0] as any).id, "rs_real");
});

test("CLIProxyAPI replays explicit empty reasoning for no-thinking assistant steps", () => {
	const signed = assistantTurn("deepseek-v4-flash");
	signed.content[0].thinkingSignature = JSON.stringify({
		type: "reasoning",
		id: "rs_signed",
		summary: [{ type: "summary_text", text: "call write" }],
		encrypted_content: "",
	});
	const noThinkingTool = {
		...assistantTurn("deepseek-v4-flash"),
		timestamp: 3,
		content: [
			{ type: "text", text: "Now compile it." },
			{ type: "toolCall", id: "call_2|fc_2", name: "bash", arguments: { command: "cc hello.c" } },
		],
	};
	const noThinkingText = {
		...assistantTurn("deepseek-v4-flash"),
		stopReason: "stop",
		timestamp: 5,
		content: [{ type: "text", text: "Done." }],
	};
	const context = { messages: [
		{ role: "user", content: "build it", timestamp: 0 },
		signed,
		{ role: "toolResult", toolCallId: "call_1|fc_1", toolName: "write", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 2 },
		noThinkingTool,
		{ role: "toolResult", toolCallId: "call_2|fc_2", toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 4 },
		noThinkingText,
	] } as any;

	const replay = convertResponsesMessages(
		makeModel({ requiresReasoningItemReplay: true }),
		context,
		new Set(["cliproxyapi"]),
	);
	const reasoning = replay.filter((item: any) => item.type === "reasoning") as any[];
	assert.equal(reasoning.length, 3, "every same-model assistant step retains its reasoning field");
	assert.equal(reasoning[0].id, "rs_signed");
	assert.deepEqual(reasoning[1].content, [{ type: "reasoning_text", text: "" }]);
	assert.deepEqual(reasoning[2].content, [{ type: "reasoning_text", text: "" }]);
	assert.ok(
		replay.findIndex((item: any) => item.id === reasoning[1].id) <
			replay.findIndex((item: any) => item.type === "message" && item.content?.[0]?.text === "Now compile it."),
		"empty reasoning precedes its assistant text/tool step",
	);

	const defaultReplay = convertResponsesMessages(makeModel({}), context, new Set(["cliproxyapi"]));
	assert.equal(defaultReplay.filter((item: any) => item.type === "reasoning").length, 1, "unflagged providers keep only signed reasoning");

	const crossModel = structuredClone(context);
	crossModel.messages[3].model = "other-model";
	const crossReplay = convertResponsesMessages(
		makeModel({ requiresReasoningItemReplay: true }),
		crossModel,
		new Set(["cliproxyapi"]),
	);
	assert.equal(
		crossReplay.filter((item: any) => item.type === "reasoning").length,
		2,
		"a no-thinking step from another model does not receive fabricated reasoning",
	);
});
