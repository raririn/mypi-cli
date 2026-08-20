import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { parseDocument, stringify } from "yaml";
import { getAgentDir } from "../config.ts";
import type { ExtensionAPI, ExtensionContext } from "../core/extensions/types.ts";

export const GLOBAL_CONFIG_VERSION = 1;
export const GLOBAL_CONFIG_FILENAME = "config.yaml";
const MAX_GLOBAL_CONFIG_BYTES = 1024 * 1024;

export interface HistoryConfig {
	readonly autoArchive: boolean;
	readonly shortTestMaxWords: number;
	readonly maxActive: number;
	readonly maxArchived: number;
}

export interface SubagentsConfig {
	readonly advisorModel: "inherit" | string;
}

export interface GlobalConfig {
	readonly version: 1;
	readonly history: HistoryConfig;
	readonly subagents: SubagentsConfig;
}

export interface GlobalConfigDiagnostic {
	readonly code: "malformed" | "unsupported-version" | "unsafe-file";
	readonly message: string;
	readonly path: string;
}

export interface GlobalConfigLoadResult {
	readonly config: GlobalConfig;
	readonly diagnostic?: GlobalConfigDiagnostic;
}

export const DEFAULT_GLOBAL_CONFIG: GlobalConfig = Object.freeze({
	version: GLOBAL_CONFIG_VERSION,
	history: Object.freeze({
		autoArchive: true,
		shortTestMaxWords: 10,
		maxActive: 10,
		maxArchived: 10,
	}),
	subagents: Object.freeze({ advisorModel: "inherit" }),
});

type ConfigRecord = Record<string, unknown>;
type HistoryKey = "autoArchive" | "shortTestMaxWords" | "maxActive" | "maxArchived";

const HELP = `# /config — inspect or update global MyPi configuration

## Syntax

/config
/config history
/config history auto-archive on|off
/config history short-test-max-words <1..100>
/config history max-active <1..1000>
/config history max-archived <1..1000>
/config reset --confirm

Use /advisor-model to inspect or change the global advisor/reviewer model.

Configuration is stored in $MYPI_AGENT_DIR/config.yaml. Changes are global to
that MyPi profile and affect the next new-session maintenance pass. Malformed or
unsafe configuration applies complete defaults and is never overwritten unless
you explicitly run /config reset --confirm on a regular file.`;

export function resolveGlobalConfigPath(agentDir = getAgentDir()): string {
	return join(agentDir, GLOBAL_CONFIG_FILENAME);
}

export async function loadGlobalConfig(path = resolveGlobalConfigPath()): Promise<GlobalConfigLoadResult> {
	let raw: string;
	try {
		const info = await lstat(path);
		if (info.isSymbolicLink() || !info.isFile()) {
			return invalidResult("unsafe-file", `MyPi global configuration is not a regular non-symlink file: ${path}`, path);
		}
		if (info.size > MAX_GLOBAL_CONFIG_BYTES) {
			return invalidResult("malformed", `MyPi global configuration exceeds ${MAX_GLOBAL_CONFIG_BYTES} bytes: ${path}`, path);
		}
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (isErrorCode(error, "ENOENT")) return { config: cloneDefaults() };
		return invalidResult("unsafe-file", `MyPi could not safely read global configuration at ${path}.`, path);
	}

	const parsed = parseConfigRecord(raw, path);
	if ("diagnostic" in parsed) return { config: cloneDefaults(), diagnostic: parsed.diagnostic };
	return { config: parsed.config };
}

export async function updateHistoryConfig(
	key: HistoryKey,
	value: boolean | number,
	path = resolveGlobalConfigPath(),
): Promise<GlobalConfig> {
	return withConfigLock(path, async () => {
		const source = await readConfigSourceForMutation(path);
		const history = isRecord(source.history) ? { ...source.history } : {};
		history[key] = value;
		const next = { ...source, version: GLOBAL_CONFIG_VERSION, history };
		const parsed = parseConfigRecord(stringify(next), path);
		if ("diagnostic" in parsed) throw new Error(parsed.diagnostic.message);
		await atomicWriteConfig(path, stringify(next, { lineWidth: 0 }));
		return parsed.config;
	});
}

