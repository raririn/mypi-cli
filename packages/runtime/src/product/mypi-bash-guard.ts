/**
 * Heuristic dangerous-command interception for the bash tool.
 *
 * The guard applies in FULL ACCESS only — the one mode with no other gate in
 * front of bash. Bounded modes stand down: the sandbox would deny the command
 * anyway (approving here and then watching the sandbox block it would be a
 * confusing double gate), and ask/sandbox-ask already route bash through
 * their own user approval. It blocks a small curated set of high-blast-radius
 * shell patterns (full-filesystem find scans, root/home-wiping rm, recursive
 * chmod of system trees, filesystem-destroying writes). A blocked call returns an instruction the
 * model can act on: reconsider, or re-run the exact same command to request
 * user approval. The exact re-run triggers a blocking confirm dialog; the
 * command executes only if the user approves, and an approval admits exactly
 * one execution of that exact command.
 *
 * State is run-scoped: everything resets on new input, agent_settled, and
 * session_shutdown. Config: shared.safety.bashGuard (default on).
 */
import type { ExtensionAPI } from "../core/extensions/types.ts";
import { getAgentDir } from "../config.ts";
import { SettingsManager } from "../core/settings-manager.ts";

export interface DangerMatch {
	/** Stable rule id surfaced to the model and the approval dialog. */
	rule: "find-root" | "rm-dangerous" | "chmod-recursive-root" | "fs-destroy";
	/** Why the command tripped the rule (one clause, no trailing period). */
	reason: string;
	/** Rule-specific "narrower alternative" suggestion for the block message. */
	hint: string;
}

/** Top-level system trees whose recursive traversal or mutation is the blast
 *  radius these rules exist for. */
const ROOT_TREES = new Set([
	"/bin", "/boot", "/dev", "/etc", "/home", "/lib", "/lib64", "/media",
	"/mnt", "/opt", "/proc", "/root", "/run", "/sbin", "/srv", "/sys",
	"/tmp", "/usr", "/var",
]);

/** Trees big enough that a full `find` walk thrashes the disk. Deliberately
 *  narrower than ROOT_TREES: `find /etc -name "*.conf"` is cheap and common. */
const FIND_EXPENSIVE_TREES = new Set(["/usr", "/var"]);

const HOME_TARGETS = new Set(["~", "~/", "$HOME", "$HOME/", "${HOME}", "${HOME}/"]);

/** Relative targets that wipe whatever the cwd happens to be. */
const CWD_BOMBS = new Set([".", "..", "./", "../", "*", "./*"]);

/** `$VAR/` or `${VAR}/*`-shaped targets: with the variable unset they resolve
 *  to the filesystem root — the classic scripted rm footgun. */
const UNEXPANDED_VAR_ROOT = /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?\/\**$/;

const BLOCK_DEVICE = /^\/dev\/(sd[a-z]|hd[a-z]|vd[a-z]|nvme\d+n\d+(p\d+)?|mmcblk\d+(p\d+)?|disk\d+)/;

/** Wrappers whose presence does not change what ultimately runs. */
const COMMAND_WRAPPERS = new Set(["sudo", "doas", "env", "nohup", "nice", "time", "command", "builtin", "exec", "stdbuf", "timeout"]);

/**
 * Split a raw command line into token lists, one list per simple command.
 * Boundaries are unquoted control operators (;, &, |, newlines) plus subshell
 * and group openers/closers — so `echo $(rm -rf /)` still yields an `rm`
 * segment. Quotes are stripped from token content (`rm -rf "/"` matches like
 * `rm -rf /`); backslash escapes are preserved literally. Heuristic by
 * design: this is not a shell parser and does not need to be one.
 */
