/**
 * MyPi hooks: user policy hooks from hooks.json plus agent-facing runtime
 * hooks (timers and file watches) exposed as tools.
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
 * Agent hooks (registered by the model at runtime, session-scoped, in-memory):
 *   schedule_prompt     deliver a prompt after a delay ("continue in 20min")
 *   watch_files         deliver a prompt when a watched path changes
 *
 * Injected hook output is clearly labeled in the transcript; hook stdout is
 * only model-visible when the hook opts in with `inject: true`.
 */

import { existsSync, type FSWatcher, statSync, watch } from "node:fs";
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

const MAX_TIMERS = 5;
const MAX_WATCHES = 10;
const MIN_DELAY_SECONDS = 5;
const MAX_DELAY_SECONDS = 24 * 60 * 60;
const WATCH_DEBOUNCE_MS = 1_000;

const HOOKS_HELP = `# MyPi hooks

/hooks              Show configured user hooks and active agent hooks
/hooks reload       Reload hooks.json (global and project)

User hooks live in <agent-dir>/hooks.json and <project>/.mypi/hooks.json
(project hooks require /trust). Events: ${MYPI_HOOK_EVENTS.join(", ")}.
Each entry: { "command": "...", "matcher": "tool regex", "argMatcher": "input regex",
"timeoutMs": 10000, "inject": false }. Exit 0 allows (stdout injects when
inject:true), exit 2 blocks with stderr as the reason, anything else warns.
Hook commands run outside the sandbox, in the project directory.

Agent hooks are session-scoped tools the model can call: schedule_prompt
(timers) and watch_files (file watches). Both deliver clearly labeled
prompts back into the session and are listed by /hooks.
`;

interface ScheduledPrompt {
	id: string;
	prompt: string;
	fireAt: number;
	timer: ReturnType<typeof setTimeout>;
}

interface FileWatch {
	id: string;
	path: string;
	prompt: string;
	watcher: FSWatcher;
	lastFire: number;
	pending?: ReturnType<typeof setTimeout>;
}

