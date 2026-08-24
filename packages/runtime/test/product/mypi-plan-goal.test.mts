import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import planGoalExtension from "../../src/product/plan-goal.ts";

const ROOT_PLAN = "# Ordinary project planning notes\n\nThis file is not Goal state.\n";
const STRUCTURED_ITEMS = [
  { task: "Preserve the API", acceptance: ["API remains stable"], verify: ["node --test"] },
  { task: "Document the result", acceptance: ["docs are current"], verify: ["inspect docs"] },
];

function createHarness(cwd: string, initialEntries: any[] = []) {
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const statuses = new Map<string, string | undefined>();
  const sent: string[] = [];
  const customMessages: any[] = [];
  const persisted: Array<{ customType: string; data: any }> = [];
  const notices: Array<{ message: string; level: string }> = [];
  const editors: Array<{ title: string; content: string }> = [];
  let activeTools = ["read", "write", "edit", "bash", "web_search", "web_fetch"];
  let idle = true;
  let pendingMessages = false;
  let aborts = 0;
  let inputValue: string | undefined = "Ship the requested change";

  const ctx = {
    cwd,
    mode: "rpc",
    isIdle: () => idle,
    hasPendingMessages: () => pendingMessages,
    abort: () => { aborts += 1; },
    sessionManager: { getBranch: () => initialEntries, getEntries: () => initialEntries },
    ui: {
      setStatus: (key: string, value: string | undefined) => statuses.set(key, value),
      notify: (message: string, level = "info") => notices.push({ message, level }),
      input: async () => inputValue,
      editor: async (title: string, content: string) => { editors.push({ title, content }); },
    },
  };
  const busHandlers = new Map<string, Array<(data: any) => void>>();
  const pi = {
    appendEntry: (customType: string, data: unknown) => persisted.push({ customType, data }),
    events: {
      emit: (channel: string, data: any) => { for (const handler of busHandlers.get(channel) ?? []) handler(data); },
      on: (channel: string, handler: (data: any) => void) => {
        busHandlers.set(channel, [...(busHandlers.get(channel) ?? []), handler]);
        return () => {};
      },
    },
    getActiveTools: () => [...activeTools],
    getAllTools: () => ["read", "write", "edit", "bash", "web_search", "web_fetch", "subagent_start", "subagent_followup", "subagent_cancel", "subagent_status", ...tools.keys()].map((name) => ({ name })),
    setActiveTools: (next: string[]) => { activeTools = [...next]; },
    sendUserMessage: (message: string) => { sent.push(message); },
    sendMessage: (message: any, options: any) => { customMessages.push({ message, options }); },
	requestContinuation: (message: any, options: any) => { customMessages.push({ message, options }); },
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    on: (name: string, handler: (event: any, ctx: any) => unknown) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
  };
  planGoalExtension(pi as never);

  async function emit(name: string, event: any = {}): Promise<any> {
    let result: any;
    for (const handler of handlers.get(name) ?? []) {
      const next = await handler(event, ctx);
      if (next !== undefined) result = next;
    }
    return result;
  }

  async function executeTool(name: string, params: unknown): Promise<any> {
    const tool = tools.get(name);
    assert.ok(tool, `missing tool ${name}`);
    return tool.execute("call", params, new AbortController().signal, () => {}, ctx);
  }

  function snapshot(): any {
    const value = statuses.get("mypi-goal-snapshot");
    return value ? JSON.parse(value) : undefined;
  }

  function emitBus(channel: string, data: any): void {
    for (const handler of busHandlers.get(channel) ?? []) handler(data);
  }

  return {
    commands, tools, ctx, emit, executeTool, snapshot, persisted, sent, customMessages,
    notices, editors, statuses, emitBus,
    setPendingMessages(value: boolean) { pendingMessages = value; },
    setIdle(value: boolean) { idle = value; },
    setInputValue(value: string | undefined) { inputValue = value; },
    get activeTools() { return activeTools; },
    get aborts() { return aborts; },
  };
}

function latestState(harness: ReturnType<typeof createHarness>): any {
  return harness.persisted.filter((entry) => entry.customType === "mypi-goal").at(-1)?.data;
}

