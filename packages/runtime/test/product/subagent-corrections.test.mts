import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mypiShouldContinueAfterThresholdCompaction } from "../../src/core/agent-session.ts";
import { getSubagentGrantUsage } from "../../src/core/usage-totals.ts";
import {
	createSubagentBatchId,
	createSubagentChildId,
	createSubagentGrantId,
	SubagentStore,
	type SubagentChildRecord,
	type SubagentGrantRecord,
} from "../../src/core/subagents/storage.ts";
import subagentsExtension, {
	consultationUnavailableOutcome,
	SUBAGENT_USAGE_ENTRY,
	SUBAGENT_WAIT_STATE_EVENT,
	SubagentManager,
	SubagentUnavailableError,
} from "../../src/product/subagents.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";

function record(role: SubagentChildRecord["role"] = "explore"): SubagentChildRecord {
	const now = new Date().toISOString();
	return {
		version: 1,
		childId: createSubagentChildId(),
		parentSessionId: "parent-corrections",
		parentBranchId: null,
		role,
		label: "Test child",
		task: "Do the thing.",
		cwd: process.cwd(),
		model: { provider: "test", id: "model" },
		createdAt: now,
		updatedAt: now,
		grants: [],
	};
}

function grant(status: SubagentGrantRecord["status"], extra: Partial<SubagentGrantRecord> = {}): SubagentGrantRecord {
	return {
		grantId: createSubagentGrantId(),
		batchId: createSubagentBatchId(),
		prompt: "Do the thing.",
		status,
		createdAt: new Date().toISOString(),
		...extra,
	};
}

test("settled results wait for the parent settlement arbiter and then wake exactly once (BUG-099/115)", () => {
	const sends: Array<{ message: any; options: any }> = [];
	const pi = { requestContinuation(message: any, options: any) { sends.push({ message, options }); } } as unknown as ExtensionAPI;
	const manager = new SubagentManager(pi);
	let idle = false;
	(manager as any).ctx = { isIdle: () => idle };
	const child = record("explore");
	const settled = grant("completed", { answer: "done" });
	(manager as any).deliveryQueue.push((manager as any).resultFrom(child, settled));
	(manager as any).flushDelivery();
	assert.equal(sends.length, 0, "an active parent never receives an intra-run follow-up");
	assert.equal((manager as any).deliveryQueue.length, 1);
	idle = true;
	manager.notifyParentSettled();
	assert.equal(sends.length, 1);
	assert.deepEqual(sends[0]!.options, { arbitrationGroup: "mypi:parent-work", priority: 100 });
	assert.equal(typeof sends[0]!.message.details.nonce, "string");
	assert.equal((manager as any).inFlightDeliveries.size, 1);

	// Confirmation by exact nonce is the only thing that clears the in-flight record.
	manager.confirmDelivery({ nonce: "wrong" });
	assert.equal((manager as any).inFlightDeliveries.size, 1);
	manager.confirmDelivery(sends[0]!.message.details);
	assert.equal((manager as any).inFlightDeliveries.size, 0);

	// A later settle after confirmed delivery neither redelivers nor wakes again.
	manager.notifyParentSettled();
	assert.equal(sends.length, 1);
	assert.equal((manager as any).deliveryQueue.length, 0);
});

