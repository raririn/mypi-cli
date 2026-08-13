import assert from "node:assert/strict";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import planGoalExtension from "../../vendor/pi/packages/coding-agent/src/extensions/mypi/plan-goal.ts";

const ROOT_PLAN = `# User plan\n\n- [ ] Preserve the API\n  <!-- acceptance: API remains stable -->\n  <!-- verify: node --test -->\n`;
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
  let activeTools = ["read", "write", "edit", "bash"];
  let idle = true;
  let pendingMessages = false;
  let aborts = 0;

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
      input: async () => undefined,
      editor: async (title: string, content: string) => { editors.push({ title, content }); },
    },
  };
  const pi = {
    appendEntry: (customType: string, data: unknown) => persisted.push({ customType, data }),
    events: { emit: () => undefined },
    getActiveTools: () => [...activeTools],
    getAllTools: () => ["read", "write", "edit", "bash", ...tools.keys()].map((name) => ({ name })),
    setActiveTools: (next: string[]) => { activeTools = [...next]; },
    sendUserMessage: (message: string) => { sent.push(message); },
    sendMessage: (message: any, options: any) => { customMessages.push({ message, options }); },
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

  return {
    commands, tools, ctx, emit, executeTool, snapshot, persisted, sent, customMessages,
    notices, editors, statuses,
    setPendingMessages(value: boolean) { pendingMessages = value; },
    setIdle(value: boolean) { idle = value; },
    get activeTools() { return activeTools; },
    get aborts() { return aborts; },
  };
}

function latestState(harness: ReturnType<typeof createHarness>): any {
  return harness.persisted.filter((entry) => entry.customType === "mypi-goal").at(-1)?.data;
}

async function activate(harness: ReturnType<typeof createHarness>, args = "") {
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
});

test("root PLAN.md is imported once as untrusted planning data and remains untouched", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "mypi-goal-v3-import-"));
  await writeFile(join(cwd, "PLAN.md"), ROOT_PLAN, "utf8");
  const harness = createHarness(cwd);
  await harness.commands.get("goal").handler("preserve behavior", harness.ctx);
  assert.equal(latestState(harness).workflow, "goal-planning");
  assert.equal(latestState(harness).importedPlan.text, ROOT_PLAN);
  const before = await harness.emit("before_agent_start", { prompt: "plan", systemPrompt: "base" });
  assert.match(before.systemPrompt, /untrusted planning data only/);
  assert.match(before.systemPrompt, /Root PLAN\.md is immutable to Goal/);
  await harness.executeTool("set_goal_plan", { items: STRUCTURED_ITEMS });
  assert.equal(latestState(harness).importedPlan, undefined);
  assert.equal(await (await import("node:fs/promises")).readFile(join(cwd, "PLAN.md"), "utf8"), ROOT_PLAN);
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