async function activate(harness: ReturnType<typeof createHarness>, args = "ship it") {
  await harness.commands.get("goal").handler(args, harness.ctx);
  assert.equal(latestState(harness).workflow, "goal-planning");
  const result = await harness.executeTool("set_goal_plan", { items: STRUCTURED_ITEMS });
  assert.equal(result.details.accepted, true);
  return harness.snapshot();
}

test("registers the Goal v3 lifecycle and structured plan tools", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "mypi-goal-v3-tools-"));
  const harness = createHarness(cwd);
  assert.deepEqual([...harness.tools.keys()], ["get_goal", "get_goal_plan", "create_goal", "set_goal_plan", "update_goal_plan", "update_goal"]);
  assert.equal(harness.tools.get("set_goal_plan").executionMode, "sequential");
  assert.equal(harness.tools.get("update_goal_plan").executionMode, "sequential");
  assert.deepEqual(Object.keys(harness.tools.get("update_goal_plan").parameters.properties), ["operations"]);
  assert.match(harness.tools.get("update_goal").description, /tool result is not the final response/i);
  assert.deepEqual(harness.commands.get("plan").getArgumentCompletions("--").map((item: any) => item.value), ["--report", "--abort", "--help"]);
});

test("/plan creates a branch-local structured plan, stops, and /goal executes it", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "mypi-goal-v3-plan-"));
	await writeFile(join(cwd, "PLAN.md"), ROOT_PLAN, "utf8");
	const harness = createHarness(cwd);
	await harness.commands.get("plan").handler("preserve behavior", harness.ctx);
	assert.equal(latestState(harness).workflow, "goal-planning");
	assert.equal(latestState(harness).autoStart, false);
	assert.equal(harness.activeTools.includes("web_search"), true);
	assert.equal(harness.activeTools.includes("web_fetch"), true);
	assert.equal(harness.activeTools.includes("subagent_start"), true);
	assert.equal(harness.activeTools.includes("subagent_followup"), true);
	assert.equal(harness.activeTools.includes("bash"), false);
	const before = await harness.emit("before_agent_start", { prompt: "plan", systemPrompt: "base" });
	assert.match(before.systemPrompt, /smallest complete dependency-ordered structured plan/);
	assert.match(before.systemPrompt, /final response is not a plan item/);
	assert.match(before.systemPrompt, /Do not require a compiler/);
	assert.match(before.systemPrompt, /acceptance requirements/);
	assert.match(before.systemPrompt, /direct evidence needed to verify completion/);
	assert.match(harness.sent.at(-1) ?? "", /Follow the Goal planning contract/);
	assert.doesNotMatch(before.systemPrompt, /Ordinary project planning notes/);
	const prepared = await harness.executeTool("set_goal_plan", { items: STRUCTURED_ITEMS });
	assert.match(prepared.content[0].text, /Run \/goal to execute/);
	assert.equal(harness.snapshot().status, "paused");
	assert.equal(harness.snapshot().reason, "plan-ready");
	assert.equal(await readFile(join(cwd, "PLAN.md"), "utf8"), ROOT_PLAN);

	await harness.commands.get("goal").handler("", harness.ctx);
	assert.equal(harness.snapshot().status, "active");
	assert.equal(harness.snapshot().reason, undefined);
	assert.match(harness.sent.at(-1) ?? "", /Continue the active structured Goal/);
});

test("/goal runs the same structured planner first and auto-starts after installation", async () => {
	const harness = createHarness(await mkdtemp(join(tmpdir(), "mypi-goal-v3-pipeline-")));
	await harness.commands.get("goal").handler("ship it", harness.ctx);
	assert.equal(latestState(harness).workflow, "goal-planning");
	assert.equal(latestState(harness).autoStart, true);
	const lifecycle = await harness.executeTool("get_goal", {});
	assert.equal(lifecycle.details.status, "planning");
	assert.equal(lifecycle.details.autoStart, true);
	assert.doesNotMatch(lifecycle.content[0].text, /goalId|revision/);
	const pending = await harness.executeTool("get_goal_plan", {});
	assert.equal(pending.details.code, "goal-plan-pending");
	await harness.executeTool("set_goal_plan", { items: STRUCTURED_ITEMS });
	assert.equal(harness.snapshot().status, "active");
	const before = await harness.emit("before_agent_start", { prompt: "execute", systemPrompt: "base" });
	assert.match(before.systemPrompt, /Workspace claims require current file or command evidence/);
	assert.match(before.systemPrompt, /External factual claims require an opened source/);
	assert.match(before.systemPrompt, /generated summaries, search-result snippets, and model assertions are pointers/);
});

