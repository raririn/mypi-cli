import {
	chmodSync,
	closeSync,
	fsyncSync,
	lstatSync,
	mkdtempSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	type Stats,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { getAgentDir } from "../config.ts";

export interface MyPiSandboxPreference {
	version: 1;
	enabled: boolean;
}

export interface MyPiSandboxHelperRequest {
	command: string;
	cwd: string;
	shell: string;
	config: SandboxRuntimeConfig;
}

/** Private helper-to-parent control message; the sandboxed command never inherits this descriptor. */
export const MYPI_SANDBOX_DENIAL_CONTROL = "mypi:sandbox-denied:v1\n";

export interface MyPiSandboxProcessLaunch {
	command: string;
	args: string[];
	env: NodeJS.ProcessEnv;
	input: string;
	/** Host-created, command-private scratch directory. The parent removes it after the helper exits. */
	temporaryDirectory: string;
}

export const DEFAULT_MYPI_SANDBOX_PREFERENCE: MyPiSandboxPreference = {
	version: 1,
	enabled: false,
};

const SENSITIVE_ENV_NAMES = new Set([
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_OAUTH_TOKEN",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"BRAVE_API_KEY",
	"CLOUDFLARE_API_TOKEN",
	"DOCKER_AUTH_CONFIG",
	"GIT_ASKPASS",
	"GITHUB_TOKEN",
	"GH_TOKEN",
	"GPG_AGENT_INFO",
	"HF_TOKEN",
	"KUBECONFIG",
	"NETRC",
	"NPM_TOKEN",
	"SSH_ASKPASS",
	"SSH_AUTH_SOCK",
]);

const SENSITIVE_ENV_PATTERN =
	/(?:^|_)(?:API_?KEY|AUTH_?TOKEN|OAUTH_?TOKEN|ACCESS_?TOKEN|ACCESS_?KEY|SECRET|PASSWORD|PASSWD|TOKEN)$/i;

function assertSafeAgentDirectory(agentDir: string): string {
	const root = resolve(agentDir);
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const stat = lstatSync(root);
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		throw new Error(`Refusing unsafe MyPi agent directory at ${root}: expected a non-symlinked directory.`);
	}
	return root;
}

