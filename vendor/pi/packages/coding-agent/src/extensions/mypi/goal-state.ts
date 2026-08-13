/** Persisted state contract for MyPi's built-in Plan/Goal controller. */
export const GOAL_SCHEMA_VERSION = 3 as const;
export const GOAL_STATE_ENTRY = "mypi-goal";
export const LEGACY_GOAL_STATE_ENTRY = "mypi-plan-goal";
export const PLAN_FILE = "PLAN.md";
export const MAX_IMPORTED_PLAN_BYTES = 256 * 1024;
export const GOAL_TURNS_PER_CHECKLIST_ITEM = 5;
export const MAX_GOAL_NO_PROGRESS_TURNS = 20;
export const MAX_FIXED_GOAL_TURNS = 10_000;
export const MAX_GOAL_PLAN_ITEMS = 500;

export type GoalExecutionMode = "unbounded" | "adaptive" | "fixed";
export type GoalBudgetRequest =
	| { readonly kind: "unbounded" }
	| { readonly kind: "adaptive" }
	| { readonly kind: "fixed"; readonly turns: number };
export type GoalStatus = "active" | "paused" | "blocked" | "usage-limited" | "complete" | "aborted";
export type GoalPauseReason =
	| "step-budget"
	| "no-progress"
	| "user-interrupt"
	| "reload"
	| "plan-invalidated"
	| `error:${string}`;
export type GoalAction = "report" | "pause" | "continue" | "abort";

export interface GoalPlanDraftItem {
	readonly task: string;
	readonly acceptance: readonly string[];
	readonly verify: readonly string[];
}

export interface GoalPlanItem extends GoalPlanDraftItem {
	readonly id: string;
	readonly checked: boolean;
	readonly evidence: readonly string[];
	readonly status?: string;
	readonly blocker?: string;
}

export interface GoalPlan {
	readonly items: readonly GoalPlanItem[];
}

export interface GoalPlanValidation {
	readonly valid: boolean;
	readonly total: number;
	readonly complete: number;
	readonly remaining: number;
	readonly blockerFingerprint?: string;
	readonly error?: string;
}

export interface ImportedPlan {
	readonly text: string;
	readonly sha256: string;
	readonly bytes: number;
	readonly importedAt: string;
}

export interface PendingGoalRequest {
	readonly action: "start" | "continue";
	readonly objective?: string;
	readonly supplemental?: string;
	readonly budget: GoalBudgetRequest;
	readonly continueAllowed: boolean;
}

export interface IdleGoalState {
	readonly schemaVersion: typeof GOAL_SCHEMA_VERSION;
	readonly workflow: "idle";
	readonly updatedAt: string;
}

/** The standalone /plan file workflow remains separate from Goal v3. */
export interface FilePlanningState {
	readonly schemaVersion: typeof GOAL_SCHEMA_VERSION;
	readonly workflow: "planning";
	readonly status: "active";
	readonly interactive: boolean;
	readonly interactiveCanWrite: boolean;
	readonly planBaselineText?: string;
	readonly planAgentEnds: number;
	readonly toolsBeforePlan?: readonly string[];
	readonly updatedAt: string;
}

