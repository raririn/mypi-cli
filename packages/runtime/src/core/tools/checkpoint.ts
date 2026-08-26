/**
 * FEAT-088 — `checkpoint` handoff notes.
 *
 * A session-owned markdown note the model writes when context is running low
 * (or when the user asks). The note is NOT model context: it lives next to the
 * session file, each write overwrites the last, compaction consumes it as an
 * untrusted hint block, and a consumed note is deleted so it can never go
 * stale. The tool is always registered (a mid-session tool-set change would
 * bust prompt caches and the Codex WS delta path); use is gated behaviorally
 * by the description and the context alert.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition } from "../extensions/types.ts";

export const CHECKPOINT_TOOL_NAME = "checkpoint";

/** Bounded so a runaway note can never dominate the summarization prompt. */
export const HANDOFF_NOTE_MAX_CHARS = 24_000;

/** Alert when remaining context dips under 2x the pre-compact reserve: late
 *  enough to describe real work, early enough that at least one full turn
 *  normally remains before auto-compaction triggers at 1x. */
export function shouldAlertHandoff(
	contextTokens: number,
	contextWindow: number,
	reserveTokens: number,
): boolean {
	if (contextWindow <= 0) return false;
	return contextTokens > contextWindow - 2 * reserveTokens;
}

export const HANDOFF_ALERT_CUSTOM_TYPE = "mypi-context-alert";

export const HANDOFF_ALERT_TEXT = `<context-alert>
Context is running low; the harness will compact this conversation soon. Call the checkpoint tool now with a handoff note for the agent that continues after compaction, then carry on with the task. Write the note before context runs out — do not wait until the current step completes.
</context-alert>`;

/** The note sits next to the session transcript and shares its lifecycle
 *  (deleted with the session; never copied to forks). */
export function handoffNotePath(sessionFile: string): string {
	return `${sessionFile.replace(/\.jsonl$/, "")}.handoff.md`;
}

export function readHandoffNote(sessionFile: string | undefined): string | undefined {
	if (!sessionFile) return undefined;
	try {
		const path = handoffNotePath(sessionFile);
		if (!existsSync(path)) return undefined;
		const text = readFileSync(path, "utf8").trim();
		return text.length > 0 ? text.slice(0, HANDOFF_NOTE_MAX_CHARS) : undefined;
	} catch {
		return undefined;
	}
}

export function writeHandoffNote(sessionFile: string, note: string): void {
	const path = handoffNotePath(sessionFile);
	mkdirSync(dirname(path), { recursive: true });
	const tmp = join(dirname(path), `.${Date.now()}-handoff.tmp`);
	writeFileSync(tmp, note, "utf8");
	renameSync(tmp, path);
}

/** Consumed or superseded notes are removed, not archived: a handoff note
 *  only ever describes context that is about to be (or was) summarized away,
 *  so keeping it around means keeping a stale one. */
export function disposeHandoffNote(sessionFile: string | undefined): void {
	if (!sessionFile) return;
	try {
		const path = handoffNotePath(sessionFile);
		if (existsSync(path)) unlinkSync(path);
	} catch {
		// Best-effort: a lingering note is re-read (and cross-checked) at most
		// once by the next compaction.
	}
}

const checkpointSchema = Type.Object({
	note: Type.String({
		description:
			"The full handoff note in markdown (this call REPLACES any previous note). Sections: ## Now (task in flight + literal next step), ## State (done vs not, with evidence), ## Decisions (choices made and why, incl. rejected approaches), ## Watch out (gotchas, constraints, exact paths/commands/identifiers to reuse).",
	}),
});

export type CheckpointToolInput = Static<typeof checkpointSchema>;

export interface CheckpointSessionContext {
	getSessionFile(): string | undefined;
}

export function createCheckpointToolDefinition(
	session: CheckpointSessionContext,
): ToolDefinition<typeof checkpointSchema, undefined> {
	return {
		name: CHECKPOINT_TOOL_NAME,
		label: "checkpoint",
		description:
			"Save a handoff note for the agent that continues this session after context compaction. Call it ONLY when a context-alert asks for it or the user requests a checkpoint — not during routine work. Each call overwrites the previous note, so always write the complete current picture: what is in flight, what is done (with evidence), decisions with their why, and gotchas with exact paths/commands. The note is consumed by the next compaction and then discarded.",
		promptSnippet: "Save a pre-compaction handoff note when asked",
		parameters: checkpointSchema,
		async execute(_toolCallId, params, signal) {
			if (signal?.aborted) throw new Error("Operation aborted");
			const sessionFile = session.getSessionFile();
			if (!sessionFile) {
				throw new Error("This session has no transcript file yet; retry after the first message is persisted.");
			}
			const note = params.note?.trim();
			if (!note) throw new Error("Checkpoint note is empty. Pass the full handoff note in `note`.");
			// Truncate INSIDE the read bound so the marker survives readHandoffNote.
			const bounded = note.length > HANDOFF_NOTE_MAX_CHARS
				? `${note.slice(0, HANDOFF_NOTE_MAX_CHARS - 100)}\n\n[truncated at ${HANDOFF_NOTE_MAX_CHARS} chars]`
				: note;
			writeHandoffNote(sessionFile, bounded);
			return {
				content: [{ type: "text", text: "Checkpoint saved. It will be handed to the post-compaction agent; continue the task." }],
				details: undefined,
			};
		},
		renderCall(_args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(theme.fg("thinkingText", theme.bold("✓ checkpoint saved")));
			return text;
		},
		renderResult(_result, _options, _theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText("");
			return text;
		},
	};
}