test("planning correction repeats the evidence-complete plan requirement without implementing", async () => {
	const harness = createHarness(await mkdtemp(join(tmpdir(), "mypi-goal-v3-planning-correction-")));
	await harness.commands.get("goal").handler("ship it", harness.ctx);
	await harness.emit("agent_settled", { outcome: { kind: "success" } });
	const correction = harness.customMessages.at(-1);
	assert.equal(correction.message.customType, "mypi-goal-plan-correction");
	assert.match(correction.message.content, /smallest proportional dependency-ordered plan/);
	assert.match(correction.message.content, /acceptance requirements and direct verification evidence/);
	assert.match(correction.message.content, /Do not add bookkeeping artifacts or a final-response item/);
	assert.match(correction.message.content, /Do not implement/);
});

test("unfinished /plan planning survives reload and /goal promotes the same lineage", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "mypi-goal-v3-plan-reload-"));
	const original = createHarness(cwd);
	await original.commands.get("plan").handler("ship it", original.ctx);
	const stored = latestState(original);
	assert.equal(stored.autoStart, false);

	const restored = createHarness(cwd, [{ type: "custom", customType: "mypi-goal", data: stored }]);
	await restored.emit("session_start");
	assert.equal(latestState(restored).goalId, stored.goalId);
	assert.equal(latestState(restored).autoStart, false);
	await restored.commands.get("goal").handler("", restored.ctx);
	assert.equal(latestState(restored).goalId, stored.goalId);
	assert.equal(latestState(restored).autoStart, true);
	assert.match(restored.sent.at(-1) ?? "", /Resume structured Goal planning/);
	assert.match(restored.sent.at(-1) ?? "", /acceptance requirements and direct verification evidence/);
	await restored.executeTool("set_goal_plan", { items: STRUCTURED_ITEMS });
	assert.equal(restored.snapshot().status, "active");
});

test("Goal is unbounded by default; bare and numeric --budget select adaptive or fixed grants", async () => {
  const unbounded = createHarness(await mkdtemp(join(tmpdir(), "mypi-goal-unbounded-")));
  let snapshot = await activate(unbounded);
  assert.equal(snapshot.schemaVersion, 3);
  assert.equal(snapshot.mode, "unbounded");
  assert.equal(snapshot.turnBudget, undefined);

  const adaptive = createHarness(await mkdtemp(join(tmpdir(), "mypi-goal-adaptive-")));
  snapshot = await activate(adaptive, "--budget");
  assert.equal(snapshot.mode, "adaptive");
  assert.equal(snapshot.turnBudget, 10);
  assert.equal(snapshot.noProgressLimit, 20);

  const fixed = createHarness(await mkdtemp(join(tmpdir(), "mypi-goal-fixed-")));
  snapshot = await activate(fixed, "--budget 7");
  assert.equal(snapshot.mode, "fixed");
  assert.equal(snapshot.turnBudget, 7);

  await fixed.commands.get("goal").handler("--yolo", fixed.ctx);
  assert.match(fixed.notices.at(-1)?.message ?? "", /removed because Goal is unbounded by default/);
});

test("fixed budget pauses exactly at the configured turn boundary", async () => {
  const harness = createHarness(await mkdtemp(join(tmpdir(), "mypi-goal-budget-stop-")));
  await activate(harness, "--budget 2");
  await harness.emit("turn_end", { message: { usage: { input: 2, output: 1 } } });
  assert.equal(harness.snapshot().status, "active");
  await harness.emit("turn_end", { message: { usage: { input: 2, output: 1 } } });
  assert.equal(harness.snapshot().status, "paused");
  assert.equal(harness.snapshot().reason, "step-budget");
  assert.equal(harness.snapshot().turnsUsed, 2);
});