export function splitCommandSegments(command: string): string[][] {
	const segments: string[][] = [];
	let tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let inBraceVar = false;

	const endToken = () => {
		if (current.length > 0) tokens.push(current);
		current = "";
	};
	const endSegment = () => {
		endToken();
		if (tokens.length > 0) segments.push(tokens);
		tokens = [];
	};

	for (let i = 0; i < command.length; i += 1) {
		const ch = command[i]!;
		if (quote) {
			if (ch === quote) quote = undefined;
			else current += ch;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (ch === "\\") {
			i += 1;
			if (i < command.length) current += command[i]!;
			continue;
		}
		if (inBraceVar) {
			current += ch;
			if (ch === "}") inBraceVar = false;
			continue;
		}
		if (ch === "{" && current.endsWith("$")) {
			// `${VAR}` is token content, not a group opener.
			inBraceVar = true;
			current += ch;
			continue;
		}
		if (ch === ";" || ch === "&" || ch === "|" || ch === "\n" || ch === "`" || ch === "(" || ch === ")" || ch === "{" || ch === "}") {
			// `$(` reads as token text "$" so far; drop it — the boundary is what matters.
			if (ch === "(" && current === "$") current = "";
			endSegment();
			continue;
		}
		if (ch === " " || ch === "\t") {
			endToken();
			continue;
		}
		current += ch;
	}
	endSegment();
	return segments;
}

/** Strip sudo/env-style wrappers and VAR=value assignments off a segment. */
function stripWrappers(tokens: string[]): string[] {
	let index = 0;
	while (index < tokens.length) {
		const token = tokens[index]!;
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
			index += 1;
			continue;
		}
		const name = basename(token);
		if (COMMAND_WRAPPERS.has(name)) {
			index += 1;
			// Consume the wrapper's own option tokens (e.g. `nice -n 10`, `timeout 5s`).
			while (index < tokens.length && (tokens[index]!.startsWith("-") || (name === "timeout" && /^\d/.test(tokens[index]!)))) index += 1;
			continue;
		}
		break;
	}
	return tokens.slice(index);
}

function basename(token: string): string {
	const slash = token.lastIndexOf("/");
	return slash >= 0 ? token.slice(slash + 1) : token;
}

/** "/usr/" → "/usr"; "/" stays "/". */
function stripTrailingSlash(path: string): string {
	return path.length > 1 && path.endsWith("/") ? path.replace(/\/+$/, "") : path;
}

/** True for `/`, `/*`, a top-level system tree, or a glob directly under one
 *  (`/home/*`). */
function isRootishTarget(raw: string): boolean {
	const target = stripTrailingSlash(raw);
	if (target === "/" || target === "/*") return true;
	if (ROOT_TREES.has(target)) return true;
	const globBase = target.endsWith("/*") ? target.slice(0, -2) : undefined;
	return globBase !== undefined && (globBase === "" || ROOT_TREES.has(globBase));
}