test("failed or unconfirmed delivery stays durably pending and retries at the next settle boundary (BUG-099)", async () => {
	let failing = true;
	const sends: any[] = [];
	const pi = {
		requestContinuation(message: any, options: any) {
			if (failing) throw new Error("boundary unavailable");
			sends.push({ message, options });
		},
	} as unknown as ExtensionAPI;
	const manager = new SubagentManager(pi);
	(manager as any).ctx = { isIdle: () => true };
	const child = record("explore");
	(manager as any).deliveryQueue.push((manager as any).resultFrom(child, grant("completed", { answer: "done" })));
	(manager as any).flushDelivery();
	assert.equal((manager as any).deliveryQueue.length, 1, "sync send failure requeues the result");
	assert.equal((manager as any).inFlightDeliveries.size, 0);

	// An initiated-but-unconfirmed delivery is requeued at the settle boundary.
	failing = false;
	manager.notifyParentSettled();
	await new Promise((resolve) => setTimeout(resolve, 150));
	assert.equal(sends.length, 1, "safe-boundary retry delivers exactly once");
	assert.equal((manager as any).deliveryQueue.length, 0);
	manager.notifyParentSettled();
	await new Promise((resolve) => setTimeout(resolve, 150));
	assert.equal(sends.length, 2, "unconfirmed in-flight delivery is requeued and resent, never lost");
	manager.confirmDelivery(sends[1]!.message.details);
	manager.notifyParentSettled();
	await new Promise((resolve) => setTimeout(resolve, 150));
	assert.equal(sends.length, 2, "confirmed delivery is final");

	// Automatic retry is bounded; a capped queue stays durably pending until reattachment.
	(manager as any).deliveryQueue.push((manager as any).resultFrom(child, grant("completed", { answer: "again" })));
	(manager as any).deliveryRetryStrikes = 3;
	manager.notifyParentSettled();
	await new Promise((resolve) => setTimeout(resolve, 150));
	assert.equal(sends.length, 2, "strike-capped retry issues no automatic attempt");
	manager.markAttached();
	await new Promise((resolve) => setTimeout(resolve, 150));
	assert.equal(sends.length, 3, "reattachment releases the capped retry");
});