test("adaptive budget retains five turns per item and the 20-turn no-progress stop", async () => {
  const harness = createHarness(await mkdtemp(join(tmpdir(), "mypi-goal-adaptive-stop-")));
  await harness.commands.get("goal").handler("--budget", harness.ctx);
  await harness.executeTool("set_goal_plan", { items: Array.from({ length: 5 }, (_, index) => ({ task: `Item ${index + 1}`, acceptance: ["done"], verify: ["verified"] })) });
  assert.equal(harness.snapshot().turnBudget, 25);
  for (let turn = 0; turn < 20; turn += 1) await harness.emit("turn_end", { message: { usage: { input: 1, output: 1 } } });
  assert.equal(harness.snapshot().status, "paused");
  assert.equal(harness.snapshot().reason, "no-progress");
  assert.equal(harness.snapshot().turnsUsed, 20);
});

test("invalid budgets fail explicitly without partial planning", async () => {
  const invalidBudget = createHarness(await mkdtemp(join(tmpdir(), "mypi-goal-budget-invalid-")));
  await invalidBudget.commands.get("goal").handler("--budget 0", invalidBudget.ctx);
  assert.match(invalidBudget.notices.at(-1)?.message ?? "", /integer from 1 through 10000/);
  assert.equal(latestState(invalidBudget), undefined);
});

test("structured updates are session-bound, atomic, and completion requires evidence", async () => {
  const harness = createHarness(await mkdtemp(join(tmpdir(), "mypi-goal-update-")));
  await activate(harness);
  let result = await harness.executeTool("update_goal_plan", { operations: [{ op: "set_checked", itemId: "I001", checked: true }, { op: "add_evidence", itemId: "I001", evidence: "parser test passed" }] });
  assert.equal(result.details.accepted, true);
  result = await harness.executeTool("update_goal_plan", { operations: [{ op: "set_checked", itemId: "I002", checked: true }] });
  assert.equal(result.details.accepted, true);
  const early = await harness.executeTool("update_goal", { status: "complete" });
  assert.match(early.content[0].text, /evidence is missing/i);
  await harness.executeTool("update_goal_plan", { operations: [{ op: "add_evidence", itemId: "I002", evidence: "docs inspected" }] });
  const complete = await harness.executeTool("update_goal", { status: "complete" });
  assert.equal(complete.details.accepted, true);
  assert.equal(complete.terminate, undefined);
  assert.match(complete.content[0].text, /final response/i);
  assert.equal(harness.snapshot().status, "complete");
});

test("Goal completion waits for owned subagents and consumes their pending results first (BUG-115)", async () => {
	const harness = createHarness(await mkdtemp(join(tmpdir(), "mypi-goal-subagent-completion-")));
	await activate(harness);
	await harness.executeTool("update_goal_plan", { operations: [
		{ op: "set_checked", itemId: "I001", checked: true },
		{ op: "add_evidence", itemId: "I001", evidence: "API verified" },
		{ op: "set_checked", itemId: "I002", checked: true },
		{ op: "add_evidence", itemId: "I002", evidence: "Docs verified" },
	] });

	harness.emitBus("mypi:subagent-wait-state", { active: 1, pending: 0 });
	let result = await harness.executeTool("update_goal", { status: "complete" });
	assert.equal(result.details.accepted, false);
	assert.match(result.content[0].text, /still active/i);
	harness.emitBus("mypi:subagent-wait-state", { active: 0, pending: 1 });
	result = await harness.executeTool("update_goal", { status: "complete" });
	assert.equal(result.details.accepted, false);
	assert.match(result.content[0].text, /unconsumed/i);
	harness.emitBus("mypi:subagent-wait-state", { active: 0, pending: 0 });
	result = await harness.executeTool("update_goal", { status: "complete" });
	assert.equal(result.details.accepted, true);
});