export async function updateAdvisorModel(
	advisorModel: "inherit" | string,
	path = resolveGlobalConfigPath(),
): Promise<GlobalConfig> {
	if (!isAdvisorModel(advisorModel)) throw new Error("Advisor model must be inherit or provider/model.");
	return withConfigLock(path, async () => {
		const source = await readConfigSourceForMutation(path);
		const subagents = isRecord(source.subagents) ? { ...source.subagents } : {};
		subagents.advisorModel = advisorModel;
		const next = { ...source, version: GLOBAL_CONFIG_VERSION, subagents };
		const parsed = parseConfigRecord(stringify(next), path);
		if ("diagnostic" in parsed) throw new Error(parsed.diagnostic.message);
		await atomicWriteConfig(path, stringify(next, { lineWidth: 0 }));
		return parsed.config;
	});
}

export async function resetGlobalConfig(path = resolveGlobalConfigPath()): Promise<GlobalConfig> {
	return withConfigLock(path, async () => {
		await assertResetTargetSafe(path);
		const next = cloneDefaults();
		await atomicWriteConfig(path, stringify(next, { lineWidth: 0 }));
		return next;
	});
}

export default function globalConfigExtension(pi: ExtensionAPI): void {
	let warned = false;
	const show = async (ctx: ExtensionContext) => {
		const loaded = await loadGlobalConfig();
		if (loaded.diagnostic) ctx.ui.notify(loaded.diagnostic.message, "warning");
		ctx.ui.notify(`${formatHistoryConfig(loaded.config.history)} ${formatSubagentsConfig(loaded.config.subagents)}`, "info");
	};
	const handle = async (args: string, ctx: ExtensionContext) => {
		const tokens = args.trim().split(/\s+/u).filter(Boolean);
		if (tokens.length === 0 || (tokens.length === 1 && (tokens[0] === "history" || tokens[0] === "status"))) {
			await show(ctx);
			return;
		}
		if (tokens.length === 1 && (tokens[0] === "--help" || tokens[0] === "help")) {
			await ctx.ui.editor("MyPi global configuration", HELP);
			return;
		}
		if (tokens[0] === "reset") {
			if (tokens.length !== 2 || tokens[1] !== "--confirm") {
				ctx.ui.notify("Reset is destructive. Use /config reset --confirm to replace config.yaml with defaults.", "warning");
				return;
			}
			try {
				const config = await resetGlobalConfig();
				ctx.ui.notify(`Reset MyPi global configuration. ${formatHistoryConfig(config.history)} ${formatSubagentsConfig(config.subagents)}`, "info");
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
			}
			return;
		}
		if (tokens[0] !== "history" || tokens.length !== 3) {
			ctx.ui.notify("Usage: /config history <auto-archive|short-test-max-words|max-active|max-archived> <value>", "warning");
			return;
		}
		const parsed = parseHistoryUpdate(tokens[1]!, tokens[2]!);
		if (!parsed) {
			ctx.ui.notify("Invalid history configuration value. Run /config --help for bounds.", "warning");
			return;
		}
		try {
			const config = await updateHistoryConfig(parsed.key, parsed.value);
			ctx.ui.notify(`Updated MyPi global configuration. ${formatHistoryConfig(config.history)}`, "info");
		} catch (error) {
			ctx.ui.notify(errorMessage(error), "error");
		}
	};

	pi.registerCommand("config", {
		description: "Inspect or update versioned global MyPi configuration",
		getArgumentCompletions: (prefix) => {
			const values = [
				"history",
				"history auto-archive ",
				"history short-test-max-words ",
				"history max-active ",
				"history max-archived ",
				"reset --confirm",
				"--help",
			];
			const items = values.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
			return items.length ? items : null;
		},
		handler: handle,
	});
	pi.on("session_start", async (_event, ctx) => {
		if (warned) return;
		warned = true;
		const loaded = await loadGlobalConfig();
		if (loaded.diagnostic) ctx.ui.notify(loaded.diagnostic.message, "warning");
	});
}