export default function hooksExtension(pi: ExtensionAPI): void {
	let config: MyPiHooksConfig = { hooks: {}, warnings: [] };
	let latestCtx: ExtensionContext | undefined;
	let disposed = false;
	let nextId = 1;
	const timers = new Map<string, ScheduledPrompt>();
	const watches = new Map<string, FileWatch>();

	const updateStatus = (ctx: ExtensionContext): void => {
		const parts: string[] = [];
		if (timers.size > 0) parts.push(`⏰${timers.size}`);
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

	const deliverAgentHook = (label: string, prompt: string): void => {
		// The extension runtime dies with the session; never deliver into a dead one.
		if (disposed || !latestCtx) return;
		try {
			// "steer" injects mid-turn when a run is streaming; when idle it still
			// triggers an immediate turn.
			pi.sendUserMessage(`[MyPi hook fired: ${label}]\n\n${prompt}`, { deliverAs: "steer" });
		} catch {
			// Session torn down between the fire and the send; drop silently.
		}
	};

	const clearAgentHooks = (): void => {
		for (const entry of timers.values()) clearTimeout(entry.timer);
		timers.clear();
		for (const entry of watches.values()) {
			if (entry.pending) clearTimeout(entry.pending);
			entry.watcher.close();
		}
		watches.clear();
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

	pi.on("agent_settled", (_event, ctx) => {
		latestCtx = ctx;
		for (const hook of hooksFor("agent_settled")) {
			// Fire and forget: notifications must never delay run settlement.
			void runMyPiHook(hook, { event: "agent_settled", cwd: ctx.cwd }, ctx.cwd).then((result) => {
				if (result.warning) warnResult(ctx, "agent_settled", hook, result.warning);
			});
		}
	});

	pi.on("session_shutdown", () => {
		disposed = true;
		clearAgentHooks();
	});

	// ------------------------------------------------------------------
	// Agent hooks: schedule_prompt
	// ------------------------------------------------------------------

	pi.registerTool({
		name: "schedule_prompt",
		label: "Schedule prompt",
		description:
			"Session-scoped timer hook. Schedule a prompt to be delivered back to you after a delay (e.g. \"continue the build check in 20 minutes\"), list active timers, or cancel one. Timers are in-memory and end with the session. The delivered prompt is clearly labeled as a fired hook.",
		promptSnippet: "Schedule a prompt to arrive after a delay",
		parameters: Type.Object(
			{
				action: Type.Union([Type.Literal("schedule"), Type.Literal("cancel"), Type.Literal("list")], {
					description: "schedule a new timer, cancel one by id, or list active timers",
				}),
				delaySeconds: Type.Optional(
					Type.Integer({
						minimum: MIN_DELAY_SECONDS,
						maximum: MAX_DELAY_SECONDS,
						description: `Delay before delivery (${MIN_DELAY_SECONDS}-${MAX_DELAY_SECONDS} seconds); required for schedule`,
					}),
				),
				prompt: Type.Optional(Type.String({ description: "Prompt text to deliver when the timer fires; required for schedule" })),
				id: Type.Optional(Type.String({ description: "Timer id; required for cancel" })),
			},
			{ additionalProperties: false },
		),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			latestCtx = ctx;
			if (params.action === "list") {
				const lines = [...timers.values()].map(
					(t) => `${t.id}: fires in ${Math.max(0, Math.round((t.fireAt - Date.now()) / 1000))}s — ${t.prompt}`,
				);
				return { content: [{ type: "text", text: lines.length > 0 ? lines.join("\n") : "No active timers." }], details: undefined };
			}
			if (params.action === "cancel") {
				const entry = params.id ? timers.get(params.id) : undefined;
				if (!entry) throw new Error(`No timer with id ${params.id ?? "(missing)"}`);
				clearTimeout(entry.timer);
				timers.delete(entry.id);
				updateStatus(ctx);
				return { content: [{ type: "text", text: `Cancelled timer ${entry.id}.` }], details: undefined };
			}
			if (params.delaySeconds === undefined || !params.prompt) {
				throw new Error("schedule requires delaySeconds and prompt");
			}
			if (timers.size >= MAX_TIMERS) {
				throw new Error(`Timer limit reached (${MAX_TIMERS}); cancel one first`);
			}
			const id = `t${nextId++}`;
			const fireAt = Date.now() + params.delaySeconds * 1000;
			const timer = setTimeout(() => {
				timers.delete(id);
				if (latestCtx) updateStatus(latestCtx);
				deliverAgentHook(`timer ${id} after ${params.delaySeconds}s`, params.prompt as string);
			}, params.delaySeconds * 1000);
			timer.unref?.();
			timers.set(id, { id, prompt: params.prompt, fireAt, timer });
			updateStatus(ctx);
			return {
				content: [{ type: "text", text: `Scheduled ${id}: delivers in ${params.delaySeconds}s.` }],
				details: undefined,
			};
		},
	});

	// ------------------------------------------------------------------
	// Agent hooks: watch_files
	// ------------------------------------------------------------------

	pi.registerTool({
		name: "watch_files",
		label: "Watch files",
		description:
			"Session-scoped file-watch hook. Watch a file or directory (non-recursive) and have a prompt delivered back to you when it changes, list active watches, or remove one. Changes are debounced; watches are in-memory and end with the session. Note: your own edits to a watched path also trigger it.",
		promptSnippet: "Deliver a prompt when a watched file changes",
		parameters: Type.Object(
			{
				action: Type.Union([Type.Literal("watch"), Type.Literal("unwatch"), Type.Literal("list")], {
					description: "watch a new path, unwatch by id, or list active watches",
				}),
				path: Type.Optional(Type.String({ description: "File or directory to watch (non-recursive); required for watch" })),
				prompt: Type.Optional(Type.String({ description: "Prompt text delivered on change; required for watch" })),
				id: Type.Optional(Type.String({ description: "Watch id; required for unwatch" })),
			},
			{ additionalProperties: false },
		),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			latestCtx = ctx;
			if (params.action === "list") {
				const lines = [...watches.values()].map((w) => `${w.id}: ${w.path} — ${w.prompt}`);
				return { content: [{ type: "text", text: lines.length > 0 ? lines.join("\n") : "No active watches." }], details: undefined };
			}
			if (params.action === "unwatch") {
				const entry = params.id ? watches.get(params.id) : undefined;
				if (!entry) throw new Error(`No watch with id ${params.id ?? "(missing)"}`);
				if (entry.pending) clearTimeout(entry.pending);
				entry.watcher.close();
				watches.delete(entry.id);
				updateStatus(ctx);
				return { content: [{ type: "text", text: `Removed watch ${entry.id}.` }], details: undefined };
			}
			if (!params.path || !params.prompt) {
				throw new Error("watch requires path and prompt");
			}
			if (watches.size >= MAX_WATCHES) {
				throw new Error(`Watch limit reached (${MAX_WATCHES}); unwatch one first`);
			}
			const absolute = resolve(ctx.cwd, params.path);
			if (!existsSync(absolute)) {
				throw new Error(`Path not found: ${absolute}`);
			}
			statSync(absolute); // surfaces permission errors before registering
			const id = `w${nextId++}`;
			const watcher = watch(absolute, (eventType, filename) => {
				const entry = watches.get(id);
				if (!entry) return;
				if (entry.pending) clearTimeout(entry.pending);
				entry.pending = setTimeout(() => {
					entry.pending = undefined;
					entry.lastFire = Date.now();
					const changed = filename ? `${entry.path} (${String(filename)})` : entry.path;
					deliverAgentHook(`watch ${id}, ${eventType} on ${changed}`, entry.prompt);
				}, WATCH_DEBOUNCE_MS);
				entry.pending.unref?.();
			});
			// Never let a watcher hold the process open if a teardown path skips close().
			watcher.unref?.();
			watcher.on("error", (error) => {
				const entry = watches.get(id);
				if (entry) {
					entry.watcher.close();
					watches.delete(id);
					if (latestCtx) {
						updateStatus(latestCtx);
						latestCtx.ui.notify(`Watch ${id} failed: ${error.message}`, "warning");
					}
				}
			});
			watches.set(id, { id, path: absolute, prompt: params.prompt, watcher, lastFire: 0 });
			updateStatus(ctx);
			return { content: [{ type: "text", text: `Watching ${absolute} as ${id}.` }], details: undefined };
		},
	});

	// ------------------------------------------------------------------
	// /hooks command
	// ------------------------------------------------------------------

	pi.registerCommand("hooks", {
		description: "Show or reload MyPi hooks (user hooks.json + agent timers/watches)",
		handler: async (args, ctx) => {
			latestCtx = ctx;
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
			lines.push(`Agent timers: ${timers.size > 0 ? [...timers.keys()].join(", ") : "none"}`);
			lines.push(`Agent watches: ${watches.size > 0 ? [...watches.values()].map((w) => `${w.id}=${w.path}`).join(", ") : "none"}`);
			await ctx.ui.editor("MyPi hooks", lines.join("\n"));
		},
	});
}