test("lifecycle revision churn cannot stale the next-turn plan update (BUG-105)", async () => {
  const harness = createHarness(await mkdtemp(join(tmpdir(), "mypi-goal-cross-turn-update-")));
  await activate(harness);
  const plan = await harness.executeTool("get_goal_plan", { view: "next" });
  assert.doesNotMatch(plan.content[0].text, /goalId|revision/);

  await harness.emit("turn_end", { message: { usage: { input: 10, output: 5 } } });
  await harness.emit("agent_settled", { outcome: { kind: "success" } });
  await harness.emit("agent_start");

  const result = await harness.executeTool("update_goal_plan", {
    operations: [
      { op: "set_checked", itemId: "I001", checked: true },
      { op: "add_evidence", itemId: "I001", evidence: "cross-turn verification passed" },
    ],
  });
  assert.equal(result.details.accepted, true);
  assert.equal(harness.snapshot().checkedItems, 1);
});

test("repeated Goal tool rejection pauses instead of looping indefinitely", async () => {
  const harness = createHarness(await mkdtemp(join(tmpdir(), "mypi-goal-tool-loop-")));
  await activate(harness);
  const invalid = { operations: [{ op: "set_checked", itemId: "I999", checked: true }] };

  let result = await harness.executeTool("update_goal_plan", invalid);
  assert.equal(result.details.repeatedRejections, 1);
  result = await harness.executeTool("update_goal_plan", invalid);
  assert.equal(result.details.repeatedRejections, 2);
  result = await harness.executeTool("update_goal_plan", invalid);
  assert.equal(result.details.code, "goal-tool-loop");
  assert.equal(result.terminate, true);
  assert.equal(harness.snapshot().status, "paused");
  assert.equal(harness.snapshot().reason, "error:goal-tool-loop");
  assert.equal(harness.aborts, 1);
});

test("no-op plan updates are rejected and do not masquerade as progress", async () => {
  const harness = createHarness(await mkdtemp(join(tmpdir(), "mypi-goal-no-op-update-")));
  await activate(harness);
  const noOp = { operations: [{ op: "set_checked", itemId: "I001", checked: false }] };

  const result = await harness.executeTool("update_goal_plan", noOp);
  assert.equal(result.details.code, "no-plan-change");
  assert.equal(result.details.repeatedRejections, 1);
  assert.equal(harness.snapshot().checkedItems, 0);
  assert.equal(harness.snapshot().status, "active");
});

test("three protected mutations warn exactly and the third aborts and blocks", async () => {
  const harness = createHarness(await mkdtemp(join(tmpdir(), "mypi-goal-three-strike-")));
  await activate(harness);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await harness.executeTool("set_goal_plan", { items: [{ task: "smaller", acceptance: ["less"], verify: ["none"] }] });
    assert.match(result.content[0].text, new RegExp(`\\(${attempt}/3\\)`));
  }
  assert.equal(harness.snapshot().status, "blocked");
  assert.equal(harness.snapshot().reason, "plan-invalidated");
  assert.equal(harness.snapshot().protectedMutationAttempts, 3);
  assert.equal(harness.aborts, 1);
});

test("strengthening proposals identify exact protected requirement weakening", async () => {
  const harness = createHarness(await mkdtemp(join(tmpdir(), "mypi-goal-strengthen-")));
  await activate(harness);
  const result = await harness.executeTool("update_goal_plan", { operations: [{ op: "strengthen_item", itemId: "I001", task: "Preserve the API", acceptance: ["easier"], verify: ["node --test"] }] });
  assert.match(result.content[0].text, /protected acceptance requirements were removed or weakened for item I001/);
  assert.equal(result.details.attempts, 1);
});

test("Goal v2 is detected on the current branch and never resumed", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "mypi-goal-v2-"));
  const harness = createHarness(cwd, [{ type: "custom", customType: "mypi-plan-goal", data: { schemaVersion: 2, workflow: "goal", status: "active" } }]);
  await harness.emit("session_start");
  assert.equal(harness.statuses.get("plan-goal"), "GOAL UNSUPPORTED · v2");
  await harness.commands.get("goal").handler("--continue", harness.ctx);
  assert.match(harness.notices.at(-1)?.message ?? "", /unsupported and cannot continue/);
  assert.equal(harness.sent.length, 0);
});

