import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import type { SourceInfo } from "./source-info.ts";

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

const TRUSTED_MYPI_CORE_TOOLS = new Set([
	"web_search",
	"web_fetch",
	"get_goal",
	"get_goal_plan",
	"create_goal",
	"set_goal_plan",
	"update_goal_plan",
	"update_goal",
]);
const TRUSTED_USER_INTERACTION_TOOLS = new Set(["ask_user"]);
const TRUSTED_PASSIVE_BUILTIN_TOOLS = new Set(["commentary"]);

function isWithin(path: string, parent: string): boolean {
	const rel = relative(parent, path);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function findPackageRoot(entryPath: string, baseDir?: string): string | undefined {
	let directory = dirname(entryPath);
	const boundary = baseDir ? realpathSync(resolve(baseDir)) : undefined;
	while (true) {
		const manifest = join(directory, "package.json");
		if (existsSync(manifest)) return directory;
		const parent = dirname(directory);
		if (parent === directory || (boundary && !isWithin(directory, boundary))) return undefined;
		directory = parent;
	}
}

function isTrustedPackageTool(sourceInfo: SourceInfo, packageName: string): boolean {
	if (sourceInfo.origin !== "package" || sourceInfo.path.startsWith("<")) return false;
	try {
		const entryPath = realpathSync(resolve(sourceInfo.path));
		const packageRoot = findPackageRoot(entryPath, sourceInfo.baseDir);
		if (!packageRoot) return false;
		const canonicalRoot = realpathSync(packageRoot);
		if (!isWithin(entryPath, canonicalRoot)) return false;
		const manifestPath = join(canonicalRoot, "package.json");
		const stat = lstatSync(manifestPath);
		if (!stat.isFile() || stat.isSymbolicLink()) return false;
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
			name?: unknown;
			pi?: { extensions?: unknown };
		};
		if (manifest.name !== packageName || !Array.isArray(manifest.pi?.extensions)) return false;
		return manifest.pi.extensions.some((candidate) => {
			if (typeof candidate !== "string") return false;
			try {
				return realpathSync(resolve(canonicalRoot, candidate)) === entryPath;
			} catch {
				return false;
			}
		});
	} catch {
		return false;
	}
}

export function isTrustedSafetyTool(name: string, sourceInfo: SourceInfo | undefined): boolean {
	if (!sourceInfo) return false;
	if (TRUSTED_PASSIVE_BUILTIN_TOOLS.has(name)) {
		return sourceInfo.source === "builtin" && sourceInfo.path === `<builtin:${name}>`;
	}
	if (TRUSTED_MYPI_CORE_TOOLS.has(name)) {
		return sourceInfo.source === "builtin" && sourceInfo.path === "<builtin:mypi-core>";
	}
	if (TRUSTED_USER_INTERACTION_TOOLS.has(name)) {
		return isTrustedPackageTool(sourceInfo, "@mypi/core");
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
