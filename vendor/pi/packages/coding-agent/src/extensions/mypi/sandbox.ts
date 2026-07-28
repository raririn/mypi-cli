import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { getAgentDir } from "../../config.ts";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { resolveMyPiSandboxPreference, saveMyPiSandboxPreference } from "../../core/mypi-sandbox.ts";

const SANDBOX_HELP = `# /sandbox — OS sandbox for shell commands

/sandbox
/sandbox status
/sandbox on
/sandbox off
/sandbox --help

When enabled, MyPi runs the built-in bash tool and direct !/!! shell commands through Anthropic's
sandbox runtime. Each command may write only in its current workspace and temporary directory.
Reads of the MyPi agent directory, SSH keys, AWS files, and GnuPG files are denied. Credential-like
environment variables are removed. Shell network access is blocked; use MyPi's built-in web_search
and web_fetch tools for public web access.

Linux hosts provide bubblewrap, socat, and ripgrep. MyPi enables the preference after verifying
host support and these dependencies.
`;

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

	const updateStatus = (ctx: ExtensionContext): boolean | undefined => {
		try {
			const enabled = resolveMyPiSandboxPreference(agentDir).enabled;
			ctx.ui.setStatus("sandbox", enabled ? "SANDBOX" : undefined);
			return enabled;
		} catch (error) {
			ctx.ui.setStatus("sandbox", "SANDBOX ERROR");
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			return undefined;
		}
	};

	const reportStatus = (ctx: ExtensionContext): void => {
		const enabled = updateStatus(ctx);
		if (enabled === undefined) return;
		const availability = inspectMyPiSandboxAvailability();
		const posture = enabled
			? "enabled globally; shell writes are workspace/temp-only and shell network is blocked"
			: "disabled globally; local shell commands run with normal user permissions";
		const warnings = availability.warnings.length > 0 ? ` Warnings: ${availability.warnings.join(", ")}.` : "";
		ctx.ui.notify(
			`Sandbox is ${posture}. ${availability.message}${warnings}`,
			enabled && !availability.available ? "error" : enabled ? "warning" : "info",
		);
	};

	pi.registerCommand("sandbox", {
		description: "Configure the global Anthropic shell sandbox",
		getArgumentCompletions: (prefix) => {
			const options = ["on", "off", "status", "--help"];
			const matches = options
				.filter((option) => option.startsWith(prefix.trim().toLowerCase()))
				.map((value) => ({ value, label: value }));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			const request = args.trim().toLowerCase();
			if (request === "--help" || request === "help") {
				await ctx.ui.editor("Sandbox help", SANDBOX_HELP);
				return;
			}
			if (!request || request === "status") {
				reportStatus(ctx);
				return;
			}
			if (request !== "on" && request !== "off") {
				ctx.ui.notify("Usage: /sandbox [on|off|status|--help]", "warning");
				return;
			}
			if (request === "on") {
				const availability = inspectMyPiSandboxAvailability();
				if (!availability.available) {
					ctx.ui.notify(`${availability.message} Sandbox remains unchanged.`, "error");
					return;
				}
			}
			try {
				saveMyPiSandboxPreference(request === "on", agentDir);
				updateStatus(ctx);
				ctx.ui.notify(
					request === "on"
						? "Sandbox enabled globally. Shell writes are workspace/temp-only and shell network is blocked."
						: "Sandbox disabled globally. New shell commands run with normal user permissions.",
					request === "on" ? "warning" : "info",
				);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		updateStatus(ctx);
	});
	pi.on("before_agent_start", (_event, ctx) => {
		updateStatus(ctx);
	});
}