test("the durable result inbox replays pending grants and reconciles accepted transcript delivery (BUG-115)", async () => {
	const root = await mkdtemp(join(tmpdir(), "mypi-subagent-delivery-inbox-"));
	const agentDir = join(root, "agent");
	const previousAgentDir = process.env.MYPI_AGENT_DIR;
	const previousCodingAgentDir = process.env.MYPI_CODING_AGENT_DIR;
	process.env.MYPI_AGENT_DIR = agentDir;
	process.env.MYPI_CODING_AGENT_DIR = agentDir;
	const child = record("explore");
	const pending = grant("completed", { answer: "durable result", delivery: { state: "pending" } });
	child.grants.push(pending);
	const store = await SubagentStore.open(agentDir, child.parentSessionId);
	await store.create(child);
	const sends: any[] = [];
	const pi = {
		requestContinuation: (message: any, options: any) => sends.push({ message, options }),
		events: { emit() {}, on() { return () => {}; } },
		setBackgroundWait() {},
	} as unknown as ExtensionAPI;
	const baseCtx = {
		isIdle: () => true,
		sessionManager: {
			getSessionFile: () => join(root, "parent.jsonl"),
			getSessionId: () => child.parentSessionId,
			getBranch: () => [],
		},
	} as any;
	try {
		const manager = new SubagentManager(pi);
		await manager.initialize(baseCtx);
		await new Promise((resolve) => setTimeout(resolve, 150));
		assert.equal(sends.length, 1, "a persisted pending result wakes the idle parent");
		manager.confirmDelivery(sends[0]!.message.details);
		await new Promise((resolve) => setTimeout(resolve, 25));
		assert.equal((await SubagentStore.open(agentDir, child.parentSessionId)).get(child.childId)?.grants[0]?.delivery?.state, "delivered");
		await manager.shutdown("test_complete");

		const replay = (await SubagentStore.open(agentDir, child.parentSessionId)).get(child.childId)!;
		replay.grants[0]!.delivery = { state: "pending" };
		await store.update(replay);
		const replaySends: any[] = [];
		const reconciler = new SubagentManager({
			...pi,
			requestContinuation: (message: any, options: any) => replaySends.push({ message, options }),
		} as unknown as ExtensionAPI);
		await reconciler.initialize({
			...baseCtx,
			sessionManager: {
				...baseCtx.sessionManager,
				getBranch: () => [{
					type: "custom_message",
					customType: "mypi-subagent-results",
					details: sends[0]!.message.details,
				}],
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 150));
		assert.equal(replaySends.length, 0, "an accepted transcript result is never replayed");
		assert.equal((await SubagentStore.open(agentDir, child.parentSessionId)).get(child.childId)?.grants[0]?.delivery?.state, "delivered");
		await reconciler.shutdown("test_complete");
	} finally {
		if (previousAgentDir === undefined) delete process.env.MYPI_AGENT_DIR;
		else process.env.MYPI_AGENT_DIR = previousAgentDir;
		if (previousCodingAgentDir === undefined) delete process.env.MYPI_CODING_AGENT_DIR;
		else process.env.MYPI_CODING_AGENT_DIR = previousCodingAgentDir;
		await rm(root, { recursive: true, force: true });
	}
});

test("active-children wait state is published to the event bus and the session background-wait hook (BUG-097)", () => {
	const emitted: Array<{ channel: string; data: any }> = [];
	const waits: boolean[] = [];
	const pi = {
		events: { emit: (channel: string, data: any) => emitted.push({ channel, data }), on: () => () => {} },
		setBackgroundWait: (active: boolean) => waits.push(active),
		sendMessage() {},
	} as unknown as ExtensionAPI;
	const manager = new SubagentManager(pi);
	(manager as any).active.set("sa_x", {});
	(manager as any).publishWaitState();
	(manager as any).active.clear();
	(manager as any).publishWaitState();
	assert.deepEqual(emitted.map((entry) => entry.channel), [SUBAGENT_WAIT_STATE_EVENT, SUBAGENT_WAIT_STATE_EVENT]);
	assert.deepEqual(emitted.map((entry) => entry.data), [{ active: 1, pending: 0 }, { active: 0, pending: 0 }]);
	assert.deepEqual(waits, [true, false]);
	assert.equal(manager.hasActiveChildren(), false);
});

test("proactive post-compaction continuation parks while background children run (BUG-097)", () => {
	const base = {
		reason: "threshold" as const,
		willRetry: false,
		aborted: false,
		errorMessage: undefined,
		hasQueuedMessages: false,
		budgetRemaining: 1,
		compactionId: "c1",
		summary: "## Summary\n### In Progress\n- [ ] finish the work\n",
		branchEntries: [],
	};
	assert.equal(mypiShouldContinueAfterThresholdCompaction(base), true);
	assert.equal(mypiShouldContinueAfterThresholdCompaction({ ...base, backgroundWait: true }), false);
});

test("every settled grant records one typed parent-accountable usage entry (BUG-096)", () => {
	const entries: Array<{ customType: string; data: any }> = [];
	const pi = { appendEntry: (customType: string, data: any) => entries.push({ customType, data }), sendMessage() {} } as unknown as ExtensionAPI;
	const manager = new SubagentManager(pi);
	const child = record("advisor");
	const settled = grant("completed", { usage: { input: 100, output: 40, cacheRead: 30, cacheWrite: 10, total: 180, cost: 0.25 } });
	(manager as any).recordGrantUsage(child, settled);
	const partial = grant("timed_out", { usage: { input: 7, output: 0, cacheRead: 0, cacheWrite: 0, total: 7, cost: 0.01 } });
	(manager as any).recordGrantUsage(child, partial);
	const empty = grant("cancelled");
	(manager as any).recordGrantUsage(child, empty);
	assert.equal(entries.length, 3);
	assert.ok(entries.every((entry) => entry.customType === SUBAGENT_USAGE_ENTRY));
	assert.deepEqual(entries[0]!.data.usage, { input: 100, output: 40, cacheRead: 30, cacheWrite: 10, total: 180, cost: 0.25 });
	assert.equal(entries[0]!.data.grantId, settled.grantId);
	assert.equal(entries[1]!.data.status, "timed_out");
	assert.deepEqual(entries[2]!.data.usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });

	// The typed reader accepts exactly this shape and rejects untrusted variants.
	const usage = getSubagentGrantUsage({ type: "custom", customType: SUBAGENT_USAGE_ENTRY, data: entries[0]!.data } as any);
	assert.deepEqual(usage, {
		input: 100, output: 40, cacheRead: 30, cacheWrite: 10, totalTokens: 180,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
	});
	assert.equal(getSubagentGrantUsage({ type: "custom", customType: SUBAGENT_USAGE_ENTRY, data: { version: 2, usage: entries[0]!.data.usage } } as any), undefined);
	assert.equal(getSubagentGrantUsage({ type: "custom", customType: SUBAGENT_USAGE_ENTRY, data: { version: 1, usage: { input: -1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } } } as any), undefined);
	assert.equal(getSubagentGrantUsage({ type: "custom", customType: "mypi-structured-output", data: entries[0]!.data } as any), undefined);
});