export interface GoalPlanningState {
	readonly schemaVersion: typeof GOAL_SCHEMA_VERSION;
	readonly workflow: "goal-planning";
	readonly goalId: string;
	readonly objective: string;
	readonly budget: GoalBudgetRequest;
	readonly supplemental?: string;
	readonly importedPlan?: ImportedPlan;
	readonly planAgentEnds: number;
	readonly toolsBeforePlan?: readonly string[];
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface ActiveGoalState {
	readonly schemaVersion: typeof GOAL_SCHEMA_VERSION;
	readonly workflow: "goal";
	readonly goalId: string;
	readonly revision: number;
	readonly objective: string;
	readonly executionMode: GoalExecutionMode;
	readonly turnBudget?: number;
	readonly status: GoalStatus;
	readonly pauseReason?: GoalPauseReason;
	readonly plan: GoalPlan;
	readonly supplemental?: string;
	readonly turnsUsed: number;
	readonly tokensUsed: number;
	readonly timeUsedSeconds: number;
	readonly grantStartComplete: number;
	readonly lastCompleteItems: number;
	readonly lastTotalItems: number;
	readonly blockerFingerprint?: string;
	readonly blockedRuns: number;
	readonly protectedMutationAttempts: number;
	readonly deferred: boolean;
	readonly continuationPending: boolean;
	readonly retryAfter?: string;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface LegacyGoalState {
	readonly workflow: "legacy";
	readonly schemaVersion: 2;
	readonly updatedAt: string;
}

export type GoalRuntimeState =
	| IdleGoalState
	| FilePlanningState
	| GoalPlanningState
	| ActiveGoalState
	| LegacyGoalState;

export interface GoalSnapshot {
	readonly schemaVersion: typeof GOAL_SCHEMA_VERSION;
	readonly goalId: string;
	readonly revision: number;
	readonly objective: string;
	readonly mode: GoalExecutionMode;
	readonly status: GoalStatus;
	readonly reason?: GoalPauseReason;
	readonly checkedItems: number;
	readonly totalItems: number;
	readonly turnsUsed: number;
	readonly turnBudget?: number;
	readonly noProgressLimit?: number;
	readonly tokensUsed: number;
	readonly timeUsedSeconds: number;
	readonly blockedRuns: number;
	readonly protectedMutationAttempts: number;
	readonly retryAfter?: string;
	readonly deferred: boolean;
	readonly availableActions: readonly GoalAction[];
}

export interface CreateGoalStateInput {
	readonly goalId: string;
	readonly objective: string;
	readonly budget: GoalBudgetRequest;
	readonly plan: GoalPlan;
	readonly supplemental?: string;
	readonly now: string;
}

export interface ParsedPlanItem extends GoalPlanDraftItem {
	readonly checked: boolean;
	readonly evidence: readonly string[];
	readonly status: readonly string[];
	readonly blocked: readonly string[];
}

export interface ParsedPlan {
	readonly valid: boolean;
	readonly items: readonly ParsedPlanItem[];
	readonly error?: string;
}

const CHECKBOX_PATTERN = /^\s*[-*+]\s+\[([ xX])\]\s+(.+?)\s*$/gm;

export function normalizeGoalText(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function commentValues(segment: string, name: "acceptance" | "verify" | "evidence" | "status" | "blocked"): string[] {
	const pattern = new RegExp(`<!--\\s*${name}\\s*:\\s*([\\s\\S]*?)-->`, "gi");
	return [...segment.matchAll(pattern)].map((match) => normalizeGoalText(match[1] ?? "")).filter(Boolean);
}

/** Parse root PLAN.md only for the standalone /plan workflow and optional import diagnostics. */
export function parsePlanText(text: string): ParsedPlan {
	const matches = [...text.matchAll(CHECKBOX_PATTERN)];
	if (matches.length === 0) return { valid: false, items: [], error: `${PLAN_FILE} has no Markdown checklist items` };
	return {
		valid: true,
		items: matches.map((match, index) => {
			const start = match.index ?? 0;
			const end = matches[index + 1]?.index ?? text.length;
			const segment = text.slice(start, end);
			return {
				task: normalizeGoalText(match[2] ?? ""),
				checked: (match[1] ?? "").toLowerCase() === "x",
				acceptance: commentValues(segment, "acceptance"),
				verify: commentValues(segment, "verify"),
				evidence: commentValues(segment, "evidence"),
				status: commentValues(segment, "status"),
				blocked: commentValues(segment, "blocked"),
			};
		}),
	};
}

function validText(value: unknown, max: number): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= max && !value.includes("\0");
}

function validTextList(value: unknown, maxItems = 50): value is readonly string[] {
	return Array.isArray(value) && value.length <= maxItems && value.every((entry) => validText(entry, 10_000));
}

export function validateGoalPlanDraft(items: readonly GoalPlanDraftItem[]): string | undefined {
	if (!Array.isArray(items) || items.length === 0) return "A Goal plan requires at least one item.";
	if (items.length > MAX_GOAL_PLAN_ITEMS) return `A Goal plan supports at most ${MAX_GOAL_PLAN_ITEMS} items.`;
	for (let index = 0; index < items.length; index += 1) {
		const item = items[index];
		if (!item || !validText(item.task, 20_000)) return `Item ${index + 1} requires bounded task text.`;
		if (!validTextList(item.acceptance) || item.acceptance.length === 0)
			return `Item ${index + 1} requires at least one acceptance requirement.`;
		if (!validTextList(item.verify) || item.verify.length === 0)
			return `Item ${index + 1} requires at least one verification requirement.`;
	}
	return undefined;
}

export function materializeGoalPlan(items: readonly GoalPlanDraftItem[]): GoalPlan {
	const error = validateGoalPlanDraft(items);
	if (error) throw new Error(error);
	return {
		items: items.map((item, index) => ({
			id: `I${String(index + 1).padStart(3, "0")}`,
			task: normalizeGoalText(item.task),
			acceptance: [...new Set(item.acceptance.map(normalizeGoalText))],
			verify: [...new Set(item.verify.map(normalizeGoalText))],
			checked: false,
			evidence: [],
		})),
	};
}

export function nextGoalItemId(plan: GoalPlan): string {
	const used = new Set(plan.items.map((item) => item.id));
	for (let index = 1; index <= MAX_GOAL_PLAN_ITEMS; index += 1) {
		const candidate = `I${String(index).padStart(3, "0")}`;
		if (!used.has(candidate)) return candidate;
	}
	throw new Error(`A Goal plan supports at most ${MAX_GOAL_PLAN_ITEMS} items.`);
}

export function validateStructuredGoalPlan(plan: GoalPlan): GoalPlanValidation {
	if (!plan || !Array.isArray(plan.items) || plan.items.length === 0 || plan.items.length > MAX_GOAL_PLAN_ITEMS) {
		return { valid: false, total: 0, complete: 0, remaining: 0, error: "Stored Goal plan is empty or oversized." };
	}
	const ids = new Set<string>();
	for (const item of plan.items) {
		if (!validText(item.id, 64) || ids.has(item.id))
			return { valid: false, total: plan.items.length, complete: 0, remaining: plan.items.length, error: "Stored Goal item IDs are invalid or duplicated." };
		ids.add(item.id);
		const draftError = validateGoalPlanDraft([{ task: item.task, acceptance: item.acceptance, verify: item.verify }]);
		if (draftError || typeof item.checked !== "boolean" || !validTextList(item.evidence, 100)) {
			return { valid: false, total: plan.items.length, complete: 0, remaining: plan.items.length, error: `Stored Goal item ${item.id} is invalid.` };
		}
		if (item.status !== undefined && !validText(item.status, 10_000))
			return { valid: false, total: plan.items.length, complete: 0, remaining: plan.items.length, error: `Stored Goal item ${item.id} status is invalid.` };
		if (item.blocker !== undefined && !validText(item.blocker, 10_000))
			return { valid: false, total: plan.items.length, complete: 0, remaining: plan.items.length, error: `Stored Goal item ${item.id} blocker is invalid.` };
	}
	const complete = plan.items.filter((item) => item.checked).length;
	const blockers = [...new Set(plan.items.filter((item) => !item.checked).map((item) => item.blocker).filter(Boolean) as string[])]
		.map(normalizeGoalText)
		.sort((left, right) => left.localeCompare(right));
	return {
		valid: true,
		total: plan.items.length,
		complete,
		remaining: plan.items.length - complete,
		blockerFingerprint: blockers.length > 0 ? blockers.join("\n") : undefined,
	};
}

export function createIdleGoalState(now = new Date().toISOString()): IdleGoalState {
	return { schemaVersion: GOAL_SCHEMA_VERSION, workflow: "idle", updatedAt: now };
}

export function createFilePlanningState(
	input: Omit<FilePlanningState, "schemaVersion" | "workflow" | "status">,
): FilePlanningState {
	return { schemaVersion: GOAL_SCHEMA_VERSION, workflow: "planning", status: "active", ...input };
}

export function createGoalPlanningState(
	input: Omit<GoalPlanningState, "schemaVersion" | "workflow">,
): GoalPlanningState {
	return { schemaVersion: GOAL_SCHEMA_VERSION, workflow: "goal-planning", ...input };
}

export function goalTurnBudget(checklistCount: number): number {
	return Math.max(1, checklistCount) * GOAL_TURNS_PER_CHECKLIST_ITEM;
}

function budgetFields(budget: GoalBudgetRequest, itemCount: number): Pick<ActiveGoalState, "executionMode" | "turnBudget"> {
	if (budget.kind === "unbounded") return { executionMode: "unbounded", turnBudget: undefined };
	if (budget.kind === "adaptive") return { executionMode: "adaptive", turnBudget: goalTurnBudget(itemCount) };
	if (!Number.isSafeInteger(budget.turns) || budget.turns < 1 || budget.turns > MAX_FIXED_GOAL_TURNS)
		throw new Error(`Fixed Goal budget must be an integer from 1 through ${MAX_FIXED_GOAL_TURNS}.`);
	return { executionMode: "fixed", turnBudget: budget.turns };
}

export function createActiveGoalState(input: CreateGoalStateInput): ActiveGoalState {
	const validation = validateStructuredGoalPlan(input.plan);
	if (!validation.valid) throw new Error(validation.error ?? "Goal plan is invalid.");
	return {
		schemaVersion: GOAL_SCHEMA_VERSION,
		workflow: "goal",
		goalId: input.goalId,
		revision: 1,
		objective: input.objective,
		...budgetFields(input.budget, validation.total),
		status: "active",
		plan: input.plan,
		supplemental: input.supplemental,
		turnsUsed: 0,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		grantStartComplete: validation.complete,
		lastCompleteItems: validation.complete,
		lastTotalItems: validation.total,
		blockedRuns: 0,
		protectedMutationAttempts: 0,
		deferred: false,
		continuationPending: false,
		createdAt: input.now,
		updatedAt: input.now,
	};
}

export function pauseGoal(state: ActiveGoalState, reason: GoalPauseReason, now = new Date().toISOString()): ActiveGoalState {
	return {
		...state,
		revision: state.revision + 1,
		status: "paused",
		pauseReason: reason,
		deferred: reason === "reload" ? true : state.deferred,
		continuationPending: false,
		updatedAt: now,
	};
}

export function resumeGoal(
	state: ActiveGoalState,
	budget: GoalBudgetRequest,
	supplemental: string | undefined,
	now = new Date().toISOString(),
): ActiveGoalState {
	const validation = validateStructuredGoalPlan(state.plan);
	if (!validation.valid) throw new Error(validation.error ?? "Goal plan is invalid.");
	return {
		...state,
		revision: state.revision + 1,
		...budgetFields(budget, validation.total),
		status: "active",
		pauseReason: undefined,
		supplemental: supplemental ?? state.supplemental,
		turnsUsed: 0,
		grantStartComplete: validation.complete,
		lastCompleteItems: validation.complete,
		lastTotalItems: validation.total,
		blockerFingerprint: undefined,
		blockedRuns: 0,
		protectedMutationAttempts: 0,
		deferred: false,
		continuationPending: false,
		retryAfter: undefined,
		updatedAt: now,
	};
}

export function auditSettledBlockers(
	state: ActiveGoalState,
	validation: GoalPlanValidation,
	now = new Date().toISOString(),
): ActiveGoalState {
	if (validation.complete > state.lastCompleteItems || !validation.blockerFingerprint) {
		return {
			...state,
			revision: state.revision + 1,
			lastCompleteItems: validation.complete,
			lastTotalItems: validation.total,
			blockerFingerprint: undefined,
			blockedRuns: 0,
			updatedAt: now,
		};
	}
	return {
		...state,
		revision: state.revision + 1,
		blockerFingerprint: validation.blockerFingerprint,
		blockedRuns: validation.blockerFingerprint === state.blockerFingerprint ? state.blockedRuns + 1 : 1,
		lastCompleteItems: validation.complete,
		lastTotalItems: validation.total,
		updatedAt: now,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validOptionalText(value: unknown, max: number): boolean {
	return value === undefined || validText(value, max);
}

function validTools(value: unknown): boolean {
	return value === undefined || Array.isArray(value) && value.length <= 500 && value.every((entry) => validText(entry, 512));
}

function validBudget(value: unknown): value is GoalBudgetRequest {
	if (!isRecord(value)) return false;
	if (value.kind === "unbounded" || value.kind === "adaptive") return Object.keys(value).length === 1;
	return value.kind === "fixed" && Object.keys(value).every((key) => key === "kind" || key === "turns")
		&& Number.isSafeInteger(value.turns) && (value.turns as number) >= 1 && (value.turns as number) <= MAX_FIXED_GOAL_TURNS;
}

function validImportedPlan(value: unknown): boolean {
	if (value === undefined) return true;
	if (!isRecord(value) || typeof value.text !== "string" || value.text.includes("\0")) return false;
	const bytes = new TextEncoder().encode(value.text).byteLength;
	return bytes <= MAX_IMPORTED_PLAN_BYTES && (value.bytes === bytes || value.bytes === bytes + 3)
		&& typeof value.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256)
		&& validText(value.importedAt, 128);
}

export function isValidStoredGoalState(value: unknown): value is Exclude<GoalRuntimeState, LegacyGoalState> {
	if (!isRecord(value) || value.schemaVersion !== GOAL_SCHEMA_VERSION) return false;
	if (value.workflow === "idle") return validText(value.updatedAt, 128);
	if (value.workflow === "planning") {
		return value.status === "active" && typeof value.interactive === "boolean"
			&& typeof value.interactiveCanWrite === "boolean"
			&& Number.isSafeInteger(value.planAgentEnds) && (value.planAgentEnds as number) >= 0
			&& validOptionalText(value.planBaselineText, 1_000_000) && validTools(value.toolsBeforePlan)
			&& validText(value.updatedAt, 128);
	}
	if (value.workflow === "goal-planning") {
		return validText(value.goalId, 512) && validText(value.objective, 20_000)
			&& validBudget(value.budget) && validOptionalText(value.supplemental, 20_000)
			&& validImportedPlan(value.importedPlan)
			&& Number.isSafeInteger(value.planAgentEnds) && (value.planAgentEnds as number) >= 0
			&& validTools(value.toolsBeforePlan) && validText(value.createdAt, 128) && validText(value.updatedAt, 128);
	}
	if (value.workflow !== "goal" || !isRecord(value.plan)) return false;
	if (!validText(value.goalId, 512) || !validText(value.objective, 20_000)) return false;
	if (!validOptionalText(value.supplemental, 20_000) || !validText(value.createdAt, 128) || !validText(value.updatedAt, 128)) return false;
	if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1) return false;
	if (!["unbounded", "adaptive", "fixed"].includes(value.executionMode as string)) return false;
	if (!["active", "paused", "blocked", "usage-limited", "complete", "aborted"].includes(value.status as string)) return false;
	if (value.executionMode === "unbounded" ? value.turnBudget !== undefined : !Number.isSafeInteger(value.turnBudget) || (value.turnBudget as number) < 1 || (value.turnBudget as number) > MAX_FIXED_GOAL_TURNS) return false;
	for (const field of ["turnsUsed", "tokensUsed", "timeUsedSeconds", "grantStartComplete", "lastCompleteItems", "lastTotalItems", "blockedRuns", "protectedMutationAttempts"] as const) {
		if (!Number.isSafeInteger(value[field]) || (value[field] as number) < 0) return false;
	}
	if ((value.protectedMutationAttempts as number) > 3 || typeof value.deferred !== "boolean" || typeof value.continuationPending !== "boolean") return false;
	if (!validOptionalText(value.pauseReason, 512) || !validOptionalText(value.blockerFingerprint, 50_000) || !validOptionalText(value.retryAfter, 512)) return false;
	const validation = validateStructuredGoalPlan(value.plan as unknown as GoalPlan);
	if (!validation.valid || (value.grantStartComplete as number) > validation.total || (value.lastCompleteItems as number) > validation.total || value.lastTotalItems !== validation.total) return false;
	if (value.executionMode !== "unbounded" && (value.turnsUsed as number) > (value.turnBudget as number)) return false;
	if (value.status === "active" && value.pauseReason !== undefined) return false;
	if (["paused", "blocked", "usage-limited"].includes(value.status as string) && value.pauseReason === undefined) return false;
	if (["complete", "aborted"].includes(value.status as string) && (value.pauseReason !== undefined || value.continuationPending === true)) return false;
	if (value.status === "complete" && (validation.remaining !== 0 || (value.plan as unknown as GoalPlan).items.some((item) => item.evidence.length === 0))) return false;
	return true;
}

export function decodeStoredGoalState(value: unknown, now = new Date().toISOString()): GoalRuntimeState {
	if (!isValidStoredGoalState(value)) return createIdleGoalState(now);
	if (value.workflow === "goal" && value.status === "active") return pauseGoal(value, "reload", now);
	return value;
}

export function createLegacyGoalState(now = new Date().toISOString()): LegacyGoalState {
	return { workflow: "legacy", schemaVersion: 2, updatedAt: now };
}

function availableActions(status: GoalStatus): readonly GoalAction[] {
	if (status === "active") return ["report", "pause", "abort"];
	if (status === "paused" || status === "blocked" || status === "usage-limited") return ["report", "continue", "abort"];
	return ["report"];
}

export function toGoalSnapshot(state: ActiveGoalState, activeElapsedSeconds = 0): GoalSnapshot {
	const validation = validateStructuredGoalPlan(state.plan);
	return {
		schemaVersion: GOAL_SCHEMA_VERSION,
		goalId: state.goalId,
		revision: state.revision,
		objective: state.objective,
		mode: state.executionMode,
		status: state.status,
		reason: state.pauseReason,
		checkedItems: validation.valid ? validation.complete : state.lastCompleteItems,
		totalItems: validation.valid ? validation.total : state.lastTotalItems,
		turnsUsed: state.turnsUsed,
		...(state.turnBudget !== undefined ? { turnBudget: state.turnBudget } : {}),
		...(state.executionMode === "adaptive" ? { noProgressLimit: MAX_GOAL_NO_PROGRESS_TURNS } : {}),
		tokensUsed: state.tokensUsed,
		timeUsedSeconds: state.timeUsedSeconds + Math.max(0, Math.floor(activeElapsedSeconds)),
		blockedRuns: state.blockedRuns,
		protectedMutationAttempts: state.protectedMutationAttempts,
		retryAfter: state.retryAfter,
		deferred: state.deferred,
		availableActions: availableActions(state.status),
	};
}

export function explicitGoalCreationRequested(text: string): boolean {
	const normalized = text.trim();
	if (/^\/goal(?:\s|$)/i.test(normalized)) return true;
	return (
		/^(?:please\s+)?(?:create|start|set|begin|activate)\s+(?:a|the|this|an)\s+(?:new\s+)?goal(?:\s|$)/i.test(normalized) ||
		/^(?:please\s+)?make\s+(?:this|the following|that)\s+(?:request\s+)?(?:into\s+)?(?:a|the)\s+goal(?:\s|$)/i.test(normalized)
	);
}

export function usageTokens(message: unknown): number {
	if (!isRecord(message) || !isRecord(message.usage)) return 0;
	const input = typeof message.usage.input === "number" && Number.isFinite(message.usage.input) ? message.usage.input : 0;
	const output = typeof message.usage.output === "number" && Number.isFinite(message.usage.output) ? message.usage.output : 0;
	return Math.max(0, input) + Math.max(0, output);
}
