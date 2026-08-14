import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

/**
 * deep_thinking: a side-effect-free tool that lets the model externalize a short
 * reasoning/progress note. The thought lives in the tool-call input, so it becomes
 * part of the conversation context (a scratchpad the model can see on later turns)
 * and is rendered as a dim, thinking-style block for the user. This gives chain-of-
 * thought to models without native reasoning, and gives users visibility into models
 * whose native reasoning is hidden by the provider. The result is an empty ack.
 */
const deepThinkingSchema = Type.Object({
	thought: Type.String({
		description:
			"A brief, first-person note of what you are thinking or about to do: a hypothesis, a plan for the next step, or reasoning worth making visible. Keep it short and scannable.",
	}),
});

export type DeepThinkingToolInput = Static<typeof deepThinkingSchema>;

function formatThought(thought: string, theme: Theme): string {
	const header = theme.fg("thinkingText", theme.bold("✳ thinking"));
	const body = thought.trim();
	if (!body) {
		return header;
	}
	const lines = body.split("\n").map((line) => theme.fg("thinkingText", line));
	return `${header}\n${lines.join("\n")}`;
}

export function createDeepThinkingToolDefinition(): ToolDefinition<typeof deepThinkingSchema, undefined> {
	return {
		name: "deep_thinking",
		label: "thinking",
		description:
			"Record a short, first-person thought to make your reasoning and progress visible as you work. Use it before a non-trivial step, to state a hypothesis, or to plan what you are about to do and why. This is your scratchpad and the user's window into your process; it is never your final answer, and the user should not need it to understand your result. Keep entries brief.",
		promptSnippet: "Make your reasoning and progress visible",
		parameters: deepThinkingSchema,
		// The tool renders its own dim block instead of the standard colored tool shell.
		renderShell: "self",
		async execute(_toolCallId, _params, signal, _onUpdate, _ctx) {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}
			// The thought is carried entirely by the tool-call input; there is nothing to
			// compute. Return an empty ack so the result adds no noise to the context.
			return { content: [{ type: "text", text: "" }], details: undefined };
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatThought(args?.thought ?? "", theme));
			return text;
		},
		renderResult(_result, _options, _theme, context) {
			// The ack is empty; render nothing so only the thought itself is shown.
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText("");
			return text;
		},
	};
}

export function createDeepThinkingTool(): AgentTool<typeof deepThinkingSchema> {
	return wrapToolDefinition(createDeepThinkingToolDefinition());
}
