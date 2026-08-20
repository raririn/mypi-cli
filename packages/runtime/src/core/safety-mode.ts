import { isAbsolute, relative, sep, win32 } from "node:path";
import type { SourceInfo } from "./source-info.ts";
import { hasProductAuthority } from "./source-info.ts";

export const SAFETY_MODES = ["safe", "sandbox", "sandbox-ask", "ask", "full"] as const;
export type SafetyMode = (typeof SAFETY_MODES)[number];

// Preserve the authority existing installations had before the safety ladder.
// Users can opt new sessions into a stricter default with `/safety --global`.
export const DEFAULT_SAFETY_MODE: SafetyMode = "full";
export const SAFETY_SESSION_ENTRY = "mypi-safety-mode";

export const SAFETY_MODE_LABELS: Record<SafetyMode, string> = {
	safe: "Safe",
	sandbox: "Sandboxed",
	"sandbox-ask": "Sandbox + Approval",
	ask: "Ask First",
	full: "Full Access",
};

export const SAFETY_MODE_ICONS: Record<SafetyMode, string> = {
	safe: "✓",
	sandbox: "▣",
	"sandbox-ask": "◈",
	ask: "?",
	full: "!",
};

export const SAFETY_MODE_DESCRIPTIONS: Record<SafetyMode, string> = {
	safe: "Workspace read/write and trusted web tools; shell hidden",
	sandbox: "Workspace read/write and sandboxed shell; denials are final",
	"sandbox-ask": "Sandbox first; approve an exact denied or unclassified operation",
	ask: "Broad access, with approval before sensitive operations",
	full: "Broad access without sandbox or approval prompts",
};

export interface SafetySessionState {
	version: 1;
	effective: SafetyMode;
	pending?: SafetyMode;
}

export function isSafetyMode(value: unknown): value is SafetyMode {
	return typeof value === "string" && (SAFETY_MODES as readonly string[]).includes(value);
}

export function parseSafetyMode(value: string): SafetyMode | undefined {
	const normalized = value.trim().toLowerCase().replace(/\s*\+\s*/g, "-").replace(/[ _]+/g, "-");
	const aliases: Record<string, SafetyMode> = {
		safe: "safe",
		strict: "safe",
		sandbox: "sandbox",
		sandboxed: "sandbox",
		"sandbox-ask": "sandbox-ask",
		"sandbox+approval": "sandbox-ask",
		"sandbox-approval": "sandbox-ask",
		ask: "ask",
		"ask-first": "ask",
		approval: "ask",
		full: "full",
		"full-access": "full",
	};
	return aliases[normalized];
}

export function cycleSafetyMode(mode: SafetyMode): SafetyMode {
	return SAFETY_MODES[(SAFETY_MODES.indexOf(mode) + 1) % SAFETY_MODES.length]!;
}

export function decodeSafetySessionState(value: unknown): SafetySessionState | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as { version?: unknown; effective?: unknown; pending?: unknown; mode?: unknown };
	const effective = isSafetyMode(candidate.effective)
		? candidate.effective
		: isSafetyMode(candidate.mode)
			? candidate.mode
			: undefined;
	if (candidate.version !== 1 || !effective) return undefined;
	return {
		version: 1,
		effective,
		...(isSafetyMode(candidate.pending) && candidate.pending !== effective ? { pending: candidate.pending } : {}),
	};
}

export function latestSafetySessionState(
	entries: readonly unknown[],
	fallback: SafetyMode = DEFAULT_SAFETY_MODE,
): SafetySessionState {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (
			entry &&
			typeof entry === "object" &&
			"type" in entry &&
			entry.type === "custom" &&
			"customType" in entry &&
			entry.customType === SAFETY_SESSION_ENTRY &&
			"data" in entry
		) {
			return decodeSafetySessionState(entry.data) ?? { version: 1, effective: fallback };
		}
	}
	return { version: 1, effective: fallback };
}

export function isBoundedSafetyMode(mode: SafetyMode): boolean {
	return mode === "safe" || mode === "sandbox" || mode === "sandbox-ask";
}

export function safetyUsesSandbox(mode: SafetyMode): boolean {
	return mode === "sandbox" || mode === "sandbox-ask";
}

const TRUSTED_PRODUCT_TOOLS = new Set([
	"web_search",
	"web_fetch",
	"get_goal",
	"get_goal_plan",
	"create_goal",
	"set_goal_plan",
	"update_goal_plan",
	"update_goal",
	"subagent_start",
	"subagent_followup",
	"subagent_cancel",
	"subagent_status",
]);
const TRUSTED_PASSIVE_BUILTIN_TOOLS = new Set(["commentary"]);

export function isTrustedSafetyTool(name: string, sourceInfo: SourceInfo | undefined): boolean {
	if (!sourceInfo) return false;
	if (TRUSTED_PASSIVE_BUILTIN_TOOLS.has(name)) {
		return sourceInfo.source === "builtin" && sourceInfo.path === `<builtin:${name}>`;
	}
	if (TRUSTED_PRODUCT_TOOLS.has(name)) {
		return hasProductAuthority(sourceInfo, ["required", "capability"]);
	}
	if (name === "ask_user" || name === "set_status") {
		return hasProductAuthority(sourceInfo, ["capability"]);
	}
	return false;
}

export function isOrdinaryReadTool(name: string, sourceInfo: SourceInfo | undefined): boolean {
	return Boolean(sourceInfo?.source === "builtin" && ["read", "grep", "find", "ls", "read_workspace"].includes(name));
}

export function isWorkspaceTool(name: string, sourceInfo: SourceInfo | undefined): boolean {
	return Boolean(sourceInfo?.source === "builtin" && (name === "read_workspace" || name === "write_workspace"));
}

export function displayedSafetyMode(effective: SafetyMode, pending?: SafetyMode): SafetyMode {
	return pending && pending !== effective ? pending : effective;
}

export function safetyModeFooterText(effective: SafetyMode, pending?: SafetyMode): string {
	const mode = displayedSafetyMode(effective, pending);
	return `${SAFETY_MODE_ICONS[mode]} ${SAFETY_MODE_LABELS[mode]}`;
}

export function isAbsoluteOnAnyPlatform(path: string): boolean {
	return isAbsolute(path) || win32.isAbsolute(path) || path.startsWith("\\\\");
}

export function isPathInside(path: string, root: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
