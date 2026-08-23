import type { BuiltInContinuationOptions } from "../core/extensions/types.ts";

/** Goal and delegated evidence compete for ownership of one parent boundary. */
export const PARENT_WORK_CONTINUATION_GROUP = "mypi:parent-work";

export const GOAL_CONTINUATION_PRIORITY = 10;
export const SUBAGENT_RESULT_PRIORITY = 100;

export function goalContinuationIntent(): BuiltInContinuationOptions {
	return { arbitrationGroup: PARENT_WORK_CONTINUATION_GROUP, priority: GOAL_CONTINUATION_PRIORITY };
}

export function subagentResultIntent(): BuiltInContinuationOptions {
	return { arbitrationGroup: PARENT_WORK_CONTINUATION_GROUP, priority: SUBAGENT_RESULT_PRIORITY };
}
