import assert from "node:assert/strict";
import { mkdtemp, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import planGoalExtension from "../../vendor/pi/packages/coding-agent/src/extensions/mypi/plan-goal.ts";

interface Notice {
  message: string;
  level: string;
}

const PLAN = `# Plan

- [ ] Build the protected behavior
  <!-- acceptance: scope remains immutable -->
  <!-- verify: node --test goal -->
`;

function createHarness(cwd: string, initialEntries: unknown[] = []) {
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const statuses = new Map<string, string | undefined>();
  const sent: string[] = [];
  const customMessages: Array<{ message: any; options: any }> = [];
  const persisted: Array<{ customType: string; data: any }> = [];
  const notices: Notice[] = [];
  const editors: Array<{ title: string; content: string }> = [];
  let activeTools = ["read", "write", "edit", "bash"];
  let idle = true;
  let pendingMessages = false;
  let aborts = 0;
  let nextSendUserFailure: Error | undefined;
  let nextSendMessageFailure: Error | undefined;

  const ctx = {
    cwd,
    mode: "rpc",
    isIdle: () => idle,
    hasPendingMessages: () => pendingMessages,
    abort: () => { aborts += 1; },
    sessionManager: { getEntries: () => initialEntries },
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
    sendUserMessage: (message: string) => {
      if (nextSendUserFailure) {
        const error = nextSendUserFailure;
        nextSendUserFailure = undefined;
        throw error;
      }
      sent.push(message);
    },
    sendMessage: (message: any, options: any) => {
      if (nextSendMessageFailure) {
        const error = nextSendMessageFailure;
        nextSendMessageFailure = undefined;
        throw error;
      }
      customMessages.push({ message, options });
    },
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    on: (name: string, handler: (event: any, ctx: any) => unknown) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
  };
  planGoalExtension(pi as never);

  async function emit(name: string, event: any = {}): Promise<unknown> {
    let result: unknown;
    for (const handler of handlers.get(name) ?? []) {
      const next = await handler(event, ctx);
      if (next !== undefined) result = next;
    }
    return result;
  }

  async function executeTool(name: string, params: unknown): Promise<any> {
    const tool = tools.get(name);
    assert.ok(tool, `missing registered tool ${name}`);
    return tool.execute("tool-call", params, new AbortController().signal, () => {}, ctx);
  }

  function snapshot(): any {
    const value = statuses.get("mypi-goal-snapshot");
    return value ? JSON.parse(value) : undefined;
  }

  return {
    commands,
    tools,
    ctx,
    emit,
    executeTool,
    snapshot,
    persisted,
    sent,
    customMessages,
    notices,
    editors,
    statuses,
    setIdle(value: boolean) { idle = value; },
    setPendingMessages(value: boolean) { pendingMessages = value; },
    failNextSendUser(message: string) { nextSendUserFailure = new Error(message); },
    failNextSendMessage(message: string) { nextSendMessageFailure = new Error(message); },
    get activeTools() { return activeTools; },
    get aborts() { return aborts; },
  };
}

function latestGoalState(harness: ReturnType<typeof createHarness>): any {
  return harness.persisted.filter((entry) => entry.customType === "mypi-plan-goal").at(-1)?.data;
}

test("registers standardized goal tools with extension-owned transitions", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "mypi-goal-tools-"));
  const harness = createHarness(cwd);

  assert.deepEqual([...harness.tools.keys()], ["get_goal", "create_goal", "update_goal"]);
  assert.equal(harness.tools.get("create_goal").executionMode, "sequential");
  assert.equal(harness.tools.get("update_goal").executionMode, "sequential");
  assert.match(harness.tools.get("create_goal").description, /explicitly requested/i);
  assert.match(harness.tools.get("update_goal").description, /validates immutable PLAN\.md scope/i);
  const report = await harness.executeTool("get_goal", {});
  assert.match(report.content[0].text, /No goal exists/);
});

