import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "../../src/core/extensions/types.ts";
import hooksExtension, { HOOK_FIRED_MESSAGE_TYPE } from "../../src/product/hooks.ts";

interface SentMessage {
	message: { customType: string; content: string; display?: boolean };
	options: { triggerTurn?: boolean; deliverAs?: string } | undefined;
}

function createHarness(options: { idle?: boolean } = {}) {
	const state = { idle: options.idle ?? true };
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const handlers = new Map<string, any[]>();
	const sent: SentMessage[] = [];
	const notices: string[] = [];
	const statuses: (string | undefined)[] = [];
	const pi = {
		registerTool: (tool: { name: string }) => tools.set(tool.name, tool),
		registerCommand: (name: string, command: unknown) => commands.set(name, command),
		on: (event: string, handler: unknown) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		sendMessage: (message: SentMessage["message"], sendOptions?: SentMessage["options"]) => {
			sent.push({ message, options: sendOptions });
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: tmpdir(),
		isIdle: () => state.idle,
		isProjectTrusted: () => false,
		ui: {
			setStatus: (_key: string, value: string | undefined) => statuses.push(value),
			notify: (text: string) => notices.push(text),
			editor: async () => undefined,
		},
	} as unknown as ExtensionContext;
	hooksExtension(pi);
	const emit = async (event: string, payload: unknown) => {
		for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
	};
	const execute = async (tool: string, params: unknown) => tools.get(tool).execute("call", params, undefined, undefined, ctx);
	const fired = () => sent.filter((entry) => entry.message.customType === HOOK_FIRED_MESSAGE_TYPE);
	return { tools, commands, handlers, sent, notices, statuses, state, ctx, emit, execute, fired };
}

test("registers one-shot agent hook tools alongside the user hook lifecycle", async () => {
	const harness = createHarness();
	assert.deepEqual([...harness.tools.keys()].sort(), ["schedule_wakeup", "watch_files"]);
	assert.deepEqual([...harness.commands.keys()], ["hooks"]);
	for (const event of ["session_start", "tool_call", "tool_result", "input", "session_before_compact", "agent_settled", "session_shutdown"]) {
		assert.equal(harness.handlers.has(event), true, `missing lifecycle handler ${event}`);
	}
	let help = "";
	await harness.commands.get("hooks").handler("--help", {
		ui: { editor: async (_title: string, content: string) => { help = content; } },
	});
	assert.match(help, /ONE pending wakeup/u);
	assert.match(help, /one-shot/u);
	assert.match(help, /never schedule wakeups to poll/u);
});

test("schedule_wakeup keeps a single slot: scheduling again replaces the pending wakeup", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const harness = createHarness();
	const first = await harness.execute("schedule_wakeup", { action: "schedule", delaySeconds: 60, note: "first note" });
	assert.match(first.content[0].text, /fires once in 60s/u);
	const second = await harness.execute("schedule_wakeup", { action: "schedule", delaySeconds: 120, note: "second note" });
	assert.match(second.content[0].text, /replacing w1 \(one wakeup slot per session\)/u);

	t.mock.timers.tick(60_000);
	assert.equal(harness.fired().length, 0, "replaced wakeup must not fire");
	t.mock.timers.tick(60_000);
	const fired = harness.fired();
	assert.equal(fired.length, 1);
	assert.match(fired[0]!.message.content, /wakeup w2 \(after 120s\): second note/u);
	assert.doesNotMatch(fired[0]!.message.content, /first note/u);

	const status = await harness.execute("schedule_wakeup", { action: "status" });
	assert.equal(status.content[0].text, "No pending wakeup.");
});

test("idle firing starts a turn immediately with a labeled non-user notification", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const harness = createHarness({ idle: true });
	await harness.execute("schedule_wakeup", { action: "schedule", delaySeconds: 90, note: "resume the build check" });
	t.mock.timers.tick(90_000);
	const fired = harness.fired();
	assert.equal(fired.length, 1);
	assert.equal(fired[0]!.options?.triggerTurn, true);
	assert.equal(fired[0]!.options?.deliverAs, "followUp");
	assert.match(fired[0]!.message.content, /^\[Automated agent-hook notification — not a user message/u);
	assert.match(fired[0]!.message.content, /never schedule wakeups to poll/u);
});

test("firings during an active run coalesce and deliver at successful settlement", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const harness = createHarness({ idle: false });
	await harness.execute("schedule_wakeup", { action: "schedule", delaySeconds: 60, note: "wakeup note" });
	t.mock.timers.tick(60_000);
	assert.equal(harness.fired().length, 0, "must not deliver mid-run");

	await harness.execute("schedule_wakeup", { action: "schedule", delaySeconds: 60, note: "second wakeup" });
	t.mock.timers.tick(60_000);
	assert.equal(harness.fired().length, 0, "still mid-run");

	await harness.emit("agent_settled", { type: "agent_settled", outcome: { kind: "success" } });
	const fired = harness.fired();
	assert.equal(fired.length, 1, "coalesced into one message");
	assert.equal(fired[0]!.options?.triggerTurn, true);
	assert.match(fired[0]!.message.content, /wakeup note/u);
	assert.match(fired[0]!.message.content, /second wakeup/u);
});

