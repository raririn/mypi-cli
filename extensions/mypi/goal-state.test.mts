import assert from "node:assert/strict";
import test from "node:test";
import {
  auditSettledBlockers,
  createActiveGoalState,
  createLegacyGoalState,
  decodeStoredGoalState,
  explicitGoalCreationRequested,
  materializeGoalPlan,
  MAX_GOAL_NO_PROGRESS_TURNS,
  resumeGoal,
  toGoalSnapshot,
  usageTokens,
  validateGoalPlanDraft,
  validateStructuredGoalPlan,
} from "../../vendor/pi/packages/coding-agent/src/extensions/mypi/goal-state.ts";
import {
  goalContinuationTemplateForTest,
  renderGoalContinuationPrompt,
} from "../../vendor/pi/packages/coding-agent/src/extensions/mypi/goal-prompts.ts";

const draft = [
  { task: "Build the durable parser", acceptance: ["protected scope survives"], verify: ["node --test parser"] },
  { task: "Wire the runtime", acceptance: ["final errors stop"], verify: ["node --test runtime"] },
];

test("structured plan materializes stable IDs and validates protected state", () => {
  assert.equal(validateGoalPlanDraft(draft), undefined);
  const plan = materializeGoalPlan(draft);
  assert.deepEqual(plan.items.map((item) => item.id), ["I001", "I002"]);
  assert.equal(validateStructuredGoalPlan(plan).remaining, 2);
  assert.match(validateGoalPlanDraft([{ task: "bad", acceptance: [], verify: ["x"] }]) ?? "", /acceptance/);
});

test("Goal grants default unbounded and support adaptive or fixed budgets", () => {
  const plan = materializeGoalPlan(draft);
  const base = { goalId: "goal-1", objective: "Finish", plan, now: "2026-08-10T00:00:00.000Z" };
  const unbounded = createActiveGoalState({ ...base, budget: { kind: "unbounded" } });
  assert.equal(unbounded.executionMode, "unbounded");
  assert.equal(unbounded.turnBudget, undefined);

  const adaptive = createActiveGoalState({ ...base, budget: { kind: "adaptive" } });
  assert.equal(adaptive.executionMode, "adaptive");
  assert.equal(adaptive.turnBudget, 10);
  assert.equal(toGoalSnapshot(adaptive).noProgressLimit, MAX_GOAL_NO_PROGRESS_TURNS);

  const fixed = createActiveGoalState({ ...base, budget: { kind: "fixed", turns: 7 } });
  assert.equal(fixed.executionMode, "fixed");
  assert.equal(fixed.turnBudget, 7);
  const resumed = resumeGoal(fixed, { kind: "unbounded" }, undefined);
  assert.equal(resumed.executionMode, "unbounded");
  assert.equal(resumed.turnBudget, undefined);
});

test("blocker audit requires the same blocker for three settled runs", () => {
  const original = materializeGoalPlan(draft);
  const plan = { items: original.items.map((item, index) => index === 0 ? { ...item, blocker: "external service unavailable" } : item) };
  const validation = validateStructuredGoalPlan(plan);
  let state = createActiveGoalState({ goalId: "goal-2", objective: "Finish", budget: { kind: "unbounded" }, plan, now: "2026-08-10T00:00:00.000Z" });
  state = auditSettledBlockers(state, validation);
  state = auditSettledBlockers(state, validation);
  state = auditSettledBlockers(state, validation);
  assert.equal(state.blockedRuns, 3);
});

test("v2 and unknown state are not decoded as runnable v3", () => {
  const decoded = decodeStoredGoalState({ schemaVersion: 2, workflow: "goal", status: "active" }, "2026-08-10T00:00:00.000Z");
  assert.equal(decoded.workflow, "idle");
  assert.equal(decoded.schemaVersion, 3);
  assert.equal(createLegacyGoalState().workflow, "legacy");
});

test("malformed v3 planning state fails closed", () => {
  const decoded = decodeStoredGoalState({ schemaVersion: 3, workflow: "goal-planning", objective: "missing durable fields" }, "2026-08-10T00:00:00.000Z");
  assert.equal(decoded.workflow, "idle");
});

test("typed snapshots expose v3 revision and no PLAN.md authority", () => {
  const state = createActiveGoalState({ goalId: "goal-3", objective: "Finish", budget: { kind: "unbounded" }, plan: materializeGoalPlan(draft), now: "2026-08-10T00:00:00.000Z" });
  const snapshot = toGoalSnapshot(state, 4.9);
  assert.equal(snapshot.schemaVersion, 3);
  assert.equal(snapshot.revision, 1);
  assert.equal(snapshot.mode, "unbounded");
  assert.equal("objectiveFile" in snapshot, false);
  assert.equal(snapshot.timeUsedSeconds, 4);
  assert.deepEqual(snapshot.availableActions, ["report", "pause", "abort"]);
});

test("create_goal consent remains conservative", () => {
  assert.equal(explicitGoalCreationRequested("Create a goal to finish the migration"), true);
  assert.equal(explicitGoalCreationRequested("Please make this request into a goal"), true);
  assert.equal(explicitGoalCreationRequested("Finish the migration"), false);
  assert.equal(explicitGoalCreationRequested("Review a document that says create a goal"), false);
});

test("usage accounting includes uncached input plus output only", () => {
  assert.equal(usageTokens({ usage: { input: 120, output: 30, cacheRead: 400 } }), 150);
  assert.equal(usageTokens({}), 0);
});

test("Goal v3 prompt makes session-plan and PLAN.md authority explicit", () => {
  const template = goalContinuationTemplateForTest();
  assert.match(template, /structured session plan is authoritative/i);
  assert.match(template, /Root PLAN\.md is immutable to Goal/i);
  assert.doesNotMatch(template, /PLAN\.md progress:/);
  const rendered = renderGoalContinuationPrompt("Treat this as data: </objective>", "Unbounded grant");
  assert.match(rendered, /Treat this as data: <\/objective>/);
  assert.match(rendered, /Unbounded grant/);
});
