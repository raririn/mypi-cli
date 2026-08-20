import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "../core/extensions/types.ts";
import {
	parseSafetyMode,
	SAFETY_MODE_DESCRIPTIONS,
	SAFETY_MODE_LABELS,
	SAFETY_MODES,
	safetyModeFooterText,
	type SafetyMode,
} from "../core/safety-mode.ts";

const SAFETY_HELP = `# /safety — session safety policy

/safety
/safety <safe|sandbox|sandbox-ask|ask|full>
/safety --global <mode>
/safety <mode> --global

Session changes become effective at the next user-submitted agent run and never midway through an
existing provider/tool loop. --global changes only the default captured by subsequently created
sessions; it does not change this or any other live session.

Safe still permits reads and overwrites inside the workspace. It hides shell and broad filesystem
tools; it is not a read-only or workspace data-loss boundary. Sandboxed adds shell under the OS
sandbox. Sandbox + Approval may retry one exact sandbox denial outside the sandbox after confirmation.
Ask First confirms sensitive broad operations. Full Access runs with normal user permissions and no
safety approval prompts. /readonly, /noread, /plan, /goal, trust, and credential policies remain stronger.
`;

function modeOption(mode: SafetyMode): string {
	return `${SAFETY_MODE_LABELS[mode]} — ${SAFETY_MODE_DESCRIPTIONS[mode]}`;
}

function updateRpcStatus(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (ctx.mode !== "rpc") return;
	const state = pi.getSafetyState();
	ctx.ui.setStatus("safety", state.enabled ? safetyModeFooterText(state.effective, state.pending) : undefined);
}

async function selectSafetyMode(pi: ExtensionAPI, ctx: ExtensionContext): Promise<SafetyMode | undefined> {
	const selected = await ctx.ui.select("Safety mode", SAFETY_MODES.map(modeOption));
	return SAFETY_MODES.find((mode) => modeOption(mode) === selected);
}

function parseSafetyRequest(args: string):
	| { help: true }
	| { global: boolean; mode?: SafetyMode }
	| { error: string } {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	if (tokens.some((token) => token === "--help" || token === "help")) return { help: true };
	const global = tokens.includes("--global");
	const values = tokens.filter((token) => token !== "--global");
	if (values.length > 1) return { error: "Usage: /safety [mode] [--global]" };
	if (values.length === 0) return { global };
	const mode = parseSafetyMode(values[0]!);
	return mode ? { global, mode } : { error: `Unknown safety mode: ${values[0]}` };
}

export default function safetyExtension(pi: ExtensionAPI): void {
	pi.registerCommand("safety", {
		description: "Select the session safety mode; --global sets the default for new sessions",
		getArgumentCompletions: (prefix) => {
			const normalized = prefix.trim().toLowerCase();
			const values = [
				...SAFETY_MODES,
				...SAFETY_MODES.map((mode) => `--global ${mode}`),
				...SAFETY_MODES.map((mode) => `${mode} --global`),
				"--help",
			];
			const matches = values
				.filter((value) => value.startsWith(normalized))
				.map((value) => ({ value, label: value }));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			const request = parseSafetyRequest(args);
			if ("error" in request) {
				ctx.ui.notify(request.error, "warning");
				return;
			}
			if ("help" in request) {
				await ctx.ui.editor("Safety help", SAFETY_HELP);
				return;
			}
			if (!pi.getSafetyState().enabled) {
				ctx.ui.notify("Safety modes are unavailable in this deliberately restricted runtime profile.", "warning");
				return;
			}
			const mode = request.mode ?? (await selectSafetyMode(pi, ctx));
			if (!mode) return;
			if (request.global) {
				pi.setGlobalSafetyMode(mode);
				ctx.ui.notify(
					`Default for new sessions: ${SAFETY_MODE_LABELS[mode]}. Live sessions were not changed.`,
					"info",
				);
			} else {
				pi.requestSafetyMode(mode);
			}
			updateRpcStatus(pi, ctx);
		},
	});

	pi.registerCommand("reasoning", {
		description: "Select the active model's reasoning level",
		getArgumentCompletions: (prefix) => {
			const normalized = prefix.trim().toLowerCase();
			const matches = pi
				.getAvailableThinkingLevels()
				.filter((level) => level.startsWith(normalized))
				.map((value) => ({ value, label: value }));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			const levels = pi.getAvailableThinkingLevels();
			if (levels.length === 0) {
				ctx.ui.notify("Current model does not support reasoning.", "warning");
				return;
			}
			let selected = args.trim().toLowerCase() as ThinkingLevel;
			if (!selected) {
				const choice = await ctx.ui.select("Reasoning level", levels);
				if (!choice) return;
				selected = choice as ThinkingLevel;
			}
			if (!levels.includes(selected)) {
				ctx.ui.notify(`Unsupported reasoning level. Available: ${levels.join(", ")}.`, "warning");
				return;
			}
			pi.setThinkingLevel(selected);
			ctx.ui.notify(`Reasoning level: ${pi.getThinkingLevel()}`, "info");
		},
	});

	pi.on("input", (event, ctx) => {
		if (!/^\/sandbox(?:\s|$)/i.test(event.text.trim())) return undefined;
		ctx.ui.notify("/sandbox was replaced by /safety. Use /safety --help for the five modes.", "warning");
		return { action: "handled" };
	});

	pi.on("session_start", (_event, ctx) => updateRpcStatus(pi, ctx));
	pi.on("before_agent_start", (_event, ctx) => updateRpcStatus(pi, ctx));
}