function parseConfigRecord(
	raw: string,
	path: string,
): { readonly config: GlobalConfig; readonly source: ConfigRecord } | { readonly diagnostic: GlobalConfigDiagnostic } {
	try {
		const document = parseDocument(raw, { uniqueKeys: true });
		if (document.errors.length > 0) {
			return { diagnostic: diagnostic("malformed", `MyPi global configuration is malformed; defaults are active. Repair ${path} or run /config reset --confirm.`, path) };
		}
		const source = document.toJS({ maxAliasCount: 0 });
		if (!isRecord(source)) return { diagnostic: diagnostic("malformed", `MyPi global configuration must be a YAML mapping; defaults are active. Repair ${path} or run /config reset --confirm.`, path) };
		if (source.version !== GLOBAL_CONFIG_VERSION) {
			return { diagnostic: diagnostic("unsupported-version", `MyPi global configuration version is unsupported; defaults are active. Repair ${path} or run /config reset --confirm.`, path) };
		}
		const history = source.history === undefined ? {} : source.history;
		if (!isRecord(history)) return { diagnostic: invalidOwnedConfig(path) };
		const subagents = source.subagents === undefined ? {} : source.subagents;
		if (!isRecord(subagents)) return { diagnostic: invalidOwnedConfig(path) };
		const config: GlobalConfig = {
			version: GLOBAL_CONFIG_VERSION,
			history: {
				autoArchive: readBoolean(history.autoArchive, DEFAULT_GLOBAL_CONFIG.history.autoArchive),
				shortTestMaxWords: readBoundedInteger(history.shortTestMaxWords, 1, 100, DEFAULT_GLOBAL_CONFIG.history.shortTestMaxWords),
				maxActive: readBoundedInteger(history.maxActive, 1, 1_000, DEFAULT_GLOBAL_CONFIG.history.maxActive),
				maxArchived: readBoundedInteger(history.maxArchived, 1, 1_000, DEFAULT_GLOBAL_CONFIG.history.maxArchived),
			},
			subagents: {
				advisorModel: typeof subagents.advisorModel === "string"
					? subagents.advisorModel
					: DEFAULT_GLOBAL_CONFIG.subagents.advisorModel,
			},
		};
		if (
			(history.autoArchive !== undefined && typeof history.autoArchive !== "boolean") ||
			!validOptionalInteger(history.shortTestMaxWords, 1, 100) ||
			!validOptionalInteger(history.maxActive, 1, 1_000) ||
			!validOptionalInteger(history.maxArchived, 1, 1_000)
			|| (subagents.advisorModel !== undefined && !isAdvisorModel(subagents.advisorModel))
		) return { diagnostic: invalidOwnedConfig(path) };
		return { config, source };
	} catch {
		return { diagnostic: diagnostic("malformed", `MyPi global configuration is malformed; defaults are active. Repair ${path} or run /config reset --confirm.`, path) };
	}
}

async function readConfigSourceForMutation(path: string): Promise<ConfigRecord> {
	try {
		const info = await lstat(path);
		if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Refusing to replace unsafe MyPi global configuration at ${path}.`);
		if (info.size > MAX_GLOBAL_CONFIG_BYTES) throw new Error(`MyPi global configuration exceeds ${MAX_GLOBAL_CONFIG_BYTES} bytes; the file was not changed.`);
		const raw = await readFile(path, "utf8");
		const parsed = parseConfigRecord(raw, path);
		if ("diagnostic" in parsed) {
			throw new Error(`${parsed.diagnostic.message} The file was not changed.`);
		}
		return parsed.source;
	} catch (error) {
		if (isErrorCode(error, "ENOENT")) return { ...cloneDefaults() };
		throw error;
	}
}

async function assertResetTargetSafe(path: string): Promise<void> {
	try {
		const info = await lstat(path);
		if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Refusing to reset unsafe MyPi global configuration at ${path}.`);
	} catch (error) {
		if (!isErrorCode(error, "ENOENT")) throw error;
	}
}