test("goal --yolo starts the current schema without a token budget and injects the Goal prompt", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "mypi-goal-yolo-"));
  await writeFile(join(cwd, "PLAN.md"), PLAN, "utf8");
  const harness = createHarness(cwd);

  await harness.commands.get("goal").handler("--yolo preserve verification", harness.ctx);

  const snapshot = harness.snapshot();
  assert.equal(snapshot.schemaVersion, 2);
  assert.equal(snapshot.status, "active");
  assert.equal(snapshot.mode, "yolo");
  assert.equal(snapshot.turnBudget, undefined);
  assert.equal(snapshot.tokensUsed, 0);
  assert.deepEqual(snapshot.availableActions, ["report", "pause", "abort"]);
  assert.equal(latestGoalState(harness).baseline.items[0].acceptance[0], "scope remains immutable");
  assert.match(harness.sent[0], /Execute the complete goal described by PLAN\.md/);

  const before = await harness.emit("before_agent_start", { prompt: "continue", systemPrompt: "base" }) as any;
  assert.match(before.systemPrompt, /\[MYPI GOAL\]/);
  assert.match(before.systemPrompt, /deleting, reordering, rewriting, watering down/i);
  assert.match(before.systemPrompt, /Supplemental instructions: preserve verification/);
});

test("missing PLAN enters the same enforced plan workflow before the shared goal start", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "mypi-goal-plan-first-"));
  const harness = createHarness(cwd);

  await harness.commands.get("goal").handler("--yolo keep APIs", harness.ctx);
  assert.equal(harness.statuses.get("plan-goal"), "PLAN · FOR GOAL");
  assert.deepEqual(harness.activeTools.sort(), ["edit", "read", "write"]);
  assert.match(harness.sent[0], /Create a concrete implementation plan/);
  assert.match(harness.sent[0], /do not implement/i);

  await writeFile(join(cwd, "PLAN.md"), PLAN, "utf8");
  await harness.emit("agent_end", { messages: [] });
  await harness.emit("agent_settled", { outcome: { kind: "success" } });

  assert.equal(harness.snapshot().status, "active");
  assert.equal(harness.snapshot().mode, "yolo");
  assert.deepEqual(harness.activeTools, ["read", "write", "edit", "bash"]);
  assert.equal(harness.sent.length, 2);
  assert.match(harness.notices.at(-1)?.message ?? "", /shared goal-start contract/i);
});

test("active goals reject batched edits that rewrite or weaken protected scope", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "mypi-goal-edit-guard-"));
  await writeFile(join(cwd, "PLAN.md"), PLAN, "utf8");
  const harness = createHarness(cwd);
  await harness.commands.get("goal").handler("", harness.ctx);

  const rewrite = await harness.emit("tool_call", {
    toolName: "edit",
    input: { path: "PLAN.md", edits: [{ oldText: "Build the protected behavior", newText: "Build less behavior" }] },
  }) as any;
  assert.equal(rewrite.block, true);
  assert.match(rewrite.reason, /deleted or rewritten/);

  const weaken = await harness.emit("tool_call", {
    toolName: "edit",
    input: { path: "PLAN.md", edits: [{ oldText: "  <!-- acceptance: scope remains immutable -->\n", newText: "" }] },
  }) as any;
  assert.equal(weaken.block, true);
  assert.match(weaken.reason, /acceptance requirements/);

  const evidence = await harness.emit("tool_call", {
    toolName: "edit",
    input: { path: "PLAN.md", edits: [{ oldText: "  <!-- verify: node --test goal -->", newText: "  <!-- verify: node --test goal -->\n  <!-- evidence: matrix passed -->" }] },
  });
  assert.equal(evidence, undefined);
});

test("create_goal requires explicit top-level consent and rejects replacement of unfinished work", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "mypi-create-goal-"));
  await writeFile(join(cwd, "PLAN.md"), PLAN, "utf8");
  const harness = createHarness(cwd);

  await harness.emit("before_agent_start", { prompt: "Implement the request", systemPrompt: "base" });
  const rejected = await harness.executeTool("create_goal", { objective: "Implement the request" });
  assert.equal(rejected.details.code, "explicit-consent-required");

  await harness.emit("before_agent_start", { prompt: "Create a goal to implement the request", systemPrompt: "base" });
  const accepted = await harness.executeTool("create_goal", { objective: "Implement the request" });
  assert.equal(accepted.details.accepted, true);
  assert.equal(accepted.terminate, true);
  await harness.emit("agent_settled", { outcome: { kind: "success" } });
  assert.equal(harness.snapshot().status, "active");
  assert.match(harness.snapshot().objective, /Implement the request/);

  await harness.emit("before_agent_start", { prompt: "Create a new goal", systemPrompt: "base" });
  const duplicate = await harness.executeTool("create_goal", { objective: "Replace protected scope" });
  assert.equal(duplicate.details.code, "goal-already-active");
});

