/**
 * @deprecated Use the commentary exports. These aliases keep source consumers
 * compiling while returning the renamed canonical tool; deep_thinking is never
 * registered beside commentary.
 */
export {
	createCommentaryTool as createDeepThinkingTool,
	createCommentaryToolDefinition as createDeepThinkingToolDefinition,
	type CommentaryToolInput as DeepThinkingToolInput,
} from "./commentary.ts";