test("budget and PLAN import bounds fail explicitly without partial planning", async () => {
  const invalidBudget = createHarness(await mkdtemp(join(tmpdir(), "mypi-goal-budget-invalid-")));
  await invalidBudget.commands.get("goal").handler("--budget 0", invalidBudget.ctx);
  assert.match(invalidBudget.notices.at(-1)?.message ?? "", /integer from 1 through 10000/);
  assert.equal(latestState(invalidBudget), undefined);

  const oversizedCwd = await mkdtemp(join(tmpdir(), "mypi-goal-import-large-"));
  await writeFile(join(oversizedCwd, "PLAN.md"), "x".repeat(256 * 1024 + 1), "utf8");
  const oversized = createHarness(oversizedCwd);
  await oversized.commands.get("goal").handler("ship", oversized.ctx);
  assert.match(oversized.notices.at(-1)?.message ?? "", /never truncates/);
  assert.equal(latestState(oversized), undefined);

  const symlinkCwd = await mkdtemp(join(tmpdir(), "mypi-goal-import-link-"));
  await writeFile(join(symlinkCwd, "outside.md"), ROOT_PLAN, "utf8");
  await symlink(join(symlinkCwd, "outside.md"), join(symlinkCwd, "PLAN.md"));
  const linked = createHarness(symlinkCwd);
  await linked.commands.get("goal").handler("ship", linked.ctx);
  assert.match(linked.notices.at(-1)?.message ?? "", /regular non-symbolic-link/);
  assert.equal(latestState(linked), undefined);

  const invalidUtf8Cwd = await mkdtemp(join(tmpdir(), "mypi-goal-import-utf8-"));
  await writeFile(join(invalidUtf8Cwd, "PLAN.md"), Buffer.from([0xc3, 0x28]));
  const invalidUtf8 = createHarness(invalidUtf8Cwd);
  await invalidUtf8.commands.get("goal").handler("ship", invalidUtf8.ctx);
  assert.match(invalidUtf8.notices.at(-1)?.message ?? "", /not valid UTF-8/);
  assert.equal(latestState(invalidUtf8), undefined);

  const exactLimitCwd = await mkdtemp(join(tmpdir(), "mypi-goal-import-limit-"));
  await writeFile(join(exactLimitCwd, "PLAN.md"), "x".repeat(256 * 1024), "utf8");
  const exactLimit = createHarness(exactLimitCwd);
  await exactLimit.commands.get("goal").handler("ship", exactLimit.ctx);
  assert.equal(latestState(exactLimit).importedPlan.bytes, 256 * 1024);

  const bomCwd = await mkdtemp(join(tmpdir(), "mypi-goal-import-bom-"));
  await writeFile(join(bomCwd, "PLAN.md"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(ROOT_PLAN)]));
  const bom = createHarness(bomCwd);
  await bom.commands.get("goal").handler("ship", bom.ctx);
  const restoredBom = createHarness(bomCwd, [{ type: "custom", customType: "mypi-goal", data: latestState(bom) }]);
  await restoredBom.emit("session_start");
  assert.equal(restoredBom.statuses.get("plan-goal"), "GOAL · PLANNING");
});

test("structured updates are revision-checked, atomic, and completion requires evidence", async () => {
  const harness = createHarness(await mkdtemp(join(tmpdir(), "mypi-goal-update-")));
  await activate(harness);
  let snapshot = harness.snapshot();
  const stale = await harness.executeTool("update_goal_plan", { goalId: snapshot.goalId, revision: snapshot.revision - 1, operations: [{ op: "set_checked", itemId: "I001", checked: true }] });
  assert.equal(stale.details.code, "revision-conflict");

  let result = await harness.executeTool("update_goal_plan", { goalId: snapshot.goalId, revision: snapshot.revision, operations: [{ op: "set_checked", itemId: "I001", checked: true }, { op: "add_evidence", itemId: "I001", evidence: "parser test passed" }] });
  assert.equal(result.details.accepted, true);
  snapshot = harness.snapshot();
  result = await harness.executeTool("update_goal_plan", { goalId: snapshot.goalId, revision: snapshot.revision, operations: [{ op: "set_checked", itemId: "I002", checked: true }] });
  assert.equal(result.details.accepted, true);
  const early = await harness.executeTool("update_goal", { status: "complete" });
  assert.match(early.content[0].text, /evidence is missing/i);
  snapshot = harness.snapshot();
  await harness.executeTool("update_goal_plan", { goalId: snapshot.goalId, revision: snapshot.revision, operations: [{ op: "add_evidence", itemId: "I002", evidence: "docs inspected" }] });
  const complete = await harness.executeTool("update_goal", { status: "complete" });
  assert.equal(complete.details.accepted, true);
  assert.equal(harness.snapshot().status, "complete");
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
  const snapshot = harness.snapshot();
  const result = await harness.executeTool("update_goal_plan", { goalId: snapshot.goalId, revision: snapshot.revision, operations: [{ op: "strengthen_item", itemId: "I001", task: "Preserve the API", acceptance: ["easier"], verify: ["node --test"] }] });
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

test("PLAN.md edit tools are blocked during active Goal while provider failures still stop unbounded runs", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "mypi-goal-policy-"));
  await writeFile(join(cwd, "PLAN.md"), ROOT_PLAN, "utf8");
  const harness = createHarness(cwd);
  await activate(harness);
  const edit = await harness.emit("tool_call", { toolName: "edit", input: { path: "PLAN.md" } });
  assert.equal(edit.block, true);
  assert.match(edit.reason, /immutable to Goal v3/);
  await harness.emit("after_provider_response", { status: 429, headers: { "retry-after": "30" } });
  await harness.emit("agent_settled", { outcome: { kind: "success" } });
  assert.equal(harness.snapshot().status, "usage-limited");
  assert.equal(harness.snapshot().retryAfter, "30");
});
