import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { getAgentDir } from "../../config.ts";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import {
	cycleExecutionMode,
	type ExecutionMode,
	getExecutionMode,
	onExecutionModeChange,
	setExecutionMode,
} from "../../core/mypi-exec-mode.ts";
import { resolveMyPiSandboxPreference, saveMyPiSandboxPreference } from "../../core/mypi-sandbox.ts";

const SANDBOX_HELP = `# Execution mode — Safe Mode / Sandbox Off / Sandbox On

/sandbox            Show the current mode and host sandbox availability
/sandbox on         Switch this session to Sandbox On (and set it as the default)
/sandbox off        Switch this session to Sandbox Off (and set it as the default)
/mode               Cycle this session's mode (also bound to a hotkey)
/sandbox --help     Show this help

MyPi has one per-session execution mode with three states:

  Sandbox Off  normal shell execution (default)
  Sandbox On   the built-in bash tool and direct !/!! commands run through
               Anthropic's sandbox runtime: each command may write only in its
               workspace and temp directory; reads of the MyPi agent directory,
               SSH keys, AWS files, and GnuPG files are denied; credential-like
               environment variables are removed; shell network is blocked (use
               MyPi's built-in web_search and web_fetch instead).
  Safe Mode    mutating or dangerous tool calls require approval; no OS sandbox.

The mode is per session and starts from the saved default. \`/sandbox on|off\`
also updates that default for new sessions; the hotkey and \`/mode\` change only
the current session. Linux hosts provide bubblewrap, socat, and ripgrep.
MyPi enables the preference after verifying host support and these dependencies.
`;

const MODE_LABELS: Record<ExecutionMode, string> = {
	off: "Sandbox Off",
	sandbox: "Sandbox On",
	safe: "Safe Mode",
};

const MODE_ICONS: Record<ExecutionMode, string> = {
	off: "○",
	sandbox: "⛊",
	safe: "⚠",
};

interface SandboxAvailability {
	available: boolean;
	message: string;
	warnings: string[];
}

export function inspectMyPiSandboxAvailability(platform = process.platform): SandboxAvailability {
	if (platform !== "darwin" && platform !== "linux") {
		return {
			available: false,
			message: `MyPi shell sandboxing is not supported on ${platform}.`,
			warnings: [],
		};
	}
	try {
		const dependencies = SandboxManager.checkDependencies();
		if (dependencies.errors.length > 0) {
			return {
				available: false,
				message: `Sandbox dependencies are unavailable: ${dependencies.errors.join(", ")}.`,
				warnings: dependencies.warnings,
			};
		}
		return {
			available: true,
			message:
				platform === "darwin"
					? "Anthropic Seatbelt sandbox is available."
					: "Anthropic bubblewrap sandbox is available.",
			warnings: dependencies.warnings,
		};
	} catch (error) {
		return {
			available: false,
			message: `Sandbox availability check failed: ${error instanceof Error ? error.message : String(error)}.`,
			warnings: [],
		};
	}
}

