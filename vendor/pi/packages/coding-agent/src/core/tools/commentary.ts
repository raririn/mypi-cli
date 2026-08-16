import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

/**
 * commentary is a side-effect-free, user-visible progress channel. Its input is
 * persisted in the conversation and rendered as a compact update; the empty
 * acknowledgement keeps the tool result from adding context noise.
 */
const commentarySchema = Type.Object({
	message: Type.String({
		description:
			"A brief user-visible update: progress, an assumption, a partial finding, or a non-blocking question. Give only concise, decision-relevant rationale; never include secrets or hidden reasoning.",
	}),
});

export type CommentaryToolInput = Static<typeof commentarySchema>;

function formatUpdate(args: CommentaryToolInput | { thought?: string } | undefined, theme: Theme): string {
	const header = theme.fg("thinkingText", theme.bold("✳ update"));
	const rawMessage = args && "message" in args ? args.message : args?.thought;
	const body = rawMessage?.trim() ?? "";
	if (!body) {
		return header;
	}
	const lines = body.split("\n").map((line) => theme.fg("thinkingText", line));
	return `${header}\n${lines.join("\n")}`;
}

export function createCommentaryToolDefinition(): ToolDefinition<typeof commentarySchema, undefined> {
	return {
		name: "commentary",
		label: "commentary",
		description:
			"Share a brief user-visible update while you work. Use it for progress, assumptions, partial findings, or a non-blocking question. Give only concise, decision-relevant rationale, never include secrets or hidden reasoning, and do not use it as the final answer.",
		promptSnippet: "Share a brief user-visible update",
		parameters: commentarySchema,
		// The tool renders its own dim block instead of the standard colored tool shell.
		renderShell: "self",
		async execute(_toolCallId, _params, signal, _onUpdate, _ctx) {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}
			return { content: [{ type: "text", text: "" }], details: undefined };
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatUpdate(args, theme));
			return text;
		},
		renderResult(_result, _options, _theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText("");
			return text;
		},
	};
}

export function createCommentaryTool(): AgentTool<typeof commentarySchema> {
	return wrapToolDefinition(createCommentaryToolDefinition());
}
