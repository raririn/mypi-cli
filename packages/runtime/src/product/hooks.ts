/**
 * MyPi user policy hooks from hooks.json.
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
 * Model-callable agent hooks are intentionally absent. schedule_prompt and
 * watch_files remain disabled until their lifecycle and internal-message
 * design is revisited.
 */

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

const HOOKS_HELP = `# MyPi hooks

/hooks              Show configured user hooks
/hooks reload       Reload hooks.json (global and project)

User hooks live in <agent-dir>/hooks.json and <project>/.mypi/hooks.json
(project hooks require /trust). Events: ${MYPI_HOOK_EVENTS.join(", ")}.
Each entry: { "command": "...", "matcher": "tool regex", "argMatcher": "input regex",
"timeoutMs": 10000, "inject": false }. Exit 0 allows (stdout injects when
inject:true), exit 2 blocks with stderr as the reason, anything else warns.
Hook commands run outside the sandbox, in the project directory.

The model-callable schedule_prompt and watch_files agent-hook tools are
temporarily disabled while their lifecycle and internal-message design is
reworked. User hooks and /hooks remain active.
`;

export default function hooksExtension(pi: ExtensionAPI): void {
	let config: MyPiHooksConfig = { hooks: {}, warnings: [] };

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

	pi.on("session_start", async (_event, ctx) => {
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
		for (const hook of hooksFor("pre_compact")) {
			const result = await runMyPiHook(hook, { event: "pre_compact", cwd: ctx.cwd }, ctx.cwd);
			if (result.warning) warnResult(ctx, "pre_compact", hook, result.warning);
		}
		return undefined;
	});

	pi.on("agent_settled", (_event, ctx) => {
		for (const hook of hooksFor("agent_settled")) {
			// Fire and forget: notifications must never delay run settlement.
			void runMyPiHook(hook, { event: "agent_settled", cwd: ctx.cwd }, ctx.cwd).then((result) => {
				if (result.warning) warnResult(ctx, "agent_settled", hook, result.warning);
			});
		}
	});

	pi.registerCommand("hooks", {
		description: "Show or reload MyPi user hooks",
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
			lines.push("Agent hook tools are temporarily disabled.");
			await ctx.ui.editor("MyPi hooks", lines.join("\n"));
		},
	});
}
