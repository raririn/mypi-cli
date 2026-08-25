/**
 * MyPi hooks: user policy hooks from hooks.json plus one-shot agent hooks
 * (a single wakeup timer and file watches) exposed as tools.
 *
 * User hooks (see core/mypi-hooks.ts for the config and execution contract):
 *   pre_tool_use        can block a tool call (exit 2; stderr becomes the
 *                       tool-result error the model sees)
 *   post_tool_use       observe/react after a tool ran (formatters, audits)
 *   user_prompt_submit  can block a prompt or inject context (inject: true)
 *   session_start       can inject context at session start (inject: true)
 *   pre_compact         runs before context compaction
 *   agent_settled       fire-and-forget notification when a run settles
 *
 * Agent hooks (v2, greedy one-trigger lifecycle — see the beta.4 removal):
 *   schedule_wakeup     at most ONE pending wakeup per session; scheduling
 *                       again replaces it; firing consumes it
 *   watch_files         up to 3 one-shot non-recursive watches; the first
 *                       change (1s debounce) fires and consumes the watch
 *
 * Delivery is a typed custom message (customType "mypi-hook-fired"), never
 * a steer and never a fabricated user message. Firings during an active run
 * are held and coalesced into one message at settlement, where turn
 * continuation is arbitrated alongside subagent results; after an aborted
 * or failed run the notice waits in context instead of starting a turn.
 * When the session is idle a firing starts a turn immediately.
 */

import { existsSync, type FSWatcher, watch } from "node:fs";
import { resolve } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "../core/extensions/types.ts";
import {
	hookMatchesTool,
	loadMyPiHooksConfig,
	MYPI_HOOK_EVENTS,
	type MyPiHookDefinition,
	type MyPiHookEvent,
	type MyPiHooksConfig,
	runMyPiHook,
} from "../core/mypi-hooks.ts";

const MIN_DELAY_SECONDS = 60;
const MAX_DELAY_SECONDS = 24 * 60 * 60;
const MAX_WATCHES = 3;
const WATCH_DEBOUNCE_MS = 1_000;

/** Custom-message type carried by fired agent hooks (GUI/TUI render key). */
export const HOOK_FIRED_MESSAGE_TYPE = "mypi-hook-fired";

const HOOKS_HELP = `# MyPi hooks

/hooks              Show configured user hooks and active agent hooks
/hooks reload       Reload hooks.json (global and project)

User hooks live in <agent-dir>/hooks.json and <project>/.mypi/hooks.json
(project hooks require /trust). Events: ${MYPI_HOOK_EVENTS.join(", ")}.
Each entry: { "command": "...", "matcher": "tool regex", "argMatcher": "input regex",
"timeoutMs": 10000, "inject": false }. Exit 0 allows (stdout injects when
inject:true), exit 2 blocks with stderr as the reason, anything else warns.
Hook commands run outside the sandbox, in the project directory.

Agent hooks are one-shot, session-scoped tools the model can call:
schedule_wakeup keeps at most ONE pending wakeup (scheduling again replaces
it; delay ${MIN_DELAY_SECONDS}s-24h) and watch_files keeps up to ${MAX_WATCHES} one-shot
non-recursive watches. A hook fires once, is consumed, and delivers a
clearly labeled automated notification: as an immediate turn when the
session is idle, coalesced at settlement while a run is active, and held in
context without starting a turn after an aborted or failed run. Hook
notifications are not user messages. Subagent, goal, and plan results
arrive automatically at run boundaries — never schedule wakeups to poll
for them. Both hooks are in-memory and end with the session.
`;

interface ScheduledWakeup {
	id: string;
	note: string;
	fireAt: number;
	timer: ReturnType<typeof setTimeout>;
}

interface FileWatch {
	id: string;
	path: string;
	note: string;
	watcher: FSWatcher;
	pending?: ReturnType<typeof setTimeout>;
}

interface HookFiring {
	label: string;
	note: string;
}

