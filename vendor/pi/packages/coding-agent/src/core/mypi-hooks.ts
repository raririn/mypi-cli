/**
 * MyPi user hooks: shell commands declared in hooks.json and executed on
 * session lifecycle events by the built-in hooks extension.
 *
 * Config discovery (both optional, merged global-first):
 *   - global:  <agentDir>/hooks.json
 *   - project: <cwd>/.mypi/hooks.json  (loaded only when the project is trusted)
 *
 * Execution contract (Claude Code-compatible):
 *   - the command runs through the shell with the project cwd, receiving a
 *     JSON payload on stdin
 *   - exit 0 = allow; for injection-capable events declared with `inject: true`
 *     the trimmed stdout is injected as model-visible context
 *   - exit 2 = block; trimmed stderr is the reason shown to the model and user
 *   - any other exit, spawn failure, or timeout = non-blocking warning
 *     (hooks fail open so a broken guard never wedges the session)
 *   - hooks always run OUTSIDE the sandbox: they are the user's own policy
 *     commands (guards, formatters, notifiers) and need the real environment
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.ts";

export type MyPiHookEvent =
	| "pre_tool_use"
	| "post_tool_use"
	| "user_prompt_submit"
	| "session_start"
	| "pre_compact"
	| "agent_settled";

export const MYPI_HOOK_EVENTS: readonly MyPiHookEvent[] = [
	"pre_tool_use",
	"post_tool_use",
	"user_prompt_submit",
	"session_start",
	"pre_compact",
	"agent_settled",
];

export interface MyPiHookDefinition {
	/** Shell command to run. */
	command: string;
	/** Regex matched against the tool name (pre_tool_use / post_tool_use only). Unset = all tools. */
	matcher?: string;
	/** Regex matched against the JSON-serialized tool input (pre_tool_use / post_tool_use only). */
	argMatcher?: string;
	/** Kill the hook after this long. Default 10000. */
	timeoutMs?: number;
	/** user_prompt_submit / session_start: inject trimmed stdout as model-visible context. Default false. */
	inject?: boolean;
	/** Where the hook was loaded from (set by the loader, not the user). */
	source?: "global" | "project";
}

export interface MyPiHooksConfig {
	hooks: Partial<Record<MyPiHookEvent, MyPiHookDefinition[]>>;
	/** Non-fatal problems found while loading (shown once per reload). */
	warnings: string[];
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

function parseHooksFile(path: string, source: "global" | "project", config: MyPiHooksConfig): void {
	if (!existsSync(path)) return;
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		config.warnings.push(`${path}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
		return;
	}
	const hooks = (raw as { hooks?: unknown })?.hooks;
	if (typeof hooks !== "object" || hooks === null) {
		config.warnings.push(`${path}: missing "hooks" object`);
		return;
	}
	for (const [event, defs] of Object.entries(hooks)) {
		if (!MYPI_HOOK_EVENTS.includes(event as MyPiHookEvent)) {
			config.warnings.push(`${path}: unknown hook event "${event}"`);
			continue;
		}
		if (!Array.isArray(defs)) {
			config.warnings.push(`${path}: hooks.${event} must be an array`);
			continue;
		}
		for (const def of defs) {
			if (typeof def !== "object" || def === null || typeof (def as MyPiHookDefinition).command !== "string") {
				config.warnings.push(`${path}: hooks.${event} entries need a string "command"`);
				continue;
			}
			const parsed = def as MyPiHookDefinition;
			for (const field of ["matcher", "argMatcher"] as const) {
				const pattern = parsed[field];
				if (pattern !== undefined) {
					try {
						new RegExp(pattern);
					} catch {
						config.warnings.push(`${path}: hooks.${event} has invalid ${field} regex: ${pattern}`);
					}
				}
			}
			const list = (config.hooks[event as MyPiHookEvent] ??= []);
			list.push({ ...parsed, source });
		}
	}
}

/** Load hooks.json from the agent dir and, when trusted, the project config dir. */
export function loadMyPiHooksConfig(cwd: string, projectTrusted: boolean): MyPiHooksConfig {
	const config: MyPiHooksConfig = { hooks: {}, warnings: [] };
	parseHooksFile(join(getAgentDir(), "hooks.json"), "global", config);
	const projectPath = join(cwd, CONFIG_DIR_NAME, "hooks.json");
	if (projectTrusted) {
		parseHooksFile(projectPath, "project", config);
	} else if (existsSync(projectPath)) {
		config.warnings.push(`${projectPath}: ignored because the project is not trusted (/trust)`);
	}
	return config;
}

/** True when the hook's matcher/argMatcher accept this tool call. */
export function hookMatchesTool(hook: MyPiHookDefinition, toolName: string, input: unknown): boolean {
	try {
		if (hook.matcher !== undefined && !new RegExp(hook.matcher).test(toolName)) return false;
		if (hook.argMatcher !== undefined && !new RegExp(hook.argMatcher).test(JSON.stringify(input ?? {}))) return false;
	} catch {
		return false; // invalid regex was already warned about at load time
	}
	return true;
}

export interface MyPiHookRunResult {
	status: "allow" | "block" | "warn";
	exitCode: number | null;
	stdout: string;
	stderr: string;
	/** Present for "warn" results that did not come from an exit code. */
	warning?: string;
}

/** Run one hook command with the stdin payload contract described above. */
export function runMyPiHook(
	hook: MyPiHookDefinition,
	payload: Record<string, unknown>,
	cwd: string,
): Promise<MyPiHookRunResult> {
	return new Promise((resolve) => {
		const timeoutMs = hook.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (result: MyPiHookRunResult) => {
			if (!settled) {
				settled = true;
				resolve(result);
			}
		};

		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(hook.command, { shell: true, cwd, stdio: ["pipe", "pipe", "pipe"] });
		} catch (error) {
			finish({
				status: "warn",
				exitCode: null,
				stdout: "",
				stderr: "",
				warning: `failed to start: ${error instanceof Error ? error.message : String(error)}`,
			});
			return;
		}

		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish({
				status: "warn",
				exitCode: null,
				stdout,
				stderr,
				warning: `timed out after ${timeoutMs}ms`,
			});
		}, timeoutMs);

		child.stdout?.on("data", (chunk: Buffer) => {
			if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString("utf8");
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			finish({ status: "warn", exitCode: null, stdout, stderr, warning: error.message });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0) {
				finish({ status: "allow", exitCode: code, stdout, stderr });
			} else if (code === 2) {
				finish({ status: "block", exitCode: code, stdout, stderr });
			} else {
				finish({ status: "warn", exitCode: code, stdout, stderr, warning: `exited with code ${code}` });
			}
		});

		try {
			child.stdin?.write(JSON.stringify(payload));
			child.stdin?.end();
		} catch {
			// The child may exit before consuming stdin; the close handler settles the result.
		}
	});
}