test("after an aborted or failed run the notice is held in context without starting a turn", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	for (const kind of ["aborted", "error"] as const) {
		const harness = createHarness({ idle: false });
		await harness.execute("schedule_wakeup", { action: "schedule", delaySeconds: 60, note: `${kind} note` });
		t.mock.timers.tick(60_000);
		await harness.emit("agent_settled", { type: "agent_settled", outcome: { kind } });
		const fired = harness.fired();
		assert.equal(fired.length, 1, `${kind}: delivered at settlement`);
		assert.equal(fired[0]!.options?.triggerTurn, false, `${kind}: must not start a turn`);
	}
});

test("schedule_wakeup validates bounds and cancel semantics", async () => {
	const harness = createHarness();
	await assert.rejects(() => harness.execute("schedule_wakeup", { action: "schedule", delaySeconds: 5, note: "too fast" }), /between 60 and 86400/u);
	await assert.rejects(() => harness.execute("schedule_wakeup", { action: "schedule", delaySeconds: 60 }), /requires delaySeconds and note/u);
	await assert.rejects(() => harness.execute("schedule_wakeup", { action: "cancel" }), /No pending wakeup/u);
	await harness.execute("schedule_wakeup", { action: "schedule", delaySeconds: 60, note: "cancel me" });
	const cancelled = await harness.execute("schedule_wakeup", { action: "cancel" });
	assert.match(cancelled.content[0].text, /Cancelled wakeup w1/u);
});

test("session shutdown consumes agent hooks: a later firing is dropped", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const harness = createHarness();
	await harness.execute("schedule_wakeup", { action: "schedule", delaySeconds: 60, note: "never" });
	await harness.emit("session_shutdown", { type: "session_shutdown" });
	t.mock.timers.tick(120_000);
	assert.equal(harness.fired().length, 0);
});

test("watch_files is one-shot: first change fires, consumes the watch, and later changes are silent", async () => {
	const harness = createHarness({ idle: true });
	const dir = mkdtempSync(join(tmpdir(), "mypi-hooks-watch-"));
	const target = join(dir, "artifact.txt");
	writeFileSync(target, "initial");
	const result = await harness.execute("watch_files", { action: "watch", path: target, note: "artifact changed" });
	assert.match(result.content[0].text, /fires once on first change/u);

	writeFileSync(target, "changed");
	await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_500));
	assert.equal(harness.fired().length, 1);
	assert.match(harness.fired()[0]!.message.content, /file watch f1 .*artifact changed/u);

	const list = await harness.execute("watch_files", { action: "list" });
	assert.equal(list.content[0].text, "No active watches.", "watch consumed after firing");

	writeFileSync(target, "changed again");
	await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_500));
	assert.equal(harness.fired().length, 1, "consumed watch must not fire again");
});

test("watch_files enforces the cap, path existence, and cancel semantics", async () => {
	const harness = createHarness();
	const dir = mkdtempSync(join(tmpdir(), "mypi-hooks-cap-"));
	for (let index = 0; index < 3; index += 1) {
		const file = join(dir, `file-${index}`);
		writeFileSync(file, "x");
		await harness.execute("watch_files", { action: "watch", path: file, note: `watch ${index}` });
	}
	await assert.rejects(() => harness.execute("watch_files", { action: "watch", path: dir, note: "over cap" }), /Watch limit reached \(3\)/u);
	await assert.rejects(() => harness.execute("watch_files", { action: "watch", path: join(dir, "missing"), note: "nope" }), /does not exist/u);
	const list = await harness.execute("watch_files", { action: "list" });
	assert.equal(list.content[0].text.split("\n").length, 3);
	const cancelled = await harness.execute("watch_files", { action: "cancel", id: "f1" });
	assert.match(cancelled.content[0].text, /Cancelled watch f1/u);
	await assert.rejects(() => harness.execute("watch_files", { action: "cancel", id: "f1" }), /No watch with id f1/u);
});

test("/hooks lists the pending wakeup and active watches", async () => {
	const harness = createHarness();
	const dir = mkdtempSync(join(tmpdir(), "mypi-hooks-cmd-"));
	const file = join(dir, "watched");
	writeFileSync(file, "x");
	await harness.execute("schedule_wakeup", { action: "schedule", delaySeconds: 300, note: "listing wakeup" });
	await harness.execute("watch_files", { action: "watch", path: file, note: "listing watch" });
	let output = "";
	await harness.commands.get("hooks").handler("", {
		ui: { editor: async (_title: string, content: string) => { output = content; } },
	});
	assert.match(output, /wakeup w1: fires in \d+s — listing wakeup/u);
	assert.match(output, /watch f2: .*watched — listing watch/u);
});
