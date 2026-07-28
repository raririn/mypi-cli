/** Persisted state contract for MyPi's built-in Plan/Goal controller. */
export const GOAL_SCHEMA_VERSION = 2 as const;
export const GOAL_STATE_ENTRY = "mypi-plan-goal";
export const PLAN_FILE = "PLAN.md";
export const GOAL_TURNS_PER_CHECKLIST_ITEM = 5;
export const MAX_GOAL_NO_PROGRESS_TURNS = 20;

export type GoalMode = "bounded" | "yolo";
export type GoalStatus = "active" | "paused" | "blocked" | "usage-limited" | "complete" | "aborted";
export type GoalPauseReason =
	| "turn-budget"
	| "no-progress"
	| "user-interrupt"
	| "reload"
	| "plan-invalidated"
	| "retirement-failed"
	| `error:${string}`;
export type GoalAction = "report" | "pause" | "continue" | "continue-yolo" | "abort";

export interface ProtectedPlanItem {
	readonly ordinal: number;
	readonly task: string;
	readonly acceptance: readonly string[];
	readonly verify: readonly string[];
}

export interface PlanBaseline {
	readonly items: readonly ProtectedPlanItem[];
}

export interface ParsedPlanItem extends ProtectedPlanItem {
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

export interface PlanValidation {
	readonly valid: boolean;
	readonly total: number;
	readonly complete: number;
	readonly remaining: number;
	readonly baselineTotal: number;
	readonly baselineComplete: number;
	readonly blockerFingerprint?: string;
	readonly error?: string;
}

export interface PendingGoalRequest {
	readonly action: "start" | "continue";
	readonly objective?: string;
	readonly supplemental?: string;
	readonly yolo: boolean;
	readonly continueAllowed: boolean;
}

export interface IdleGoalState {
	readonly schemaVersion: typeof GOAL_SCHEMA_VERSION;
	readonly workflow: "idle";
	readonly updatedAt: string;
}

export interface PlanningGoalState {
	readonly schemaVersion: typeof GOAL_SCHEMA_VERSION;
	readonly workflow: "planning";
	readonly status: "active";
	readonly interactive: boolean;
	readonly interactiveCanWrite: boolean;
	readonly planBaselineText?: string;
	readonly planAgentEnds: number;
	readonly toolsBeforePlan?: readonly string[];
	readonly pendingGoal?: PendingGoalRequest;
	readonly updatedAt: string;
}

export interface ActiveGoalState {
	readonly schemaVersion: typeof GOAL_SCHEMA_VERSION;
	readonly workflow: "goal";
	readonly goalId: string;
	readonly objective: string;
	readonly mode: GoalMode;
	readonly status: GoalStatus;
	readonly pauseReason?: GoalPauseReason;
	readonly baseline: PlanBaseline;
	readonly supplemental?: string;
	readonly turnBudget: number;
	readonly turnsUsed: number;
	readonly tokensUsed: number;
	readonly timeUsedSeconds: number;
	readonly grantStartComplete: number;
	readonly lastBaselineComplete: number;
	readonly lastCompleteItems: number;
	readonly lastTotalItems: number;
	readonly blockerFingerprint?: string;
	readonly blockedRuns: number;
	readonly deferred: boolean;
	readonly continuationPending: boolean;
	readonly retryAfter?: string;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export type GoalRuntimeState = IdleGoalState | PlanningGoalState | ActiveGoalState;

export interface GoalSnapshot {
	readonly schemaVersion: typeof GOAL_SCHEMA_VERSION;
	readonly goalId: string;
	readonly objectiveFile: typeof PLAN_FILE;
	readonly objective: string;
	readonly mode: GoalMode;
	readonly status: GoalStatus;
	readonly reason?: GoalPauseReason;
	readonly checkedItems: number;
	readonly totalItems: number;
	readonly turnsUsed: number;
	readonly turnBudget?: number;
	readonly tokensUsed: number;
	readonly timeUsedSeconds: number;
	readonly blockedRuns: number;
	readonly retryAfter?: string;
	readonly deferred: boolean;
	readonly availableActions: readonly GoalAction[];
}

export interface CreateGoalStateInput {
	readonly goalId: string;
	readonly objective: string;
	readonly mode: GoalMode;
	readonly baseline: PlanBaseline;
	readonly validation: PlanValidation;
	readonly supplemental?: string;
	readonly now: string;
}

const CHECKBOX_PATTERN = /^\s*[-*+]\s+\[([ xX])\]\s+(.+?)\s*$/gm;

function normalizeProtectedText(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function commentValues(segment: string, name: "acceptance" | "verify" | "evidence" | "status" | "blocked"): string[] {
	const pattern = new RegExp(`<!--\\s*${name}\\s*:\\s*([\\s\\S]*?)-->`, "gi");
	return [...segment.matchAll(pattern)].map((match) => normalizeProtectedText(match[1] ?? "")).filter(Boolean);
}

export function parsePlanText(text: string): ParsedPlan {
	const matches = [...text.matchAll(CHECKBOX_PATTERN)];
	if (matches.length === 0) {
		return { valid: false, items: [], error: `${PLAN_FILE} has no Markdown checklist items` };
	}

	const items = matches.map((match, index): ParsedPlanItem => {
		const start = match.index ?? 0;
		const end = matches[index + 1]?.index ?? text.length;
		const segment = text.slice(start, end);
		return {
			ordinal: index,
			task: normalizeProtectedText(match[2] ?? ""),
			checked: (match[1] ?? "").toLowerCase() === "x",
			acceptance: commentValues(segment, "acceptance"),
			verify: commentValues(segment, "verify"),
			evidence: commentValues(segment, "evidence"),
			status: commentValues(segment, "status"),
			blocked: commentValues(segment, "blocked"),
		};
	});

	return { valid: true, items };
}

export function snapshotPlanBaseline(plan: ParsedPlan): PlanBaseline {
	if (!plan.valid || plan.items.length === 0) {
		throw new Error(plan.error ?? `${PLAN_FILE} is invalid`);
	}
	return {
		items: plan.items.map((item) => ({
			ordinal: item.ordinal,
			task: item.task,
			acceptance: [...item.acceptance],
			verify: [...item.verify],
		})),
	};
}

function includesEvery(current: readonly string[], baseline: readonly string[]): boolean {
	return baseline.every((required) => current.includes(required));
}

function normalizedBlockerFingerprint(items: readonly ParsedPlanItem[]): string | undefined {
	const blockers = [
		...new Set(
			items
				.flatMap((item) => (item.checked ? [] : item.blocked))
				.map(normalizeProtectedText)
				.filter(Boolean),
		),
	].sort((left, right) => left.localeCompare(right));
	return blockers.length > 0 ? blockers.join("\n") : undefined;
}

export function validatePlanAgainstBaseline(text: string, baseline: PlanBaseline): PlanValidation {
	const plan = parsePlanText(text);
	if (!plan.valid) {
		return {
			valid: false,
			total: 0,
			complete: 0,
			remaining: 0,
			baselineTotal: baseline.items.length,
			baselineComplete: 0,
			error: plan.error,
		};
	}

	let cursor = 0;
	const matched: ParsedPlanItem[] = [];
	for (const protectedItem of baseline.items) {
		const relativeIndex = plan.items.slice(cursor).findIndex((candidate) => candidate.task === protectedItem.task);
		if (relativeIndex < 0) {
			const anywhere = plan.items.findIndex((candidate) => candidate.task === protectedItem.task);
			const reason =
				anywhere >= 0
					? `Protected checklist item ${protectedItem.ordinal + 1} was reordered: ${protectedItem.task}`
					: `Protected checklist item ${protectedItem.ordinal + 1} was deleted or rewritten: ${protectedItem.task}`;
			return {
				valid: false,
				total: plan.items.length,
				complete: plan.items.filter((item) => item.checked).length,
				remaining: plan.items.filter((item) => !item.checked).length,
				baselineTotal: baseline.items.length,
				baselineComplete: matched.filter((item) => item.checked).length,
				error: reason,
			};
		}
		const index = cursor + relativeIndex;
		const candidate = plan.items[index]!;
		if (!includesEvery(candidate.acceptance, protectedItem.acceptance)) {
			return {
				valid: false,
				total: plan.items.length,
				complete: plan.items.filter((item) => item.checked).length,
				remaining: plan.items.filter((item) => !item.checked).length,
				baselineTotal: baseline.items.length,
				baselineComplete: matched.filter((item) => item.checked).length,
				error: `Protected acceptance requirements were removed or weakened for item ${protectedItem.ordinal + 1}: ${protectedItem.task}`,
			};
		}
		if (!includesEvery(candidate.verify, protectedItem.verify)) {
			return {
				valid: false,
				total: plan.items.length,
				complete: plan.items.filter((item) => item.checked).length,
				remaining: plan.items.filter((item) => !item.checked).length,
				baselineTotal: baseline.items.length,
				baselineComplete: matched.filter((item) => item.checked).length,
				error: `Protected verification requirements were removed or weakened for item ${protectedItem.ordinal + 1}: ${protectedItem.task}`,
			};
		}
		matched.push(candidate);
		cursor = index + 1;
	}

	const complete = plan.items.filter((item) => item.checked).length;
	return {
		valid: true,
		total: plan.items.length,
		complete,
		remaining: plan.items.length - complete,
		baselineTotal: baseline.items.length,
		baselineComplete: matched.filter((item) => item.checked).length,
		blockerFingerprint: normalizedBlockerFingerprint(matched),
	};
}

export function createIdleGoalState(now = new Date().toISOString()): IdleGoalState {
	return { schemaVersion: GOAL_SCHEMA_VERSION, workflow: "idle", updatedAt: now };
}

export function createPlanningGoalState(
	input: Omit<PlanningGoalState, "schemaVersion" | "workflow" | "status">,
): PlanningGoalState {
	return {
		schemaVersion: GOAL_SCHEMA_VERSION,
		workflow: "planning",
		status: "active",
		...input,
	};
}

export function goalTurnBudget(checklistCount: number): number {
	return Math.max(1, checklistCount) * GOAL_TURNS_PER_CHECKLIST_ITEM;
}

export function createActiveGoalState(input: CreateGoalStateInput): ActiveGoalState {
	return {
		schemaVersion: GOAL_SCHEMA_VERSION,
		workflow: "goal",
		goalId: input.goalId,
		objective: input.objective,
		mode: input.mode,
		status: "active",
		baseline: input.baseline,
		supplemental: input.supplemental,
		turnBudget: goalTurnBudget(input.validation.total),
		turnsUsed: 0,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		grantStartComplete: input.validation.baselineComplete,
		lastBaselineComplete: input.validation.baselineComplete,
		lastCompleteItems: input.validation.complete,
		lastTotalItems: input.validation.total,
		blockedRuns: 0,
		deferred: false,
		continuationPending: false,
		createdAt: input.now,
		updatedAt: input.now,
	};
}

export function pauseGoal(
	state: ActiveGoalState,
	reason: GoalPauseReason,
	now = new Date().toISOString(),
): ActiveGoalState {
	return {
		...state,
		status: "paused",
		pauseReason: reason,
		deferred: reason === "reload" ? true : state.deferred,
		continuationPending: false,
		updatedAt: now,
	};
}

export function resumeGoal(
	state: ActiveGoalState,
	validation: PlanValidation,
	yolo: boolean,
	supplemental: string | undefined,
	now = new Date().toISOString(),
): ActiveGoalState {
	return {
		...state,
		mode: yolo || state.mode === "yolo" ? "yolo" : "bounded",
		status: "active",
		pauseReason: undefined,
		supplemental: supplemental ?? state.supplemental,
		turnBudget: goalTurnBudget(validation.total),
		turnsUsed: 0,
		grantStartComplete: validation.baselineComplete,
		lastBaselineComplete: validation.baselineComplete,
		lastCompleteItems: validation.complete,
		lastTotalItems: validation.total,
		blockerFingerprint: undefined,
		blockedRuns: 0,
		deferred: false,
		continuationPending: false,
		retryAfter: undefined,
		updatedAt: now,
	};
}

export function auditSettledBlockers(
	state: ActiveGoalState,
	validation: PlanValidation,
	now = new Date().toISOString(),
): ActiveGoalState {
	if (validation.baselineComplete > state.lastBaselineComplete) {
		return {
			...state,
			lastBaselineComplete: validation.baselineComplete,
			lastCompleteItems: validation.complete,
			lastTotalItems: validation.total,
			blockerFingerprint: undefined,
			blockedRuns: 0,
			updatedAt: now,
		};
	}
	if (!validation.blockerFingerprint) {
		return {
			...state,
			blockerFingerprint: undefined,
			blockedRuns: 0,
			lastCompleteItems: validation.complete,
			lastTotalItems: validation.total,
			updatedAt: now,
		};
	}
	return {
		...state,
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

function isCurrentGoalState(value: unknown): value is GoalRuntimeState {
	if (!isRecord(value) || value.schemaVersion !== GOAL_SCHEMA_VERSION) return false;
	return value.workflow === "idle" || value.workflow === "planning" || value.workflow === "goal";
}

export function decodeStoredGoalState(value: unknown, now = new Date().toISOString()): GoalRuntimeState {
	if (isCurrentGoalState(value)) {
		if (value.workflow === "goal" && value.status === "active") {
			return pauseGoal(value, "reload", now);
		}
		return value;
	}
	return createIdleGoalState(now);
}

function availableActions(status: GoalStatus): readonly GoalAction[] {
	if (status === "active") return ["report", "pause", "abort"];
	if (status === "paused" || status === "blocked" || status === "usage-limited") {
		return ["report", "continue", "continue-yolo", "abort"];
	}
	return ["report"];
}

export function toGoalSnapshot(
	state: ActiveGoalState,
	validation: PlanValidation,
	activeElapsedSeconds = 0,
): GoalSnapshot {
	return {
		schemaVersion: GOAL_SCHEMA_VERSION,
		goalId: state.goalId,
		objectiveFile: PLAN_FILE,
		objective: state.objective,
		mode: state.mode,
		status: state.status,
		reason: state.pauseReason,
		checkedItems: validation.valid ? validation.complete : state.lastCompleteItems,
		totalItems: validation.valid ? validation.total : state.lastTotalItems,
		turnsUsed: state.turnsUsed,
		...(state.mode === "bounded" ? { turnBudget: state.turnBudget } : {}),
		tokensUsed: state.tokensUsed,
		timeUsedSeconds: state.timeUsedSeconds + Math.max(0, Math.floor(activeElapsedSeconds)),
		blockedRuns: state.blockedRuns,
		retryAfter: state.retryAfter,
		deferred: state.deferred,
		availableActions: availableActions(state.status),
	};
}

export function explicitGoalCreationRequested(text: string): boolean {
	const normalized = text.trim();
	if (/^\/goal(?:\s|$)/i.test(normalized)) return true;
	return (
		/^(?:please\s+)?(?:create|start|set|begin|activate)\s+(?:a|the|this|an)\s+(?:new\s+)?goal(?:\s|$)/i.test(
			normalized,
		) ||
		/^(?:please\s+)?make\s+(?:this|the following|that)\s+(?:request\s+)?(?:into\s+)?(?:a|the)\s+goal(?:\s|$)/i.test(
			normalized,
		)
	);
}

export function usageTokens(message: unknown): number {
	if (!isRecord(message) || !isRecord(message.usage)) return 0;
	const input =
		typeof message.usage.input === "number" && Number.isFinite(message.usage.input) ? message.usage.input : 0;
	const output =
		typeof message.usage.output === "number" && Number.isFinite(message.usage.output) ? message.usage.output : 0;
	return Math.max(0, input) + Math.max(0, output);
}