function checkFind(tokens: string[]): DangerMatch | undefined {
	if (basename(tokens[0]!) !== "find") return undefined;
	let index = 1;
	// GNU find pre-path options: -H -L -P -Dopts -Olevel.
	while (index < tokens.length && /^-(H|L|P|D.*|O\d*)$/.test(tokens[index]!)) index += 1;
	const paths: string[] = [];
	while (index < tokens.length && !/^[-(!]/.test(tokens[index]!)) {
		paths.push(tokens[index]!);
		index += 1;
	}
	for (const raw of paths) {
		const path = stripTrailingSlash(raw);
		if (path === "/" || path === "/*" || FIND_EXPENSIVE_TREES.has(path)) {
			return {
				rule: "find-root",
				reason: `a filesystem-wide find over ${path} thrashes the disk and floods output`,
				hint: "scope the search to a relevant subtree (find ./src -name …) or locate the file from project structure",
			};
		}
	}
	return undefined;
}

function checkRm(tokens: string[]): DangerMatch | undefined {
	if (basename(tokens[0]!) !== "rm") return undefined;
	let recursive = false;
	const targets: string[] = [];
	let optionsEnded = false;
	for (const token of tokens.slice(1)) {
		if (!optionsEnded && token === "--") {
			optionsEnded = true;
			continue;
		}
		if (!optionsEnded && token.startsWith("-") && token.length > 1) {
			if (token === "--no-preserve-root") {
				return {
					rule: "rm-dangerous",
					reason: "--no-preserve-root exists only to allow deleting the filesystem root",
					hint: "remove the explicit paths you actually mean to delete",
				};
			}
			if (token === "--recursive" || /^-[a-zA-Z]*[rR]/.test(token)) recursive = true;
			continue;
		}
		targets.push(token);
	}
	if (!recursive) return undefined;
	for (const target of targets) {
		if (isRootishTarget(target)) {
			return {
				rule: "rm-dangerous",
				reason: `recursive rm of ${stripTrailingSlash(target)} destroys a system tree`,
				hint: "rm the specific project path you mean, after verifying it with ls",
			};
		}
		if (HOME_TARGETS.has(target)) {
			return {
				rule: "rm-dangerous",
				reason: "recursive rm of the home directory destroys all user data",
				hint: "rm the specific subdirectory you mean",
			};
		}
		if (CWD_BOMBS.has(target)) {
			return {
				rule: "rm-dangerous",
				reason: `recursive rm of ${target} wipes the entire working directory, wherever that is`,
				hint: "rm explicit named paths so a surprising cwd cannot amplify the damage",
			};
		}
		if (UNEXPANDED_VAR_ROOT.test(target)) {
			return {
				rule: "rm-dangerous",
				reason: `${target} resolves to the filesystem root if the variable is empty or unset`,
				hint: "expand and verify the variable first, then rm the literal resulting path",
			};
		}
	}
	return undefined;
}

function checkChmod(tokens: string[]): DangerMatch | undefined {
	if (basename(tokens[0]!) !== "chmod") return undefined;
	let recursive = false;
	const positional: string[] = [];
	for (const token of tokens.slice(1)) {
		if (token.startsWith("-") && token.length > 1) {
			if (token === "--recursive" || /^-[a-zA-Z]*[rR]/.test(token)) recursive = true;
			continue;
		}
		positional.push(token);
	}
	if (!recursive || positional.length < 2) return undefined;
	const mode = positional[0]!;
	const wideOpen = mode === "777" || mode === "a+rwx" || mode === "0777";
	for (const target of positional.slice(1)) {
		if (isRootishTarget(target) || (wideOpen && HOME_TARGETS.has(target))) {
			return {
				rule: "chmod-recursive-root",
				reason: `recursive chmod of ${stripTrailingSlash(target)} breaks system or user-wide permissions`,
				hint: "chmod the specific files that need it, with the narrowest mode that works",
			};
		}
	}
	return undefined;
}

function checkFsDestroy(tokens: string[]): DangerMatch | undefined {
	const name = basename(tokens[0]!);
	if (name.startsWith("mkfs") || name === "wipefs") {
		if (tokens.length > 1) {
			return {
				rule: "fs-destroy",
				reason: `${name} irreversibly destroys the target filesystem`,
				hint: "double-check the device; this is not recoverable",
			};
		}
		return undefined;
	}
	if (name === "dd") {
		for (const token of tokens.slice(1)) {
			if (token.startsWith("of=") && BLOCK_DEVICE.test(token.slice(3))) {
				return {
					rule: "fs-destroy",
					reason: `dd writing to ${token.slice(3)} overwrites a raw block device`,
					hint: "write to a file path, or double-check the device target",
				};
			}
		}
		return undefined;
	}
	// Redirects straight onto a block device: `> /dev/sda` or `>/dev/sda`.
	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i]!;
		if (/^>{1,2}$/.test(token) && i + 1 < tokens.length && BLOCK_DEVICE.test(tokens[i + 1]!)) {
			return { rule: "fs-destroy", reason: `redirecting output onto ${tokens[i + 1]} overwrites a raw block device`, hint: "redirect to a file path instead" };
		}
		const redirect = token.match(/^>{1,2}(\/dev\/.+)$/);
		if (redirect && BLOCK_DEVICE.test(redirect[1]!)) {
			return { rule: "fs-destroy", reason: `redirecting output onto ${redirect[1]} overwrites a raw block device`, hint: "redirect to a file path instead" };
		}
	}
	return undefined;
}