export default function hooksExtension(pi: ExtensionAPI): void {
	let config: MyPiHooksConfig = { hooks: {}, warnings: [] };
	let latestCtx: ExtensionContext | undefined;
	let disposed = false;
	let nextId = 1;
	let wakeup: ScheduledWakeup | undefined;
	const watches = new Map<string, FileWatch>();
	const pendingFirings: HookFiring[] = [];

	const updateStatus = (ctx: ExtensionContext): void => {
		const parts: string[] = [];
		if (wakeup) parts.push("⏰1");
		if (watches.size > 0) parts.push(`👁${watches.size}`);
		ctx.ui.setStatus("hooks", parts.length > 0 ? parts.join(" ") : undefined);
	};

	const hooksFor = (event: MyPiHookEvent): MyPiHookDefinition[] => config.hooks[event] ?? [];

	const warnResult = (ctx: ExtensionContext, event: MyPiHookEvent, hook: MyPiHookDefinition, warning: string): void => {
		ctx.ui.notify(`Hook ${event} (${hook.command}) ${warning}`, "warning");
	};

	const reloadConfig = (ctx: ExtensionContext): void => {
		config = loadMyPiHooksConfig(ctx.cwd, ctx.isProjectTrusted());
		for (const warning of config.warnings) {
			ctx.ui.notify(`hooks.json: ${warning}`, "warning");
		}
	};

	// ------------------------------------------------------------------
	// Agent hooks: one-trigger lifecycle and typed delivery
	// ------------------------------------------------------------------

	const firingNotice = (firings: readonly HookFiring[]): string => [
		"[Automated agent-hook notification — not a user message; the user has not sent anything new.]",
		...firings.map((firing) => `- ${firing.label}: ${firing.note}`),
		"Act on this only if it is still relevant. Subagent, goal, and plan results arrive automatically at run boundaries; never schedule wakeups to poll for them.",
	].join("\n");

	const flushPendingFirings = (options: { triggerTurn: boolean }): void => {
		if (disposed || pendingFirings.length === 0) return;
		const batch = pendingFirings.splice(0, pendingFirings.length);
		try {
			// "followUp" is a race guard only: when idle, triggerTurn runs a turn
			// immediately; if a run started between the idle check and delivery,
			// the message queues after the run instead of steering into it.
			void Promise.resolve(pi.sendMessage(
				{ customType: HOOK_FIRED_MESSAGE_TYPE, content: firingNotice(batch), display: true },
				{ triggerTurn: options.triggerTurn, deliverAs: "followUp" },
			)).catch(() => undefined);
		} catch {
			// Session torn down between the fire and the send; drop silently.
		}
	};

	const deliverFiring = (label: string, note: string): void => {
		// The extension runtime dies with the session; never deliver into a dead one.
		if (disposed) return;
		pendingFirings.push({ label, note });
		if (latestCtx) updateStatus(latestCtx);
		// Idle: start the turn now. Active run: hold for settlement coalescing.
		if (latestCtx?.isIdle()) flushPendingFirings({ triggerTurn: true });
	};

	const clearAgentHooks = (): void => {
		if (wakeup) clearTimeout(wakeup.timer);
		wakeup = undefined;
		for (const entry of watches.values()) {
			if (entry.pending) clearTimeout(entry.pending);
			entry.watcher.close();
		}
		watches.clear();
		pendingFirings.length = 0;
	};

	// ------------------------------------------------------------------
	// User hooks
	// ------------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		reloadConfig(ctx);
		for (const hook of hooksFor("session_start")) {
			const result = await runMyPiHook(hook, { event: "session_start", cwd: ctx.cwd }, ctx.cwd);
			if (result.warning) warnResult(ctx, "session_start", hook, result.warning);
			const output = result.stdout.trim();
			if (result.status === "allow" && hook.inject && output) {
				pi.sendMessage(
					{ customType: "mypi-hook-context", content: `[hook context]\n${output}`, display: true },
					{ triggerTurn: false },
				);
			}
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		latestCtx = ctx;
		for (const hook of hooksFor("pre_tool_use")) {
			if (!hookMatchesTool(hook, event.toolName, event.input)) continue;
			const result = await runMyPiHook(
				hook,
				{
					event: "pre_tool_use",
					toolName: event.toolName,
					toolCallId: event.toolCallId,
					toolInput: event.input,
					cwd: ctx.cwd,
				},
				ctx.cwd,
			);
			if (result.warning) warnResult(ctx, "pre_tool_use", hook, result.warning);
			if (result.status === "block") {
				const reason = result.stderr.trim() || `Blocked by ${hook.source ?? "user"} pre_tool_use hook`;
				return { block: true, reason };
			}
		}
		return undefined;
	});

	pi.on("tool_result", async (event, ctx) => {
		latestCtx = ctx;
		for (const hook of hooksFor("post_tool_use")) {
			if (!hookMatchesTool(hook, event.toolName, event.input)) continue;
			const result = await runMyPiHook(
				hook,
				{
					event: "post_tool_use",
					toolName: event.toolName,
					toolCallId: event.toolCallId,
					toolInput: event.input,
					isError: event.isError,
					cwd: ctx.cwd,
				},
				ctx.cwd,
			);
			if (result.warning) warnResult(ctx, "post_tool_use", hook, result.warning);
			if (result.status === "block") {
				// post_tool_use cannot un-run the tool; surface the objection to the user only.
				ctx.ui.notify(`post_tool_use hook: ${result.stderr.trim() || hook.command}`, "warning");
			}
		}
		return undefined;
	});

	pi.on("input", async (event, ctx) => {
		latestCtx = ctx;
		const hooks = hooksFor("user_prompt_submit");
		if (hooks.length === 0 || event.text.startsWith("/")) return undefined;
		let text = event.text;
		for (const hook of hooks) {
			const result = await runMyPiHook(
				hook,
				{ event: "user_prompt_submit", prompt: event.text, cwd: ctx.cwd },
				ctx.cwd,
			);
			if (result.warning) warnResult(ctx, "user_prompt_submit", hook, result.warning);
			if (result.status === "block") {
				ctx.ui.notify(`Prompt blocked by hook: ${result.stderr.trim() || hook.command}`, "warning");
				return { action: "handled" };
			}
			const output = result.stdout.trim();
			if (result.status === "allow" && hook.inject && output) {
				text += `\n\n[hook context]\n${output}`;
			}
		}
		return text === event.text ? undefined : { action: "transform", text };
	});

	pi.on("session_before_compact", async (_event, ctx) => {
		latestCtx = ctx;
		for (const hook of hooksFor("pre_compact")) {
			const result = await runMyPiHook(hook, { event: "pre_compact", cwd: ctx.cwd }, ctx.cwd);
			if (result.warning) warnResult(ctx, "pre_compact", hook, result.warning);
		}
		return undefined;
	});

	pi.on("agent_settled", (event, ctx) => {
		latestCtx = ctx;
		for (const hook of hooksFor("agent_settled")) {
			// Fire and forget: notifications must never delay run settlement.
			void runMyPiHook(hook, { event: "agent_settled", cwd: ctx.cwd }, ctx.cwd).then((result) => {
				if (result.warning) warnResult(ctx, "agent_settled", hook, result.warning);
			});
		}
		// Firings held during the run deliver here, arbitrated with other
		// continuations. After an abort or error the notice stays in context
		// without starting a turn — a hook must never resurrect a stopped run.
		flushPendingFirings({ triggerTurn: event.outcome.kind === "success" });
	});

	pi.on("session_shutdown", () => {
		disposed = true;
		clearAgentHooks();
	});

	// ------------------------------------------------------------------
	// Agent hooks: schedule_wakeup
	// ------------------------------------------------------------------

	pi.registerTool({
		name: "schedule_wakeup",
		label: "Schedule wakeup",
		description:
			"One-shot session wakeup timer: deliver a note back to yourself after a delay. At most ONE wakeup can be pending — scheduling again REPLACES it; firing consumes it. Use only for genuinely external waits (a long build, an external process, an explicit user request like \"check again in 20 minutes\"). Subagent, goal, and plan results arrive automatically at run boundaries — scheduling a wakeup to poll for them is an error. In-memory; ends with the session.",
		promptSnippet: "Schedule a one-shot wakeup note after a delay",
		parameters: Type.Object(
			{
				action: Type.Union([Type.Literal("schedule"), Type.Literal("cancel"), Type.Literal("status")], {
					description: "schedule (replaces any pending wakeup), cancel the pending wakeup, or show status",
				}),
				delaySeconds: Type.Optional(
					Type.Integer({
						minimum: MIN_DELAY_SECONDS,
						maximum: MAX_DELAY_SECONDS,
						description: `Delay before delivery (${MIN_DELAY_SECONDS}-${MAX_DELAY_SECONDS} seconds); required for schedule`,
					}),
				),
				note: Type.Optional(Type.String({ description: "Note delivered when the wakeup fires; required for schedule" })),
			},
			{ additionalProperties: false },
		),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			latestCtx = ctx;
			if (params.action === "status") {
				const text = wakeup
					? `Wakeup ${wakeup.id} fires in ${Math.max(0, Math.round((wakeup.fireAt - Date.now()) / 1000))}s — ${wakeup.note}`
					: "No pending wakeup.";
				return { content: [{ type: "text", text }], details: undefined };
			}
			if (params.action === "cancel") {
				if (!wakeup) throw new Error("No pending wakeup to cancel.");
				clearTimeout(wakeup.timer);
				const cancelled = wakeup.id;
				wakeup = undefined;
				updateStatus(ctx);
				return { content: [{ type: "text", text: `Cancelled wakeup ${cancelled}.` }], details: undefined };
			}
			if (params.delaySeconds === undefined || !params.note) {
				throw new Error("schedule requires delaySeconds and note");
			}
			if (!Number.isInteger(params.delaySeconds) || params.delaySeconds < MIN_DELAY_SECONDS || params.delaySeconds > MAX_DELAY_SECONDS) {
				throw new Error(`delaySeconds must be an integer between ${MIN_DELAY_SECONDS} and ${MAX_DELAY_SECONDS}`);
			}
			const replaced = wakeup;
			if (replaced) clearTimeout(replaced.timer);
			const id = `w${nextId++}`;
			const fireAt = Date.now() + params.delaySeconds * 1000;
			const timer = setTimeout(() => {
				wakeup = undefined;
				if (latestCtx) updateStatus(latestCtx);
				deliverFiring(`wakeup ${id} (after ${params.delaySeconds}s)`, params.note as string);
			}, params.delaySeconds * 1000);
			timer.unref?.();
			wakeup = { id, note: params.note, fireAt, timer };
			updateStatus(ctx);
			const text = replaced
				? `Scheduled wakeup ${id} in ${params.delaySeconds}s, replacing ${replaced.id} (one wakeup slot per session).`
				: `Scheduled wakeup ${id}: fires once in ${params.delaySeconds}s.`;
			return { content: [{ type: "text", text }], details: undefined };
		},
	});

	// ------------------------------------------------------------------
	// Agent hooks: watch_files
	// ------------------------------------------------------------------

	pi.registerTool({
		name: "watch_files",
		label: "Watch files",
		description:
			`One-shot file watch: deliver a note back to yourself when a path first changes. Non-recursive, at most ${MAX_WATCHES} watches, ${WATCH_DEBOUNCE_MS / 1000}s debounce; the first change fires the note and CONSUMES the watch (re-watch explicitly if needed). Use for genuinely external changes (another process writing a result file), never to poll your own subagents or goals — their results arrive automatically. In-memory; ends with the session.`,
		promptSnippet: "Watch a path once and get notified on first change",
		parameters: Type.Object(
			{
				action: Type.Union([Type.Literal("watch"), Type.Literal("cancel"), Type.Literal("list")], {
					description: "watch a path once, cancel a watch by id, or list active watches",
				}),
				path: Type.Optional(Type.String({ description: "File or directory to watch (non-recursive); required for watch" })),
				note: Type.Optional(Type.String({ description: "Note delivered when the watch fires; required for watch" })),
				id: Type.Optional(Type.String({ description: "Watch id; required for cancel" })),
			},
			{ additionalProperties: false },
		),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			latestCtx = ctx;
			if (params.action === "list") {
				const lines = [...watches.values()].map((entry) => `${entry.id}: ${entry.path} — ${entry.note}`);
				return { content: [{ type: "text", text: lines.length > 0 ? lines.join("\n") : "No active watches." }], details: undefined };
			}
			if (params.action === "cancel") {
				const entry = params.id ? watches.get(params.id) : undefined;
				if (!entry) throw new Error(`No watch with id ${params.id ?? "(missing)"}`);
				if (entry.pending) clearTimeout(entry.pending);
				entry.watcher.close();
				watches.delete(entry.id);
				updateStatus(ctx);
				return { content: [{ type: "text", text: `Cancelled watch ${entry.id}.` }], details: undefined };
			}
			if (!params.path || !params.note) {
				throw new Error("watch requires path and note");
			}
			const resolved = resolve(ctx.cwd, params.path);
			if (!existsSync(resolved)) {
				throw new Error(`Path does not exist: ${resolved}`);
			}
			if (watches.size >= MAX_WATCHES) {
				throw new Error(`Watch limit reached (${MAX_WATCHES}); cancel one first`);
			}
			const id = `f${nextId++}`;
			const watcher = watch(resolved, { recursive: false, persistent: false });
			const entry: FileWatch = { id, path: resolved, note: params.note, watcher };
			watcher.on("change", () => {
				// One-shot with debounce: the first event arms the firing; further
				// events inside the window belong to the same change.
				if (entry.pending || !watches.has(id)) return;
				entry.pending = setTimeout(() => {
					if (!watches.has(id)) return;
					entry.watcher.close();
					watches.delete(id);
					if (latestCtx) updateStatus(latestCtx);
					deliverFiring(`file watch ${id} (${entry.path})`, entry.note);
				}, WATCH_DEBOUNCE_MS);
				entry.pending.unref?.();
			});
			watcher.on("error", () => {
				if (entry.pending) clearTimeout(entry.pending);
				entry.watcher.close();
				if (watches.delete(id) && latestCtx) {
					updateStatus(latestCtx);
					latestCtx.ui.notify(`File watch ${id} on ${entry.path} failed and was removed.`, "warning");
				}
			});
			watches.set(id, entry);
			updateStatus(ctx);
			return {
				content: [{ type: "text", text: `Watching ${resolved} (${id}): fires once on first change.` }],
				details: undefined,
			};
		},
	});

	pi.registerCommand("hooks", {
		description: "Show or reload MyPi user hooks and list active agent hooks",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim();
			if (arg === "--help") {
				await ctx.ui.editor("MyPi hooks help", HOOKS_HELP);
				return;
			}
			if (arg === "reload") {
				reloadConfig(ctx);
				ctx.ui.notify("Reloaded hooks.json", "info");
				return;
			}
			const lines: string[] = [];
			for (const event of MYPI_HOOK_EVENTS) {
				for (const hook of hooksFor(event)) {
					const scope = hook.source === "project" ? "project" : "global";
					const match = hook.matcher ? ` matcher=${hook.matcher}` : "";
					lines.push(`${event} (${scope})${match}: ${hook.command}`);
				}
			}
			if (lines.length === 0) lines.push("No user hooks configured (see /hooks --help).");
			lines.push("");
			if (wakeup) {
				lines.push(`wakeup ${wakeup.id}: fires in ${Math.max(0, Math.round((wakeup.fireAt - Date.now()) / 1000))}s — ${wakeup.note}`);
			}
			for (const entry of watches.values()) {
				lines.push(`watch ${entry.id}: ${entry.path} — ${entry.note}`);
			}
			if (!wakeup && watches.size === 0) {
				lines.push("No agent hooks active (schedule_wakeup, watch_files — one-shot).");
			}
			await ctx.ui.editor("MyPi hooks", lines.join("\n"));
		},
	});
}