test("advisor and reviewer availability failures produce one exact stable outcome (BUG-098)", () => {
	const fakeSecret = ["sk", "abcdefghijklmnopqrstuvwxyz012345"].join("-");
	const advisor = consultationUnavailableOutcome("advisor", "model", `Configured advisor model is unavailable: x/y ${fakeSecret}`);
	assert.match(advisor.content[0].text, /^Advisor is unavailable\./u);
	assert.match(advisor.content[0].text, /satisfies any mandatory advisor requirement for this turn/u);
	assert.match(advisor.content[0].text, /continue honestly/u);
	assert.equal(advisor.details.unavailable, true);
	assert.equal(advisor.details.phase, "model");
	assert.equal(advisor.details.reason.includes(fakeSecret), false, "secrets are redacted from structured details");
	const reviewer = consultationUnavailableOutcome("review", "startup", "child exited before readiness");
	assert.match(reviewer.content[0].text, /^Reviewer is unavailable\./u);
	assert.equal(reviewer.details.phase, "startup");
});

test("post-admission consultation failure delivers the stable unavailable outcome (BUG-098)", () => {
	const sends: any[] = [];
	const pi = { requestContinuation(message: any, options: any) { sends.push({ message, options }); } } as unknown as ExtensionAPI;
	const manager = new SubagentManager(pi);
	(manager as any).ctx = { isIdle: () => true };
	const child = record("advisor");
	const failed = (manager as any).resultFrom(child, grant("failed", { reason: "Advisor briefing model returned no text." }));
	assert.equal(failed.unavailablePhase, "briefing");
	(manager as any).deliveryQueue.push(failed);
	(manager as any).flushDelivery();
	assert.equal(sends.length, 1);
	assert.match(sends[0]!.message.content, /Advisor is unavailable\./u);
	assert.match(sends[0]!.message.content, /satisfies any mandatory advisor requirement/u);

	const reviewer = record("review");
	const timedOut = (manager as any).resultFrom(reviewer, grant("timed_out", { reason: "timeout" }));
	assert.equal(timedOut.unavailablePhase, "timeout");
	const exploreFailure = (manager as any).resultFrom(record("explore"), grant("failed", { reason: "boom" }));
	assert.equal(exploreFailure.unavailablePhase, undefined, "explore/work failures stay ordinary results");
});

test("confirmed consultation replacement preflights availability before cancelling the predecessor (BUG-098)", async () => {
	const advisor = record("advisor");
	advisor.grants.push(grant("running"));
	const manager = new SubagentManager({ sendMessage() {} } as unknown as ExtensionAPI);
	(manager as any).initialize = async () => {};
	(manager as any).store = { list: () => [advisor] };
	let cancelled = 0;
	(manager as any).cancelRunning = async () => { cancelled += 1; };
	(manager as any).active.set(advisor.childId, { record: advisor });
	(manager as any).resolveModel = async () => {
		throw new SubagentUnavailableError("advisor", "auth", "no usable authentication");
	};
	const ctx = {} as any;
	assert.equal((await manager.consultAdvisor("Replace it", ctx)).confirmationRequired, true);
	await assert.rejects(manager.consultAdvisor("Replace it", ctx), SubagentUnavailableError);
	assert.equal(cancelled, 0, "the current conversation is preserved when replacement preflight fails");
	assert.equal((manager as any).active.has(advisor.childId), true);
});

test("/advisor and /reviewer free text dispatches the matching consultation flow (BUG-095)", async () => {
	const commands = new Map<string, any>();
	const pi = {
		events: { on() { return () => {}; }, emit() {} },
		registerTool() {},
		registerCommand(name: string, command: any) { commands.set(name, command); },
		on() {},
		sendMessage() {},
	} as unknown as ExtensionAPI;
	subagentsExtension(pi);
	assert.ok(commands.has("advisor"));
	assert.ok(commands.has("reviewer"));
	assert.match(commands.get("advisor").description, /consultation/i);
	assert.match(commands.get("reviewer").description, /review/i);
	assert.deepEqual(commands.get("advisor").getArgumentCompletions("").map((item: any) => item.value), ["on", "off"]);

	const notices: Array<{ message: string; level?: string }> = [];
	const ctx = {
		ui: {
			notify: (message: string, level?: string) => notices.push({ message, level }),
			confirm: async () => true,
		},
		sessionManager: { getSessionFile: () => undefined },
	} as any;
	await commands.get("advisor").handler("Which approach should I take?", ctx);
	assert.match(notices.at(-1)!.message, /^\/advisor failed: Subagents require a persisted parent session\./u,
		"free text reaches the consult_advisor flow instead of a usage warning");
	await commands.get("reviewer").handler("Review the change", ctx);
	assert.match(notices.at(-1)!.message, /^\/reviewer failed: Subagents require a persisted parent session\./u);
});