export default function sandboxExtension(pi: ExtensionAPI): void {
	const agentDir = getAgentDir();
	// Kept from the most recent event so a mode change driven by another
	// surface (the /safemode alias, the hotkey) can still refresh the footer.
	let statusUi: ExtensionContext["ui"] | undefined;

	const renderModeStatus = (ui: ExtensionContext["ui"] | undefined = statusUi): void => {
		if (!ui) return;
		const mode = getExecutionMode();
		// The TUI footer owns the "(shift+tab to cycle)" hint on the shared
		// thinking/safety line; the status is just the icon and label.
		ui.setStatus("exec-mode", `${MODE_ICONS[mode]} ${MODE_LABELS[mode]}`);
	};

	const reportStatus = (ctx: ExtensionContext): void => {
		const mode = getExecutionMode();
		const availability = inspectMyPiSandboxAvailability();
		const warnings = availability.warnings.length > 0 ? ` Warnings: ${availability.warnings.join(", ")}.` : "";
		const level = mode === "sandbox" && !availability.available ? "error" : mode === "off" ? "info" : "warning";
		ctx.ui.notify(`Mode: ${MODE_LABELS[mode]}. ${availability.message}${warnings}`, level);
	};

	// Switching into Sandbox On requires a working host sandbox; otherwise report
	// and leave the mode unchanged. Returns the effective mode.
	const enterMode = (ctx: ExtensionContext, requested: ExecutionMode): ExecutionMode => {
		if (requested === "sandbox") {
			const availability = inspectMyPiSandboxAvailability();
			if (!availability.available) {
				ctx.ui.notify(`${availability.message} Sandbox remains unchanged.`, "error");
				return getExecutionMode();
			}
		}
		return setExecutionMode(requested);
	};

	const handleSandboxCommand = async (args: string, ctx: ExtensionContext): Promise<void> => {
		statusUi = ctx.ui;
		const request = args.trim().toLowerCase();
		if (request === "--help" || request === "help") {
			await ctx.ui.editor("Execution mode help", SANDBOX_HELP);
			return;
		}
		if (!request || request === "status") {
			reportStatus(ctx);
			renderModeStatus(ctx.ui);
			return;
		}
		if (request !== "on" && request !== "off") {
			ctx.ui.notify("Usage: /sandbox [on|off|status|--help]", "warning");
			return;
		}
		try {
			// `/sandbox on|off` also writes the global default for new sessions.
			saveMyPiSandboxPreference(request === "on", agentDir);
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			return;
		}
		if (request === "on") {
			const effective = enterMode(ctx, "sandbox");
			if (effective === "sandbox") {
				ctx.ui.notify(
					"Sandbox On. User-data access is workspace/private-scratch-only and shell network is blocked.",
					"warning",
				);
			}
		} else {
			// Turning the default off drops this session out of sandbox, but keeps
			// an active Safe Mode intact.
			if (getExecutionMode() === "sandbox") setExecutionMode("off");
			ctx.ui.notify("Sandbox Off. New shell commands run with normal user permissions.", "info");
		}
		renderModeStatus(ctx.ui);
	};

	const handleModeCommand = async (_args: string, ctx: ExtensionContext): Promise<void> => {
		statusUi = ctx.ui;
		let next = cycleExecutionMode();
		// Skip Sandbox On when the host can't sandbox, so the cycle never lands on
		// an unusable mode.
		if (next === "sandbox" && !inspectMyPiSandboxAvailability().available) {
			next = cycleExecutionMode();
		}
		// Only refresh the footer indicator — no notify. Rapid cycling would
		// otherwise stack a new line each press; the TUI shows a single transient
		// status instead (matching the thinking-level cycle).
		renderModeStatus(ctx.ui);
	};

	pi.registerCommand("sandbox", {
		description: "Configure this session's execution mode (Sandbox Off/On)",
		getArgumentCompletions: (prefix) => {
			const options = ["on", "off", "status", "--help"];
			const matches = options
				.filter((option) => option.startsWith(prefix.trim().toLowerCase()))
				.map((value) => ({ value, label: value }));
			return matches.length > 0 ? matches : null;
		},
		handler: handleSandboxCommand,
	});

	pi.registerCommand("mode", {
		description: "Cycle this session's execution mode (Sandbox Off → On → Safe Mode)",
		handler: handleModeCommand,
	});

	// Another extension (the /safemode alias) or the hotkey may change the mode;
	// keep the footer indicator truthful.
	onExecutionModeChange(() => renderModeStatus());

	pi.on("session_start", (_event, ctx) => {
		statusUi = ctx.ui;
		renderModeStatus(ctx.ui);
	});
	pi.on("before_agent_start", (_event, ctx) => {
		statusUi = ctx.ui;
		renderModeStatus(ctx.ui);
	});
}