test("update_goal cannot complete early and retires PLAN only after mechanical proof", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "mypi-update-goal-"));
  await writeFile(join(cwd, "PLAN.md"), PLAN, "utf8");
  const harness = createHarness(cwd);
  await harness.commands.get("goal").handler("", harness.ctx);

  const early = await harness.executeTool("update_goal", { status: "complete" });
  assert.equal(early.details.code, "completion-unproven");
  assert.match(early.content[0].text, /1 checklist items remain/);

  await writeFile(join(cwd, "PLAN.md"), PLAN.replace("- [ ]", "- [x]"), "utf8");
  const completed = await harness.executeTool("update_goal", { status: "complete" });
  assert.equal(completed.details.accepted, true);
  assert.equal(completed.terminate, true);
  assert.equal(harness.snapshot().status, "complete");
  const files = await readdir(cwd);
  assert.equal(files.includes("PLAN.md"), false);
  assert.equal(files.some((name) => /^PLAN-\d{8}-\d{6}\.md$/.test(name)), true);
});

test("an already complete valid plan retires immediately without an agent turn", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "mypi-goal-complete-"));
  await writeFile(join(cwd, "PLAN.md"), PLAN.replace("- [ ]", "- [x]"), "utf8");
  const harness = createHarness(cwd);

  await harness.commands.get("goal").handler("", harness.ctx);

  assert.deepEqual(harness.sent, []);
  assert.equal(harness.snapshot().status, "complete");
  assert.match(harness.notices.at(-1)?.message ?? "", /Goal complete/);
});

test("three identical settled blockers stop continuation mechanically", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "mypi-goal-blocker-"));
  const blockedPlan = PLAN.replace(
    "  <!-- verify: node --test goal -->",
    "  <!-- verify: node --test goal -->\n  <!-- blocked: external dependency unavailable -->",
  );
  await writeFile(join(cwd, "PLAN.md"), PLAN, "utf8");
  const harness = createHarness(cwd);
  await harness.commands.get("goal").handler("", harness.ctx);
  await writeFile(join(cwd, "PLAN.md"), blockedPlan, "utf8");

  for (let run = 1; run <= 3; run += 1) {
    if (run > 1) await harness.emit("agent_start");
    await harness.emit("agent_settled", { outcome: { kind: "success" } });
    assert.equal(harness.snapshot().blockedRuns, run);
  }
  assert.equal(harness.snapshot().status, "blocked");
  assert.equal(harness.customMessages.length, 2, "the third blocker must not enqueue another continuation");
  assert.match(harness.notices.at(-1)?.message ?? "", /three settled runs/);
});

test("provider limits and typed compaction failure stop even YOLO goals", async () => {
  const quotaCwd = await mkdtemp(join(tmpdir(), "mypi-goal-quota-"));
  await writeFile(join(quotaCwd, "PLAN.md"), PLAN, "utf8");
  const quota = createHarness(quotaCwd);
  await quota.commands.get("goal").handler("--yolo", quota.ctx);
  await quota.emit("after_provider_response", { status: 429, headers: { "retry-after": "30" } });
  await quota.emit("agent_settled", { outcome: { kind: "success" } });
  assert.equal(quota.snapshot().status, "usage-limited");
  assert.equal(quota.snapshot().retryAfter, "30");
  assert.equal(quota.customMessages.length, 0);

  const compactCwd = await mkdtemp(join(tmpdir(), "mypi-goal-compact-"));
  await writeFile(join(compactCwd, "PLAN.md"), PLAN, "utf8");
  const compact = createHarness(compactCwd);
  await compact.commands.get("goal").handler("--yolo", compact.ctx);
  await compact.emit("agent_settled", { outcome: { kind: "compaction-error", errorMessage: "summary failed" } });
  assert.equal(compact.snapshot().status, "blocked");
  assert.equal(compact.snapshot().reason, "error:compaction");
  assert.equal(compact.customMessages.length, 0);
});