test("reload restores only current-branch v3 state and pauses active execution", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "mypi-goal-reload-"));
  const original = createHarness(cwd);
  await activate(original);
  const stored = latestState(original);
  const restored = createHarness(cwd, [{ type: "custom", customType: "mypi-goal", data: stored }]);
  await restored.emit("session_start");
  assert.equal(restored.snapshot().status, "paused");
  assert.equal(restored.snapshot().reason, "reload");
  assert.equal(restored.snapshot().deferred, true);
});

test("restore rewrites early Goal v3 planning state without retired file payloads", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "mypi-goal-planning-rewrite-"));
  const stored = {
    schemaVersion: 3,
    workflow: "goal-planning",
    goalId: "goal-old-planning",
    objective: "ship it",
    budget: { kind: "unbounded" },
    importedPlan: { text: "secret old file payload", sha256: "a".repeat(64), bytes: 23, importedAt: new Date().toISOString() },
    planAgentEnds: 0,
    toolsBeforePlan: ["read", "bash"],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const restored = createHarness(cwd, [{ type: "custom", customType: "mypi-goal", data: stored }]);
  await restored.emit("session_start");
  assert.equal(latestState(restored).workflow, "goal-planning");
  assert.equal(latestState(restored).autoStart, true);
  assert.equal("importedPlan" in latestState(restored), false);
});

test("continue starts a fresh grant and resets protected-mutation warnings", async () => {
  const harness = createHarness(await mkdtemp(join(tmpdir(), "mypi-goal-warning-reset-")));
  await activate(harness);
  let result = await harness.executeTool("set_goal_plan", { items: [{ task: "smaller", acceptance: ["less"], verify: ["none"] }] });
  assert.equal(result.details.attempts, 1);
  await harness.commands.get("goal").handler("--pause", harness.ctx);
  await harness.commands.get("goal").handler("--continue --budget 4", harness.ctx);
  assert.equal(harness.snapshot().mode, "fixed");
  assert.equal(harness.snapshot().turnBudget, 4);
  assert.equal(harness.snapshot().protectedMutationAttempts, 0);
  result = await harness.executeTool("set_goal_plan", { items: [{ task: "smaller", acceptance: ["less"], verify: ["none"] }] });
  assert.equal(result.details.attempts, 1);
});

test("corrupt v3 planning state is blocked on restore", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "mypi-goal-corrupt-planning-"));
  const harness = createHarness(cwd, [{ type: "custom", customType: "mypi-goal", data: { schemaVersion: 3, workflow: "goal-planning", objective: "missing durable fields" } }]);
  await harness.emit("session_start");
  assert.equal(harness.statuses.get("plan-goal"), "GOAL BLOCKED · corrupt-state");
  await harness.commands.get("goal").handler("--continue", harness.ctx);
  assert.match(harness.notices.at(-1)?.message ?? "", /corrupt/i);
});

test("project planning files are ordinary workspace content while provider failures still stop unbounded runs", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "mypi-goal-policy-"));
  await writeFile(join(cwd, "PLAN.md"), ROOT_PLAN, "utf8");
  const harness = createHarness(cwd);
  await activate(harness);
  const edit = await harness.emit("tool_call", { toolName: "edit", input: { path: "PLAN.md" } });
  assert.equal(edit, undefined);
  await harness.emit("after_provider_response", { status: 429, headers: { "retry-after": "30" } });
  await harness.emit("agent_settled", { outcome: { kind: "success" } });
  assert.equal(harness.snapshot().status, "usage-limited");
  assert.equal(harness.snapshot().retryAfter, "30");
});