async function withConfigLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
	const parent = dirname(path);
	await mkdir(parent, { recursive: true, mode: 0o700 });
	let release: (() => Promise<void>) | undefined;
	try {
		release = await lockfile.lock(parent, {
			realpath: false,
			lockfilePath: `${path}.lock`,
			stale: 30_000,
			update: 10_000,
			retries: { retries: 10, factor: 2, minTimeout: 20, maxTimeout: 500 },
		});
		return await operation();
	} finally {
		await release?.();
	}
}

async function atomicWriteConfig(path: string, content: string): Promise<void> {
	const parent = dirname(path);
	await mkdir(parent, { recursive: true, mode: 0o700 });
	const temporary = join(parent, `.${GLOBAL_CONFIG_FILENAME}.${process.pid}.${randomUUID()}.tmp`);
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
		await handle.writeFile(content.endsWith("\n") ? content : `${content}\n`, "utf8");
		await handle.sync();
		await handle.close();
		handle = undefined;
		await rename(temporary, path);
		await chmod(path, 0o600);
		const directory = await open(parent, constants.O_RDONLY);
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	} finally {
		await handle?.close().catch(() => undefined);
		await rm(temporary, { force: true }).catch(() => undefined);
	}
}

function parseHistoryUpdate(name: string, value: string): { key: HistoryKey; value: boolean | number } | undefined {
	if (name === "auto-archive") {
		if (value === "on") return { key: "autoArchive", value: true };
		if (value === "off") return { key: "autoArchive", value: false };
		return undefined;
	}
	const number = Number(value);
	if (!Number.isInteger(number)) return undefined;
	if (name === "short-test-max-words" && number >= 1 && number <= 100) return { key: "shortTestMaxWords", value: number };
	if (name === "max-active" && number >= 1 && number <= 1_000) return { key: "maxActive", value: number };
	if (name === "max-archived" && number >= 1 && number <= 1_000) return { key: "maxArchived", value: number };
	return undefined;
}

function formatHistoryConfig(config: HistoryConfig): string {
	return `History: auto-archive ${config.autoArchive ? "on" : "off"}; short-test words <${config.shortTestMaxWords}; max active ${config.maxActive}; max archived ${config.maxArchived}.`;
}

function formatSubagentsConfig(config: SubagentsConfig): string {
	return `Advisor/reviewer model: ${config.advisorModel}.`;
}

function cloneDefaults(): GlobalConfig {
	return {
		version: GLOBAL_CONFIG_VERSION,
		history: { ...DEFAULT_GLOBAL_CONFIG.history },
		subagents: { ...DEFAULT_GLOBAL_CONFIG.subagents },
	};
}

function invalidResult(code: GlobalConfigDiagnostic["code"], message: string, path: string): GlobalConfigLoadResult {
	return { config: cloneDefaults(), diagnostic: diagnostic(code, `${message} Complete defaults are active.`, path) };
}

function invalidOwnedConfig(path: string): GlobalConfigDiagnostic {
	return diagnostic("malformed", `MyPi global configuration is invalid; complete defaults are active. Repair ${path} or run /config reset --confirm.`, path);
}

function diagnostic(code: GlobalConfigDiagnostic["code"], message: string, path: string): GlobalConfigDiagnostic {
	return { code, message, path };
}

function readBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function readBoundedInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
	return Number.isInteger(value) && (value as number) >= minimum && (value as number) <= maximum ? (value as number) : fallback;
}

function validOptionalInteger(value: unknown, minimum: number, maximum: number): boolean {
	return value === undefined || (Number.isInteger(value) && (value as number) >= minimum && (value as number) <= maximum);
}

function isAdvisorModel(value: unknown): value is string {
	return typeof value === "string" && (
		value === "inherit" || (
			value.length >= 3 && value.length <= 512 && /^[^\s/]+\/.+$/u.test(value) && !/[\r\n\0]/u.test(value)
		)
	);
}

function isRecord(value: unknown): value is ConfigRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrorCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