test("settle guidance appears only after consecutive status polls with live children (BUG-097 refinement)", () => {
	const pi = { sendMessage() {} } as unknown as ExtensionAPI;
	const manager = new SubagentManager(pi);
	(manager as any).active.set("sa_live", {});

	// Admission alone never mandates settling.
	assert.equal(manager.pollGuidance(), undefined);

	manager.recordToolCall("subagent_status");
	manager.recordToolCall("subagent_status");
	assert.equal(manager.pollGuidance(), undefined, "one or two polls draw no instruction");
	manager.recordToolCall("subagent_status");
	assert.match(manager.pollGuidance() ?? "", /settle now/u);
	assert.match(manager.pollGuidance() ?? "", /3 times in a row/u);
	assert.match(manager.pollGuidance() ?? "", /otherwise continue independent work/u);

	// Any other tool call resets the streak; guidance is poll-conditional, not standing.
	manager.recordToolCall("read");
	assert.equal(manager.pollGuidance(), undefined);

	// Without live children there is nothing to wait for.
	manager.recordToolCall("subagent_status");
	manager.recordToolCall("subagent_status");
	manager.recordToolCall("subagent_status");
	(manager as any).active.clear();
	assert.equal(manager.pollGuidance(), undefined);
});

test("/advisor-model searches with bounded fuzzy results instead of one giant selector", async () => {
	const commands = new Map<string, any>();
	const pi = {
		events: { on() { return () => {}; }, emit() {} },
		registerTool() {},
		registerCommand(name: string, command: any) { commands.set(name, command); },
		on() {},
		sendMessage() {},
	} as unknown as ExtensionAPI;
	subagentsExtension(pi);
	const command = commands.get("advisor-model");
	assert.ok(command);

	const models = Array.from({ length: 300 }, (_, index) => ({
		provider: index % 2 ? "openai" : "anthropic",
		id: `catalog-model-${index}`,
	}));
	models.push({ provider: "openai", id: "gpt-5-nano" });
	const selects: string[][] = [];
	const notices: string[] = [];
	const makeCtx = (inputValue: string | undefined) => ({
		modelRegistry: { refresh: async () => {}, getAvailable: () => models },
		ui: {
			input: async () => inputValue,
			select: async (_title: string, options: string[]) => { selects.push(options); return options[0]; },
			notify: (message: string) => notices.push(message),
		},
	}) as any;

	// Bare invocation: search prompt, then one bounded fuzzy-ranked selector.
	await command.handler("", makeCtx("gpt-5"));
	assert.equal(selects.length, 1);
	assert.ok(selects[0]!.length <= 20, `bounded selector, got ${selects[0]!.length}`);
	assert.equal(selects[0]![0], "openai/gpt-5-nano", "best fuzzy match ranks first");
	assert.match(notices.at(-1) ?? "", /Advisor\/reviewer model: openai\/gpt-5-nano/u);

	// A broad search term stays bounded, never the whole catalog.
	await command.handler("catalog-model", makeCtx(undefined));
	assert.equal(selects.length, 2);
	assert.ok(selects[1]!.length <= 20, `bounded selector, got ${selects[1]!.length}`);

	// Argument completions are fuzzy and bounded like /model.
	const completions = await command.getArgumentCompletions("gpt");
	assert.ok(completions.length <= 50);
	assert.ok(completions.some((item: any) => item.value === "openai/gpt-5-nano"));
	const bare = await command.getArgumentCompletions("");
	assert.equal(bare[0].value, "inherit");

	// Exact values and inherit still apply directly.
	await command.handler("inherit", makeCtx(undefined));
	assert.match(notices.at(-1) ?? "", /Advisor\/reviewer model: inherit/u);
});