test("active Goal parks continuation while asynchronous subagents are the sole dependency (BUG-097)", async () => {
	const harness = createHarness(await mkdtemp(join(tmpdir(), "mypi-goal-v3-subagent-park-")));
	await activate(harness);
	const continuations = () =>
		harness.customMessages.filter((entry) => entry.message.customType === "mypi-goal-continuation").length;
	const baseline = continuations();

	// Waiting on a live child: repeated settles issue zero provider-waking continuations.
	harness.emitBus("mypi:subagent-wait-state", { active: 1 });
	await harness.emit("agent_settled", { outcome: { kind: "success" } });
	await harness.emit("agent_settled", { outcome: { kind: "success" } });
	await harness.emit("agent_settled", { outcome: { kind: "success" } });
	assert.equal(continuations(), baseline, "parked settles issue no continuation");
	assert.equal(latestState(harness).status, "active", "waiting is a lifecycle yield, not completion or blockage");
	assert.equal(latestState(harness).continuationPending, false);
	const parkedTurns = latestState(harness).turnsUsed;

	// Queued user work retains precedence over the park: the Goal yields the
	// boundary without pausing and without a competing continuation.
	harness.setPendingMessages(true);
	await harness.emit("agent_settled", { outcome: { kind: "success" } });
	assert.equal(latestState(harness).status, "active", "queued guidance never pauses the Goal");
	assert.equal(continuations(), baseline, "the queued message owns the boundary");
	harness.setPendingMessages(false);

	// After children settle, the next boundary continues exactly once.
	harness.emitBus("mypi:subagent-wait-state", { active: 0 });
	await harness.emit("agent_settled", { outcome: { kind: "success" } });
	assert.equal(continuations(), baseline + 1);
	assert.equal(latestState(harness).turnsUsed, parkedTurns, "parked settles inflate no turn counters");
});

test("Goal planning parks the correction resend while planning subagents run (BUG-097)", async () => {
	const harness = createHarness(await mkdtemp(join(tmpdir(), "mypi-goal-v3-planning-park-")));
	await harness.commands.get("goal").handler("ship it", harness.ctx);
	const corrections = () =>
		harness.customMessages.filter((entry) => entry.message.customType === "mypi-goal-plan-correction").length;

	harness.emitBus("mypi:subagent-wait-state", { active: 2 });
	await harness.emit("agent_settled", { outcome: { kind: "success" } });
	await harness.emit("agent_settled", { outcome: { kind: "success" } });
	assert.equal(corrections(), 0, "parked planning settles send no correction");
	assert.equal(latestState(harness).workflow, "goal-planning", "parked settles consume no planning attempt");

	harness.emitBus("mypi:subagent-wait-state", { active: 0 });
	await harness.emit("agent_settled", { outcome: { kind: "success" } });
	assert.equal(corrections(), 1, "the released boundary sends exactly one correction");
	assert.equal(latestState(harness).workflow, "goal-planning");
});

test("typed user guidance steers an active Goal without pausing it", async () => {
	const harness = createHarness(await mkdtemp(join(tmpdir(), "mypi-goal-v3-steer-")));
	await activate(harness);
	const continuations = () =>
		harness.customMessages.filter((entry) => entry.message.customType === "mypi-goal-continuation").length;
	const baseline = continuations();

	// A steer message arrives mid-run: no takeover, no pause.
	await harness.emit("input", { source: "interactive", text: "prefer the smaller refactor" });
	assert.equal(latestState(harness).status, "active");
	assert.equal(latestState(harness).deferred, false, "guidance never marks the Goal deferred");

	// The guided run settles: the Goal continues automatically.
	await harness.emit("agent_settled", { outcome: { kind: "success" } });
	assert.equal(latestState(harness).status, "active");
	assert.equal(continuations(), baseline + 1, "execution resumes after guided settlement");

	// A queued follow-up yields exactly one boundary, then execution resumes.
	harness.setPendingMessages(true);
	await harness.emit("agent_settled", { outcome: { kind: "success" } });
	assert.equal(latestState(harness).status, "active");
	assert.equal(continuations(), baseline + 1, "no competing continuation while the queue owns the turn");
	harness.setPendingMessages(false);
	await harness.emit("agent_settled", { outcome: { kind: "success" } });
	assert.equal(continuations(), baseline + 2);

	// Esc/abort remains the explicit interrupt that pauses the Goal.
	await harness.emit("agent_settled", { outcome: { kind: "aborted" } });
	assert.equal(latestState(harness).status, "paused");
	assert.equal(latestState(harness).pauseReason, "user-interrupt");
});
