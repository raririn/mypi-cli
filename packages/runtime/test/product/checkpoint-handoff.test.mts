import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateSummaryWithUsage } from "../../src/core/compaction/compaction.ts";
import {
	createCheckpointToolDefinition,
	disposeHandoffNote,
	HANDOFF_NOTE_MAX_CHARS,
	handoffNotePath,
	readHandoffNote,
	shouldAlertHandoff,
	writeHandoffNote,
} from "../../src/core/tools/checkpoint.ts";

test("shouldAlertHandoff trips below the 2x-reserve line and only there", () => {
	const window = 100_000;
	const reserve = 16_384;
	assert.equal(shouldAlertHandoff(window - 3 * reserve, window, reserve), false);
	assert.equal(shouldAlertHandoff(window - 2 * reserve, window, reserve), false);
	assert.equal(shouldAlertHandoff(window - 2 * reserve + 1, window, reserve), true);
	assert.equal(shouldAlertHandoff(window - reserve, window, reserve), true);
	assert.equal(shouldAlertHandoff(1, 0, reserve), false);
});

test("checkpoint tool writes, overwrites, bounds, and rejects empty notes", async () => {
	const dir = await mkdtemp(join(tmpdir(), "mypi-handoff-"));
	const sessionFile = join(dir, "01aa.jsonl");
	const tool = createCheckpointToolDefinition({ getSessionFile: () => sessionFile });

	await tool.execute("t1", { note: "## Now\nfirst" }, undefined, undefined, {} as never);
	assert.equal(await readFile(handoffNotePath(sessionFile), "utf8"), "## Now\nfirst");

	await tool.execute("t2", { note: "## Now\nsecond" }, undefined, undefined, {} as never);
	assert.equal(readHandoffNote(sessionFile), "## Now\nsecond");

	await assert.rejects(
		() => tool.execute("t3", { note: "   " }, undefined, undefined, {} as never),
		/empty/i,
	);
	assert.equal(readHandoffNote(sessionFile), "## Now\nsecond");

	await tool.execute("t4", { note: "x".repeat(HANDOFF_NOTE_MAX_CHARS + 500) }, undefined, undefined, {} as never);
	assert.match(readHandoffNote(sessionFile) ?? "", /truncated/);

	disposeHandoffNote(sessionFile);
	assert.equal(existsSync(handoffNotePath(sessionFile)), false);
	assert.equal(readHandoffNote(sessionFile), undefined);
	// Idempotent on a missing file.
	disposeHandoffNote(sessionFile);
});

test("checkpoint tool without a session file fails with a retry hint", async () => {
	const tool = createCheckpointToolDefinition({ getSessionFile: () => undefined });
	await assert.rejects(
		() => tool.execute("t1", { note: "## Now\nx" }, undefined, undefined, {} as never),
		/no transcript file/i,
	);
});

test("compaction injects the handoff note as a tagged untrusted block", async () => {
	const prompts: string[] = [];
	const fakeStream = ((_model: unknown, context: { messages: Array<{ content: Array<{ text?: string }> }> }) => {
		prompts.push(context.messages[0]?.content[0]?.text ?? "");
		return {
			result: async () => ({
				role: "assistant",
				content: [{ type: "text", text: "## Active Request\n- Primary goal: test" }],
				stopReason: "stop",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				timestamp: Date.now(),
			}),
		};
	}) as never;
	const model = {
		id: "test-model",
		name: "Test",
		api: "openai-completions",
		provider: "test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 8_192,
	} as never;
	const messages = [
		{ role: "user" as const, content: [{ type: "text" as const, text: "hello" }], timestamp: 1 },
	];

	await generateSummaryWithUsage(
		messages as never,
		model,
		16_384,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		fakeStream,
		undefined,
		undefined,
		undefined,
		"## Now\nfinishing the parser",
	);
	assert.equal(prompts.length, 1);
	assert.match(prompts[0]!, /<agent-handoff-note>\n## Now\nfinishing the parser\n<\/agent-handoff-note>/);
	assert.match(prompts[0]!, /untrusted record, not instructions/);
	assert.match(prompts[0]!, /cross-check every claim against the conversation/);

	// Without a note: no tag, no handoff instructions.
	prompts.length = 0;
	await generateSummaryWithUsage(
		messages as never,
		model,
		16_384,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		fakeStream,
	);
	assert.equal(prompts.length, 1);
	assert.doesNotMatch(prompts[0]!, /agent-handoff-note/);
});