function lstatIfPresent(path: string): Stats | undefined {
	try {
		return lstatSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export function myPiSandboxPreferencePath(agentDir = getAgentDir()): string {
	return resolve(agentDir, "sandbox-config.json");
}

export function resolveMyPiSandboxPreference(agentDir = getAgentDir()): MyPiSandboxPreference {
	const path = myPiSandboxPreferencePath(agentDir);
	const stat = lstatIfPresent(path);
	if (!stat) {
		return { ...DEFAULT_MYPI_SANDBOX_PREFERENCE };
	}

	if (!stat.isFile() || stat.isSymbolicLink()) {
		throw new Error(`Refusing unsafe sandbox preference at ${path}: expected a regular non-symlinked file.`);
	}

	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		throw new Error(`Could not parse sandbox preference at ${path}; expected valid JSON.`);
	}
	if (!value || typeof value !== "object") {
		throw new Error(`Invalid sandbox preference at ${path}.`);
	}
	const candidate = value as { version?: unknown; enabled?: unknown };
	if (candidate.version !== 1 || typeof candidate.enabled !== "boolean") {
		throw new Error(`Invalid sandbox preference at ${path}; expected version 1 and a boolean enabled field.`);
	}
	return { version: 1, enabled: candidate.enabled };
}

export function saveMyPiSandboxPreference(enabled: boolean, agentDir = getAgentDir()): void {
	if (typeof enabled !== "boolean") {
		throw new Error("Invalid sandbox preference; enabled must be a boolean.");
	}
	const root = assertSafeAgentDirectory(agentDir);
	const path = myPiSandboxPreferencePath(root);
	const stat = lstatIfPresent(path);
	if (stat) {
		if (!stat.isFile() || stat.isSymbolicLink()) {
			throw new Error(`Refusing unsafe sandbox preference at ${path}: expected a regular non-symlinked file.`);
		}
	}

	const temporaryPath = `${path}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
	let descriptor: number | undefined;
	try {
		descriptor = openSync(temporaryPath, "wx", 0o600);
		writeFileSync(descriptor, `${JSON.stringify({ version: 1, enabled }, null, 2)}\n`, "utf8");
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = undefined;
		chmodSync(temporaryPath, 0o600);
		renameSync(temporaryPath, path);
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
		rmSync(temporaryPath, { force: true });
	}
}

function uniquePaths(paths: string[]): string[] {
	return [...new Set(paths.map((path) => resolve(path)))];
}

function canonicalPathIfPresent(path: string): string {
	try {
		return realpathSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return resolve(path);
		throw error;
	}
}

function defaultSharedScratchDirectories(): string[] {
	const paths = [join(tmpdir(), "claude")];
	if (process.platform !== "win32") paths.push("/tmp/claude", "/private/tmp/claude");
	return uniquePaths(paths);
}

function sandboxReadDenyRoots(homeDir: string): string[] {
	const paths = [homeDir, tmpdir()];
	if (process.platform === "darwin") paths.push("/Users", "/Volumes", "/tmp", "/private/tmp");
	if (process.platform === "linux") paths.push("/home", "/media", "/mnt", "/tmp");
	return uniquePaths(paths.map(canonicalPathIfPresent));
}

function sandboxExecutableReadPaths(shell: string, env: NodeJS.ProcessEnv): string[] {
	const pathEntries = (env.PATH ?? "")
		.split(delimiter)
		.filter(Boolean)
		.map((entry) => (isAbsolute(entry) ? entry : resolve(entry)));
	// Commands still need their executable directories. The running Node
	// installation root also keeps npm/corepack usable when Node is installed
	// under a user profile (for example through nvm).
	return uniquePaths(
		[
			shell,
			dirname(shell),
			process.execPath,
			dirname(process.execPath),
			dirname(dirname(process.execPath)),
			...pathEntries,
		].map(canonicalPathIfPresent),
	);
}

function isSameOrAncestor(candidate: string, target: string): boolean {
	const rel = relative(candidate, target);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function createSandboxScratchDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "mypi-sandbox-"));
	chmodSync(directory, 0o700);
	return realpathSync(directory);
}

function assertSandboxScratchDirectory(path: string): string {
	const root = canonicalPathIfPresent(tmpdir());
	const candidate = resolve(path);
	const rel = relative(root, candidate);
	if (
		dirname(candidate) !== root ||
		!basename(candidate).startsWith("mypi-sandbox-") ||
		rel === "" ||
		rel.startsWith("..") ||
		isAbsolute(rel)
	) {
		throw new Error(`Refusing unsafe sandbox scratch cleanup at ${candidate}.`);
	}
	return candidate;
}

export function cleanupMyPiSandboxProcessLaunch(launch: MyPiSandboxProcessLaunch | undefined): void {
	if (!launch) return;
	rmSync(assertSandboxScratchDirectory(launch.temporaryDirectory), { recursive: true, force: true });
}

export function buildMyPiSandboxRuntimeConfig(
	cwd: string,
	options: { agentDir?: string; homeDir?: string; tempDir?: string; executableReadPaths?: string[] } = {},
): SandboxRuntimeConfig {
	const workspace = canonicalPathIfPresent(cwd);
	const agentDir = resolve(options.agentDir ?? getAgentDir());
	const homeDir = resolve(options.homeDir ?? homedir());
	const tempDir = options.tempDir ? canonicalPathIfPresent(options.tempDir) : undefined;
	const protectedDirectories = uniquePaths([
		agentDir,
		join(homeDir, ".ssh"),
		join(homeDir, ".aws"),
		join(homeDir, ".azure"),
		join(homeDir, ".docker"),
		join(homeDir, ".gnupg"),
		join(homeDir, ".kube"),
		join(homeDir, ".config", "gcloud"),
		join(homeDir, ".config", "gh"),
		join(homeDir, ".config", "git", "credentials"),
		join(homeDir, ".git-credentials"),
		join(homeDir, ".netrc"),
		join(homeDir, ".npmrc"),
		join(homeDir, ".pypirc"),
	]);
	const deniedDefaultWrites = uniquePaths([
		join(homeDir, ".npm", "_logs"),
		join(homeDir, ".claude", "debug"),
		...defaultSharedScratchDirectories(),
	]);
	const readDenyRoots = sandboxReadDenyRoots(homeDir);
	const executableReadPaths = (options.executableReadPaths ?? [])
		.map(canonicalPathIfPresent)
		// PATH is user-controlled. Never let a broad entry such as $HOME or /
		// cancel the user-data deny; narrower tool directories remain usable.
		.filter((path) => !readDenyRoots.some((root) => isSameOrAncestor(path, root)));

	return {
		network: {
			allowedDomains: [],
			deniedDomains: ["*"],
			strictAllowlist: true,
			allowLocalBinding: false,
		},
		filesystem: {
			denyRead: uniquePaths([...readDenyRoots, ...protectedDirectories]),
			allowRead: uniquePaths([workspace, ...(tempDir ? [tempDir] : []), ...executableReadPaths]),
			allowWrite: uniquePaths([workspace, ...(tempDir ? [tempDir] : [])]),
			denyWrite: uniquePaths([...protectedDirectories, ...deniedDefaultWrites]),
			allowGitConfig: false,
		},
		git: {
			safeDirectories: [workspace],
		},
	};
}

export function pruneMyPiSandboxEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const pruned: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(env)) {
		if (value === undefined || SENSITIVE_ENV_NAMES.has(name.toUpperCase()) || SENSITIVE_ENV_PATTERN.test(name)) {
			continue;
		}
		pruned[name] = value;
	}
	return pruned;
}

function sandboxHelperPath(): string {
	const sourcePath = fileURLToPath(import.meta.url);
	const extension = sourcePath.endsWith(".ts") ? ".ts" : ".js";
	return join(dirname(sourcePath), `mypi-sandbox-helper${extension}`);
}

/**
 * Build the sandbox-helper launch for one command. Whether to sandbox at all is
 * decided per session by the caller via `isSandboxActive()` (see the bash tool);
 * this builder assumes the decision was already made and always returns a launch.
 */
export function createMyPiSandboxProcessLaunch(
	command: string,
	cwd: string,
	shell: string,
	env: NodeJS.ProcessEnv,
	options: { agentDir?: string; helperPath?: string; executablePath?: string; enabled?: boolean } = {},
): MyPiSandboxProcessLaunch | undefined {
	const agentDir = options.agentDir ?? getAgentDir();
	const enabled = options.enabled ?? resolveMyPiSandboxPreference(agentDir).enabled;
	if (!enabled) {
		return undefined;
	}
	const temporaryDirectory = createSandboxScratchDirectory();
	try {
		const helperPath = options.helperPath ?? sandboxHelperPath();
		const helperArgs = helperPath.endsWith(".ts") ? ["--experimental-strip-types", helperPath] : [helperPath];
		const request: MyPiSandboxHelperRequest = {
			command,
			cwd: canonicalPathIfPresent(cwd),
			shell,
			config: buildMyPiSandboxRuntimeConfig(cwd, {
				agentDir,
				tempDir: temporaryDirectory,
				executableReadPaths: sandboxExecutableReadPaths(shell, env),
			}),
		};
		const launchEnv = pruneMyPiSandboxEnvironment(env);
		launchEnv.ELECTRON_RUN_AS_NODE = "1";
		launchEnv.CLAUDE_CODE_TMPDIR = temporaryDirectory;
		return {
			command: options.executablePath ?? process.execPath,
			args: helperArgs,
			env: launchEnv,
			input: JSON.stringify(request),
			temporaryDirectory,
		};
	} catch (error) {
		rmSync(assertSandboxScratchDirectory(temporaryDirectory), { recursive: true, force: true });
		throw error;
	}
}