const RULE_CHECKS = [checkFind, checkRm, checkChmod, checkFsDestroy];

/** Returns the first rule match across all simple-command segments. */
export function detectDangerousCommand(command: string): DangerMatch | undefined {
	for (const rawSegment of splitCommandSegments(command)) {
		const tokens = stripWrappers(rawSegment);
		if (tokens.length === 0) continue;
		for (const check of RULE_CHECKS) {
			const match = check(tokens);
			if (match) return match;
		}
	}
	return undefined;
}

export function buildBlockMessage(match: DangerMatch): string {
	return (
		`This command was blocked by a safety rule (rule: ${match.rule} — ${match.reason}). ` +
		`First consider whether a narrower command achieves the goal (e.g., ${match.hint}). ` +
		`If it is genuinely necessary, run the exactly same command again: the user will be asked ` +
		`to approve it, and it executes only if they do. ` +
		`Do NOT attempt to bypass this check by rewriting the command (bash -c, sh, eval, xargs, ` +
		`find -exec/-delete), encoding it (base64, hex), writing it to a script file and executing ` +
		`that, running it through an interpreter (python/perl/node -e), splitting it into smaller ` +
		`steps, aliasing or copying the binary, or altering quoting/variables to obscure the ` +
		`target. Bypassing a safety block violates user trust.`
	);
}

const DENIED_MESSAGE =
	"The user disapproved this command. Do not run it or any variation of it. " +
	"Explain what you wanted it for and let the user decide how to proceed.";

export default function bashGuardExtension(pi: ExtensionAPI): void {
	let enabled = true;
	try {
		enabled = SettingsManager.create(process.cwd(), getAgentDir()).getBashGuardEnabled();
	} catch {
		// Unreadable settings never disable the guard.
	}
	if (!enabled) return;

	/** Commands blocked once this run, waiting for an exact re-run → confirm. */
	const awaitingRerun = new Map<string, DangerMatch>();
	/** Commands the user disapproved this run. */
	const denied = new Set<string>();
	const reset = () => {
		awaitingRerun.clear();
		denied.clear();
	};

	pi.on("input", () => {
		reset();
		return undefined;
	});
	pi.on("agent_settled", () => reset());
	pi.on("session_shutdown", () => reset());

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;
		// Full access only (checked per call — the mode can change between
		// runs). A disabled safety policy behaves as full and keeps the guard.
		if (pi.getSafetyState().effective !== "full") return undefined;
		const command = String(event.input.command ?? "");
		const match = detectDangerousCommand(command);
		if (!match) return undefined;

		const key = command.trim();
		if (denied.has(key)) return { block: true, reason: DENIED_MESSAGE };

		if (!awaitingRerun.has(key)) {
			awaitingRerun.set(key, match);
			return { block: true, reason: buildBlockMessage(match) };
		}

		if (!ctx.hasUI) {
			return { block: true, reason: `This command requires interactive user approval (rule: ${match.rule}) and no approval UI is available. Do not attempt it in this environment.` };
		}

		pi.events.emit("mypi:approval-state", { waiting: true, toolName: "bash" });
		let approved = false;
		try {
			approved = await ctx.ui.confirm(
				`Dangerous command (${match.rule})`,
				`The assistant asks to run:\n\n${key}\n\nRule: ${match.reason}. Approve this one execution?`,
			);
		} finally {
			pi.events.emit("mypi:approval-state", { waiting: false, toolName: "bash" });
		}
		awaitingRerun.delete(key);
		if (approved) return undefined;
		denied.add(key);
		return { block: true, reason: DENIED_MESSAGE };
	});
}