test("synchronous initial and continuation dispatch failures block instead of stranding active automation", async () => {
  const initialCwd = await mkdtemp(join(tmpdir(), "mypi-goal-initial-dispatch-"));
  await writeFile(join(initialCwd, "PLAN.md"), PLAN, "utf8");
  const initial = createHarness(initialCwd);
  initial.failNextSendUser("provider credentials unavailable");
  await initial.commands.get("goal").handler("", initial.ctx);
  assert.equal(initial.snapshot().status, "blocked");
  assert.equal(initial.snapshot().reason, "error:dispatch");
  assert.deepEqual(initial.snapshot().availableActions, ["report", "continue", "continue-yolo", "abort"]);
  assert.match(initial.notices.at(-1)?.message ?? "", /provider credentials unavailable/);

  const continuationCwd = await mkdtemp(join(tmpdir(), "mypi-goal-continuation-dispatch-"));
  await writeFile(join(continuationCwd, "PLAN.md"), PLAN, "utf8");
  const continuation = createHarness(continuationCwd);
  await continuation.commands.get("goal").handler("", continuation.ctx);
  continuation.failNextSendMessage("continuation queue unavailable");
  await continuation.emit("agent_settled", { outcome: { kind: "success" } });
  assert.equal(continuation.snapshot().status, "blocked");
  assert.equal(continuation.snapshot().reason, "error:dispatch");
  assert.equal(continuation.snapshot().deferred, false);
  assert.match(continuation.notices.at(-1)?.message ?? "", /continuation queue unavailable/);
});

test("real input and queued messages defer automatic continuation", async () => {
  const inputCwd = await mkdtemp(join(tmpdir(), "mypi-goal-input-"));
  await writeFile(join(inputCwd, "PLAN.md"), PLAN, "utf8");
  const input = createHarness(inputCwd);
  await input.commands.get("goal").handler("", input.ctx);
  await input.emit("input", { source: "user", text: "take over" });
  await input.emit("agent_settled", { outcome: { kind: "success" } });
  assert.equal(input.snapshot().status, "paused");
  assert.equal(input.snapshot().reason, "user-interrupt");

  const queuedCwd = await mkdtemp(join(tmpdir(), "mypi-goal-queued-"));
  await writeFile(join(queuedCwd, "PLAN.md"), PLAN, "utf8");
  const queued = createHarness(queuedCwd);
  await queued.commands.get("goal").handler("", queued.ctx);
  queued.setPendingMessages(true);
  await queued.emit("agent_settled", { outcome: { kind: "success" } });
  assert.equal(queued.snapshot().status, "paused");
  assert.equal(queued.customMessages.length, 0);
});

test("turn usage counts uncached input plus output and reload pauses active automation", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "mypi-goal-ledger-"));
  await writeFile(join(cwd, "PLAN.md"), PLAN, "utf8");
  const harness = createHarness(cwd);
  await harness.commands.get("goal").handler("", harness.ctx);
  await harness.emit("turn_end", { message: { usage: { input: 120, output: 30, cacheRead: 900 } } });
  assert.equal(harness.snapshot().tokensUsed, 150);
  assert.equal(harness.snapshot().turnsUsed, 1);

  const stored = latestGoalState(harness);
  const restored = createHarness(cwd, [{ type: "custom", customType: "mypi-plan-goal", data: stored }]);
  await restored.emit("session_start");
  assert.equal(restored.snapshot().status, "paused");
  assert.equal(restored.snapshot().reason, "reload");
  assert.equal(restored.snapshot().deferred, true);
  assert.deepEqual(restored.sent, []);
});

test("plan mode refuses symlink writes and aborts after two invalid agent ends", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "mypi-plan-symlink-"));
  const outside = join(cwd, "outside.md");
  await writeFile(outside, PLAN, "utf8");
  await symlink(outside, join(cwd, "PLAN.md"));
  const harness = createHarness(cwd);

  await harness.commands.get("goal").handler("", harness.ctx);
  const result = await harness.emit("tool_call", { toolName: "edit", input: { path: "PLAN.md", edits: [] } }) as any;
  assert.equal(result.block, true);
  assert.match(result.reason, /symbolic link/);

  await harness.emit("agent_end", { messages: [] });
  assert.equal(harness.customMessages.length, 1);
  await harness.emit("agent_end", { messages: [] });
  assert.equal(latestGoalState(harness).workflow, "idle");
  assert.equal(harness.aborts, 1);
  assert.equal(harness.notices.at(-1)?.level, "error");
});
