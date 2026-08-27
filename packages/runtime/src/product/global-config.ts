import { randomUUID } from "node:crypto";
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { parseDocument, stringify } from "yaml";
import { getAgentDir } from "../config.ts";
import type { ExtensionAPI, ExtensionContext } from "../core/extensions/types.ts";
import { DEFAULT_SAFETY_MODE, isSafetyMode, type SafetyMode } from "../core/safety-mode.ts";
import {
	CLI_SECTION_KEYS,
	LEGACY_CONFIG_VERSION,
	MAX_UNIFIED_CONFIG_BYTES,
	SHARED_SECTION_KEYS,
	UNIFIED_CONFIG_FILENAME,
	UNIFIED_CONFIG_VERSION,
	applySettingsToUnifiedSource,
	liftUnifiedSource,
	lockUnifiedConfigSync,
	serializeUnifiedConfig,
	settingsViewFromUnifiedSource,
	writeUnifiedSourceSync,
} from "../core/unified-config.ts";

export const GLOBAL_CONFIG_VERSION = UNIFIED_CONFIG_VERSION;
export const GLOBAL_CONFIG_FILENAME = UNIFIED_CONFIG_FILENAME;
const MAX_GLOBAL_CONFIG_BYTES = MAX_UNIFIED_CONFIG_BYTES;

export interface HistoryConfig {
	readonly autoArchive: boolean;
	readonly shortTestMaxWords: number;
	readonly maxActive: number;
	readonly maxArchived: number;
}

export interface SubagentsConfig {
	readonly advisorModel: "inherit" | string;
	/** Thinking level for advisor/review children; "inherit" follows the parent. */
	readonly advisorThinkingLevel: "inherit" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	readonly requireAdvisor: boolean;
	readonly requireReviewer: boolean;
}

export interface TrackingConfig {
	readonly maxSessionCheckpoints: number;
	readonly maxDetachedCheckpoints: number;
	readonly warningFiles: number;
	readonly warningBytes: number;
}

export type GuiThemePreset = "default" | "catppuccin" | "tokyo-night" | "nord" | "dracula" | "gruvbox" | "github" | "vscode";

export interface GuiRemoteHostConfig {
	readonly id: string;
	readonly label: string;
	readonly sshTarget: string;
	readonly remoteSocket: string;
	readonly color: string;
	readonly addedAt: string;
	readonly projects: readonly string[];
}

export interface GuiConfig {
	readonly appMode: "work" | "chat";
	/** Decorative launch identity: "rotate" picks per launch; any other slug
	 * pins one entry of the GUI-owned catalog (the daemon stores the slug
	 * opaquely so new decorations never require a daemon release). */
	readonly favouritePi: string;
	readonly theme: { readonly mode: "dark" | "light"; readonly preset: GuiThemePreset };
	readonly layout: { readonly railWidth: number; readonly workbenchWidth: number };
	readonly shortcuts: {
		readonly home: string;
		readonly newSession: string;
		readonly commandPalette: string;
		readonly globalSearch: string;
		readonly threadSearch: string;
		readonly terminal: string;
		readonly sidebar: string;
		readonly openFolder: string;
		readonly settings: string;
		readonly zoomIn: string;
		readonly zoomOut: string;
		readonly zoomReset: string;
		readonly stopRun: string;
	};
	readonly remoteHosts: readonly GuiRemoteHostConfig[];
}

export type ServiceTier = "default" | "priority";

export type DefaultThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface SafetyDefaultsConfig {
	/** Host-global default safety mode; captured only by newly created sessions. */
	readonly defaultMode: SafetyMode;
}

export interface ThinkingDefaultsConfig {
	/** Level newly created sessions start with (clamped per model at use). */
	readonly defaultLevel: DefaultThinkingLevel;
}

export interface GlobalConfig {
	readonly version: 2;
	/** Persistent provider/model selected by `/model --global`; null uses runtime resolution. */
	readonly defaultModel: string | null;
	/** Provider-neutral request tier. Unsupported models ignore `priority`. */
	readonly serviceTier: ServiceTier;
	/** When true, model requests advertise the app's honest identity
	 *  (`pizzeria/<version>`) instead of any compatibility user-agent. */
	readonly honestUserAgent: boolean;
	/** FEAT-087 tool projection: "compatible" advertises flat schemas AND
	 *  exec_code; "code" advertises only exec_code (+ communication tools);
	 *  "flat" disables code mode. Applied at session creation — a daemon
	 *  restart makes a change effective. */
	readonly tools: ToolsProjectionConfig;
	readonly safety: SafetyDefaultsConfig;
	readonly thinking: ThinkingDefaultsConfig;
	readonly history: HistoryConfig;
	readonly subagents: SubagentsConfig;
	readonly tracking: TrackingConfig;
	readonly gui: GuiConfig;
	/** Raw `mcp` section (stored under `shared.mcp` on disk); validated
	 *  separately by the core MCP config parser. */
	readonly mcp?: unknown;
}

export type ToolsProjectionMode = "flat" | "code" | "compatible";
export interface ToolsProjectionConfig {
	readonly mode: ToolsProjectionMode;
}

export interface GlobalConfigDiagnostic {
	readonly code: "malformed" | "unsupported-version" | "unsafe-file";
	readonly message: string;
	readonly path: string;
}

export interface GlobalConfigLoadResult {
	readonly config: GlobalConfig;
	readonly diagnostic?: GlobalConfigDiagnostic;
	/** Distinguishes an explicit null from a pre-migration file with no key. */
	readonly defaultModelConfigured: boolean;
}

export const DEFAULT_GLOBAL_CONFIG: GlobalConfig = Object.freeze({
	version: GLOBAL_CONFIG_VERSION,
	defaultModel: null,
	serviceTier: "default",
	honestUserAgent: false,
	tools: Object.freeze({ mode: "compatible" as const }),
	safety: Object.freeze({ defaultMode: DEFAULT_SAFETY_MODE }),
	thinking: Object.freeze({ defaultLevel: "medium" as const }),
	history: Object.freeze({
		autoArchive: true,
		shortTestMaxWords: 10,
		maxActive: 10,
		maxArchived: 10,
	}),
	subagents: Object.freeze({ advisorModel: "inherit", advisorThinkingLevel: "inherit" as const, requireAdvisor: false, requireReviewer: false }),
	tracking: Object.freeze({
		maxSessionCheckpoints: 3,
		maxDetachedCheckpoints: 1,
		warningFiles: 10_000,
		warningBytes: 1024 * 1024 * 1024,
	}),
	gui: Object.freeze({
		appMode: "work",
		favouritePi: "rotate",
		theme: Object.freeze({ mode: "dark", preset: "default" }),
		layout: Object.freeze({ railWidth: 256, workbenchWidth: 576 }),
		shortcuts: Object.freeze({
			home: "CmdOrCtrl+Shift+H",
			newSession: "CmdOrCtrl+N",
			commandPalette: "CmdOrCtrl+Shift+P",
			globalSearch: "CmdOrCtrl+Shift+F",
			threadSearch: "CmdOrCtrl+F",
			terminal: "CmdOrCtrl+J",
			sidebar: "CmdOrCtrl+B",
			openFolder: "CmdOrCtrl+O",
			settings: "CmdOrCtrl+Comma",
			zoomIn: "CmdOrCtrl+=",
			zoomOut: "CmdOrCtrl+-",
			zoomReset: "CmdOrCtrl+0",
			stopRun: "Escape",
		}),
		remoteHosts: Object.freeze([]),
	}),
});

type ConfigRecord = Record<string, unknown>;
type HistoryKey = "autoArchive" | "shortTestMaxWords" | "maxActive" | "maxArchived";
export type GlobalConfigField =
	| "defaultModel"
	| "serviceTier"
	| "honestUserAgent"
	| "tools.mode"
	| "safety.defaultMode"
	| "thinking.defaultLevel"
	| `history.${HistoryKey}`
	| "subagents.advisorModel"
	| "subagents.advisorThinkingLevel"
	| "subagents.requireAdvisor"
	| "subagents.requireReviewer"
	| "tracking.maxSessionCheckpoints"
	| "tracking.maxDetachedCheckpoints"
	| "tracking.warningFiles"
	| "tracking.warningBytes"
	| "gui.appMode"
	| "gui.favouritePi"
	| "gui.theme.mode"
	| "gui.theme.preset"
	| "gui.layout.railWidth"
	| "gui.layout.workbenchWidth"
	| "gui.shortcuts.home"
	| "gui.shortcuts.newSession"
	| "gui.shortcuts.commandPalette"
	| "gui.shortcuts.globalSearch"
	| "gui.shortcuts.threadSearch"
	| "gui.shortcuts.terminal"
	| "gui.shortcuts.sidebar"
	| "gui.shortcuts.openFolder"
	| "gui.shortcuts.settings"
	| "gui.shortcuts.zoomIn"
	| "gui.shortcuts.zoomOut"
	| "gui.shortcuts.zoomReset"
	| "gui.shortcuts.stopRun"
	| "gui.remoteHosts";

export interface SanitizedGlobalConfig extends Omit<GlobalConfig, "mcp"> {
	readonly mcpServerIds: readonly string[];
}
const GLOBAL_CONFIG_FIELDS = new Set<GlobalConfigField>([
	"defaultModel", "serviceTier", "honestUserAgent", "tools.mode", "safety.defaultMode", "thinking.defaultLevel",
	"history.autoArchive", "history.shortTestMaxWords", "history.maxActive", "history.maxArchived",
	"subagents.advisorModel", "subagents.advisorThinkingLevel", "subagents.requireAdvisor", "subagents.requireReviewer",
	"tracking.maxSessionCheckpoints", "tracking.maxDetachedCheckpoints", "tracking.warningFiles", "tracking.warningBytes",
	"gui.appMode", "gui.favouritePi", "gui.theme.mode", "gui.theme.preset", "gui.layout.railWidth", "gui.layout.workbenchWidth",
	"gui.shortcuts.home", "gui.shortcuts.newSession",
	"gui.shortcuts.commandPalette", "gui.shortcuts.globalSearch", "gui.shortcuts.threadSearch",
	"gui.shortcuts.terminal", "gui.shortcuts.sidebar", "gui.shortcuts.openFolder", "gui.shortcuts.settings",
	"gui.shortcuts.zoomIn", "gui.shortcuts.zoomOut", "gui.shortcuts.zoomReset", "gui.shortcuts.stopRun",
	"gui.remoteHosts",
]);
let pendingServiceTierUpdate: Promise<GlobalConfig> | undefined;
let configMutationQueue: Promise<unknown> = Promise.resolve();

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
Use /advisor [on|off] and /reviewer [on|off] to change mandatory consultation
guidance for the current session and the default for new sessions.

Configuration is stored in $MYPI_AGENT_DIR/config.yaml. The default model is
changed by /model --global. Changes are global to
that MyPi profile. The service tier applies at the next turn boundary; history
changes affect the next new-session maintenance pass. Malformed or
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
		if (isErrorCode(error, "ENOENT")) return { config: cloneDefaults(), defaultModelConfigured: false };
		return invalidResult("unsafe-file", `MyPi could not safely read global configuration at ${path}.`, path);
	}

	const parsed = parseConfigRecord(raw, path);
	if ("diagnostic" in parsed) return { config: cloneDefaults(), diagnostic: parsed.diagnostic, defaultModelConfigured: false };
	const shared = isRecord(parsed.source.shared) ? parsed.source.shared : {};
	return { config: parsed.config, defaultModelConfigured: Object.hasOwn(shared, "defaultModel") };
}

export async function updateDefaultModel(
	defaultModel: string | null,
	path = resolveGlobalConfigPath(),
): Promise<GlobalConfig> {
	if (defaultModel !== null && !isConfiguredModel(defaultModel)) {
		throw new Error("Default model must be null or provider/model.");
	}
	return withConfigLock(path, async () => {
		const source = await readConfigSourceForMutation(path);
		const next = withShared(source, (shared) => { shared.defaultModel = defaultModel; });
		const parsed = parseConfigRecord(stringify(next), path);
		if ("diagnostic" in parsed) throw new Error(parsed.diagnostic.message);
		await atomicWriteConfig(path, serializeUnifiedConfig(next));
		return parsed.config;
	});
}

/**
 * Resolve the config-owned default and migrate the legacy settings.json pair
 * exactly once when an older config has no `defaultModel` key. An explicit
 * null is authoritative and malformed/unsafe config is never overwritten.
 */
export async function resolveConfiguredDefaultModel(options: {
	path?: string;
	legacyProvider?: string;
	legacyModelId?: string;
} = {}): Promise<string | null> {
	const path = options.path ?? resolveGlobalConfigPath();
	const loaded = await loadGlobalConfig(path);
	if (loaded.diagnostic || loaded.defaultModelConfigured) return loaded.config.defaultModel;
	const legacy = options.legacyProvider && options.legacyModelId
		? `${options.legacyProvider}/${options.legacyModelId}`
		: null;
	if (!legacy || !isConfiguredModel(legacy)) return null;
	return withConfigLock(path, async () => {
		let source: ConfigRecord;
		try {
			const info = await lstat(path);
			if (info.isSymbolicLink() || !info.isFile()) return null;
			if (info.size > MAX_GLOBAL_CONFIG_BYTES) return null;
			const parsed = parseConfigRecord(await readFile(path, "utf8"), path);
			if ("diagnostic" in parsed) return null;
			const shared = isRecord(parsed.source.shared) ? parsed.source.shared : {};
			if (Object.hasOwn(shared, "defaultModel")) return parsed.config.defaultModel;
			source = parsed.source;
		} catch (error) {
			if (!isErrorCode(error, "ENOENT")) return null;
			source = { version: GLOBAL_CONFIG_VERSION };
		}
		const next = withShared(source, (shared) => { shared.defaultModel = legacy; });
		await atomicWriteConfig(path, serializeUnifiedConfig(next));
		return legacy;
	});
}

export function splitConfiguredDefaultModel(value: string | null | undefined): {
	provider: string;
	modelId: string;
} | undefined {
	if (!value || !isConfiguredModel(value)) return undefined;
	const slash = value.indexOf("/");
	return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

export async function updateHistoryConfig(
	key: HistoryKey,
	value: boolean | number,
	path = resolveGlobalConfigPath(),
): Promise<GlobalConfig> {
	return withConfigLock(path, async () => {
		const source = await readConfigSourceForMutation(path);
		const next = withShared(source, (shared) => {
			const history = isRecord(shared.history) ? { ...shared.history } : {};
			history[key] = value;
			shared.history = history;
		});
		const parsed = parseConfigRecord(stringify(next), path);
		if ("diagnostic" in parsed) throw new Error(parsed.diagnostic.message);
		await atomicWriteConfig(path, serializeUnifiedConfig(next));
		return parsed.config;
	});
}

export async function updateServiceTier(
	serviceTier: ServiceTier,
	path = resolveGlobalConfigPath(),
): Promise<GlobalConfig> {
	if (serviceTier !== "default" && serviceTier !== "priority") throw new Error("Service tier must be default or priority.");
	const update = withConfigLock(path, async () => {
		const source = await readConfigSourceForMutation(path);
		const next = withShared(source, (shared) => { shared.serviceTier = serviceTier; });
		const parsed = parseConfigRecord(stringify(next), path);
		if ("diagnostic" in parsed) throw new Error(parsed.diagnostic.message);
		await atomicWriteConfig(path, serializeUnifiedConfig(next));
		return parsed.config;
	});
	pendingServiceTierUpdate = update;
	try {
		return await update;
	} finally {
		if (pendingServiceTierUpdate === update) pendingServiceTierUpdate = undefined;
	}
}

export async function loadConfiguredServiceTier(path = resolveGlobalConfigPath()): Promise<ServiceTier> {
	await pendingServiceTierUpdate?.catch(() => undefined);
	return (await loadGlobalConfig(path)).config.serviceTier;
}

// Short TTL cache so per-request header transforms honor a live toggle without
// reading config.yaml on every model call.
const honestUaCache = new Map<string, { value: boolean; readAt: number }>();
const HONEST_UA_TTL_MS = 5_000;

/** Whether model requests should advertise the honest `pizzeria/<version>`
 *  identity. Cached briefly; a GUI toggle takes effect within a few seconds
 *  on already-running engines. */
export async function loadConfiguredHonestUserAgent(path = resolveGlobalConfigPath()): Promise<boolean> {
	const cached = honestUaCache.get(path);
	const now = Date.now();
	if (cached && now - cached.readAt < HONEST_UA_TTL_MS) return cached.value;
	const value = (await loadGlobalConfig(path)).config.honestUserAgent;
	honestUaCache.set(path, { value, readAt: now });
	return value;
}

export async function updateAdvisorModel(
	advisorModel: "inherit" | string,
	path = resolveGlobalConfigPath(),
): Promise<GlobalConfig> {
	if (!isAdvisorModel(advisorModel)) throw new Error("Advisor model must be inherit or provider/model.");
	return withConfigLock(path, async () => {
		const source = await readConfigSourceForMutation(path);
		const next = withShared(source, (shared) => {
			const subagents = isRecord(shared.subagents) ? { ...shared.subagents } : {};
			subagents.advisorModel = advisorModel;
			shared.subagents = subagents;
		});
		const parsed = parseConfigRecord(stringify(next), path);
		if ("diagnostic" in parsed) throw new Error(parsed.diagnostic.message);
		await atomicWriteConfig(path, serializeUnifiedConfig(next));
		return parsed.config;
	});
}

export async function updateSubagentRequirement(
	key: "requireAdvisor" | "requireReviewer",
	value: boolean,
	path = resolveGlobalConfigPath(),
): Promise<GlobalConfig> {
	return withConfigLock(path, async () => {
		const source = await readConfigSourceForMutation(path);
		const next = withShared(source, (shared) => {
			const subagents = isRecord(shared.subagents) ? { ...shared.subagents } : {};
			subagents[key] = value;
			shared.subagents = subagents;
		});
		const parsed = parseConfigRecord(stringify(next), path);
		if ("diagnostic" in parsed) throw new Error(parsed.diagnostic.message);
		await atomicWriteConfig(path, serializeUnifiedConfig(next));
		return parsed.config;
	});
}

export function sanitizeGlobalConfig(config: GlobalConfig): SanitizedGlobalConfig {
	const mcp = isRecord(config.mcp) ? config.mcp : {};
	const servers = isRecord(mcp.servers) ? Object.keys(mcp.servers).filter(safeShortText).sort() : [];
	const { mcp: _mcp, ...safe } = config;
	return { ...safe, mcpServerIds: servers };
}

export async function updateGlobalConfigField(
	field: GlobalConfigField,
	value: unknown,
	path = resolveGlobalConfigPath(),
): Promise<GlobalConfig> {
	if (!GLOBAL_CONFIG_FIELDS.has(field)) throw new Error(`Unsupported global configuration field: ${String(field)}`);
	return withConfigLock(path, async () => {
		const source = await readConfigSourceForMutation(path);
		const next = applyConfigField(source, field, value);
		const parsed = parseConfigRecord(stringify(next), path);
		if ("diagnostic" in parsed) throw new Error(parsed.diagnostic.message);
		await atomicWriteConfig(path, serializeUnifiedConfig(next));
		return parsed.config;
	});
}

/** Import legacy GUI preferences only where config.yaml has no corresponding
 * value. Existing shared config always wins. */
export async function migrateGuiConfig(
	candidate: Partial<GuiConfig>,
	path = resolveGlobalConfigPath(),
): Promise<GlobalConfig> {
	return withConfigLock(path, async () => {
		const source = await readConfigSourceForMutation(path);
		const gui = isRecord(source.gui) ? { ...source.gui } : {};
		if (gui.appMode === undefined) gui.appMode = candidate.appMode ?? DEFAULT_GLOBAL_CONFIG.gui.appMode;
		for (const section of ["theme", "layout", "shortcuts"] as const) {
			const offered = { ...DEFAULT_GLOBAL_CONFIG.gui[section], ...(candidate[section] ?? {}) };
			const current = isRecord(gui[section]) ? { ...gui[section] } : {};
			for (const [key, offeredValue] of Object.entries(offered)) {
				if (current[key] === undefined) current[key] = offeredValue;
			}
			gui[section] = current;
		}
		if (gui.remoteHosts === undefined && candidate.remoteHosts !== undefined) gui.remoteHosts = candidate.remoteHosts;
		const next = { ...source, version: GLOBAL_CONFIG_VERSION, gui };
		const parsed = parseConfigRecord(stringify(next), path);
		if ("diagnostic" in parsed) throw new Error(parsed.diagnostic.message);
		await atomicWriteConfig(path, serializeUnifiedConfig(next));
		return parsed.config;
	});
}

/**
 * Atomically create, replace, or remove one `mcp.servers` record while
 * preserving every unrelated configuration byte. `record === undefined`
 * removes the server. Validation is the caller's responsibility (the core
 * MCP parser); this helper only owns safe persistence.
 */
export async function updateMcpServer(
	serverId: string,
	record: Record<string, unknown> | undefined,
	path = resolveGlobalConfigPath(),
): Promise<GlobalConfig> {
	return withConfigLock(path, async () => {
		const source = await readConfigSourceForMutation(path);
		const next = withShared(source, (shared) => {
			const mcp = isRecord(shared.mcp) ? { ...shared.mcp } : {};
			const servers = isRecord(mcp.servers) ? { ...mcp.servers } : {};
			if (record === undefined) delete servers[serverId];
			else servers[serverId] = record;
			mcp.servers = servers;
			shared.mcp = mcp;
			if (record === undefined && Object.keys(servers).length === 0) {
				delete shared.mcp;
			}
		});
		const parsed = parseConfigRecord(stringify(next), path);
		if ("diagnostic" in parsed) throw new Error(parsed.diagnostic.message);
		await atomicWriteConfig(path, serializeUnifiedConfig(next));
		return parsed.config;
	});
}

export async function resetGlobalConfig(path = resolveGlobalConfigPath()): Promise<GlobalConfig> {
	return withConfigLock(path, async () => {
		await assertResetTargetSafe(path);
		const next = cloneDefaults();
		await atomicWriteConfig(path, serializeUnifiedConfig(sourceFromConfig(next)));
		return next;
	});
}

export interface UnifiedMigrationResult {
	readonly migrated: boolean;
	readonly diagnostic?: GlobalConfigDiagnostic;
}

/**
 * One-shot migration to the unified (version 2) configuration layout: lifts a
 * version-1 config.yaml into shared/cli/gui sections and absorbs user
 * preference keys from settings.json, which keeps only machine state and
 * resource lists. Existing config.yaml values win conflicts. Malformed or
 * unsafe files are never touched (originals are backed up under
 * backups/unified-config/ before any rewrite). Sync so both CLI startup
 * (runMigrations) and the daemon can run it before their first read.
 */
export function migrateUnifiedGlobalConfig(agentDir: string = getAgentDir()): UnifiedMigrationResult {
	const path = join(agentDir, GLOBAL_CONFIG_FILENAME);
	const settingsPath = join(agentDir, "settings.json");
	const preview = planUnifiedMigration(path, settingsPath);
	if ("diagnostic" in preview) return { migrated: false, diagnostic: preview.diagnostic };
	if (!preview.needsWrite) return { migrated: false };
	const release = lockUnifiedConfigSync(path);
	try {
		const plan = planUnifiedMigration(path, settingsPath);
		if ("diagnostic" in plan) return { migrated: false, diagnostic: plan.diagnostic };
		if (!plan.needsWrite) return { migrated: false };
		const backupRoot = join(agentDir, "backups", "unified-config");
		mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
		const stamp = new Date().toISOString().replaceAll(":", "-");
		if (plan.backupConfig) copyFileSync(path, join(backupRoot, `config-${stamp}.yaml`));
		if (plan.settingsRest !== undefined) copyFileSync(settingsPath, join(backupRoot, `settings-${stamp}.json`));
		writeUnifiedSourceSync(path, plan.source);
		if (plan.settingsRest !== undefined) {
			writeFileSync(settingsPath, `${JSON.stringify(plan.settingsRest, null, 2)}\n`, "utf8");
		}
		return { migrated: true };
	} finally {
		release();
	}
}

function planUnifiedMigration(
	path: string,
	settingsPath: string,
):
	| { readonly diagnostic: GlobalConfigDiagnostic }
	| { readonly needsWrite: boolean; readonly source: ConfigRecord; readonly backupConfig: boolean; readonly settingsRest?: ConfigRecord } {
	let raw: string | undefined;
	if (existsSync(path)) {
		const info = lstatSync(path);
		if (info.isSymbolicLink() || !info.isFile()) {
			return { diagnostic: diagnostic("unsafe-file", `MyPi global configuration is not a regular non-symlink file: ${path}`, path) };
		}
		if (info.size > MAX_GLOBAL_CONFIG_BYTES) {
			return { diagnostic: diagnostic("malformed", `MyPi global configuration exceeds ${MAX_GLOBAL_CONFIG_BYTES} bytes: ${path}`, path) };
		}
		raw = readFileSync(path, "utf8");
	}
	let source: ConfigRecord = { version: GLOBAL_CONFIG_VERSION };
	let backupConfig = false;
	if (raw !== undefined && raw.trim().length > 0) {
		const parsed = parseConfigRecord(raw, path);
		if ("diagnostic" in parsed) return { diagnostic: parsed.diagnostic };
		source = parsed.source;
		backupConfig = parsed.sourceVersion !== UNIFIED_CONFIG_VERSION;
	}
	let settingsRest: ConfigRecord | undefined;
	let mergedSource = source;
	if (existsSync(settingsPath)) {
		try {
			const info = lstatSync(settingsPath);
			if (info.isFile() && !info.isSymbolicLink()) {
				const settings: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
				if (isRecord(settings)) {
					const prefs: ConfigRecord = {};
					const rest: ConfigRecord = {};
					for (const [key, value] of Object.entries(settings)) {
						if (CLI_SECTION_KEYS.has(key) || SHARED_SECTION_KEYS.has(key) || key === "defaultThinkingLevel") prefs[key] = value;
						else rest[key] = value;
					}
					if (Object.keys(prefs).length > 0) {
						if (isRecord(prefs.tools) && (prefs.tools as ConfigRecord).mode === "code-only") {
							prefs.tools = { ...(prefs.tools as ConfigRecord), mode: "code" };
						}
						const current = settingsViewFromUnifiedSource(source);
						const merged = fillAbsentSettings(prefs, current);
						const candidate = applySettingsToUnifiedSource(source, merged).source;
						// Absorb only if the merged result still validates; otherwise
						// leave settings.json alone rather than poison the authority.
						const check = parseConfigRecord(stringify(candidate), path);
						if (!("diagnostic" in check)) {
							mergedSource = candidate;
							settingsRest = rest;
						}
					}
				}
			}
		} catch {
			// Malformed settings.json: skip absorption; still lift the yaml.
		}
	}
	return {
		needsWrite: backupConfig || settingsRest !== undefined,
		source: mergedSource,
		backupConfig,
		settingsRest,
	};
}

/** `winner` (existing unified values) beats `base` (settings.json imports);
 *  nested records merge one level, mirroring SettingsManager's semantics. */
function fillAbsentSettings(base: ConfigRecord, winner: ConfigRecord): ConfigRecord {
	const result: ConfigRecord = { ...base };
	for (const [key, value] of Object.entries(winner)) {
		const baseValue = result[key];
		result[key] = isRecord(value) && isRecord(baseValue) ? { ...baseValue, ...value } : value;
	}
	return result;
}

export default function globalConfigExtension(pi: ExtensionAPI): void {
	let warned = false;
	const show = async (ctx: ExtensionContext) => {
		const loaded = await loadGlobalConfig();
		if (loaded.diagnostic) ctx.ui.notify(loaded.diagnostic.message, "warning");
		ctx.ui.notify(`${formatDefaultModel(loaded.config.defaultModel)} ${formatServiceTier(loaded.config.serviceTier)} ${formatHistoryConfig(loaded.config.history)} ${formatSubagentsConfig(loaded.config.subagents)}`, "info");
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
): { readonly config: GlobalConfig; readonly source: ConfigRecord; readonly sourceVersion: number } | { readonly diagnostic: GlobalConfigDiagnostic } {
	try {
		const document = parseDocument(raw, { uniqueKeys: true });
		if (document.errors.length > 0) {
			return { diagnostic: diagnostic("malformed", `MyPi global configuration is malformed; defaults are active. Repair ${path} or run /config reset --confirm.`, path) };
		}
		const parsedSource = document.toJS({ maxAliasCount: 0 });
		if (!isRecord(parsedSource)) return { diagnostic: diagnostic("malformed", `MyPi global configuration must be a YAML mapping; defaults are active. Repair ${path} or run /config reset --confirm.`, path) };
		if (parsedSource.version !== UNIFIED_CONFIG_VERSION && parsedSource.version !== LEGACY_CONFIG_VERSION) {
			return { diagnostic: diagnostic("unsupported-version", `MyPi global configuration version is unsupported; defaults are active. Repair ${path} or run /config reset --confirm.`, path) };
		}
		const sourceVersion = parsedSource.version;
		const source = liftUnifiedSource(parsedSource);
		const shared = source.shared === undefined ? {} : source.shared;
		if (!isRecord(shared)) return { diagnostic: invalidOwnedConfig(path) };
		if (source.cli !== undefined && !isRecord(source.cli)) return { diagnostic: invalidOwnedConfig(path) };
		const safety = shared.safety === undefined ? {} : shared.safety;
		if (!isRecord(safety)) return { diagnostic: invalidOwnedConfig(path) };
		const thinking = shared.thinking === undefined ? {} : shared.thinking;
		if (!isRecord(thinking)) return { diagnostic: invalidOwnedConfig(path) };
		const history = shared.history === undefined ? {} : shared.history;
		if (!isRecord(history)) return { diagnostic: invalidOwnedConfig(path) };
		const subagents = shared.subagents === undefined ? {} : shared.subagents;
		if (!isRecord(subagents)) return { diagnostic: invalidOwnedConfig(path) };
		const tracking = shared.tracking === undefined ? {} : shared.tracking;
		if (!isRecord(tracking)) return { diagnostic: invalidOwnedConfig(path) };
		const gui = source.gui === undefined ? {} : source.gui;
		if (!isRecord(gui)) return { diagnostic: invalidOwnedConfig(path) };
		const guiTheme = gui.theme === undefined ? {} : gui.theme;
		const guiLayout = gui.layout === undefined ? {} : gui.layout;
		const guiShortcuts = gui.shortcuts === undefined ? {} : gui.shortcuts;
		if (!isRecord(guiTheme) || !isRecord(guiLayout) || !isRecord(guiShortcuts)) {
			return { diagnostic: invalidOwnedConfig(path) };
		}
		const remoteHosts = parseGuiRemoteHosts(gui.remoteHosts, DEFAULT_GLOBAL_CONFIG.gui.remoteHosts);
		const config: GlobalConfig = {
			version: GLOBAL_CONFIG_VERSION,
			defaultModel: shared.defaultModel === null || typeof shared.defaultModel === "string"
				? shared.defaultModel
				: DEFAULT_GLOBAL_CONFIG.defaultModel,
			serviceTier: shared.serviceTier === "priority" ? "priority" : DEFAULT_GLOBAL_CONFIG.serviceTier,
			honestUserAgent: readBoolean(shared.honestUserAgent, DEFAULT_GLOBAL_CONFIG.honestUserAgent),
			tools: { mode: readToolsProjectionMode(isRecord(shared.tools) ? (shared.tools as ConfigRecord).mode : undefined) },
			safety: { defaultMode: isSafetyMode(safety.defaultMode) ? safety.defaultMode : DEFAULT_GLOBAL_CONFIG.safety.defaultMode },
			thinking: { defaultLevel: isDefaultThinkingLevel(thinking.defaultLevel) ? thinking.defaultLevel : DEFAULT_GLOBAL_CONFIG.thinking.defaultLevel },
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
				advisorThinkingLevel: isAdvisorThinkingLevel(subagents.advisorThinkingLevel)
					? subagents.advisorThinkingLevel
					: DEFAULT_GLOBAL_CONFIG.subagents.advisorThinkingLevel,
				requireAdvisor: readBoolean(subagents.requireAdvisor, DEFAULT_GLOBAL_CONFIG.subagents.requireAdvisor),
				requireReviewer: readBoolean(subagents.requireReviewer, DEFAULT_GLOBAL_CONFIG.subagents.requireReviewer),
			},
			tracking: {
				maxSessionCheckpoints: readBoundedInteger(tracking.maxSessionCheckpoints, 1, 20, DEFAULT_GLOBAL_CONFIG.tracking.maxSessionCheckpoints),
				maxDetachedCheckpoints: readBoundedInteger(tracking.maxDetachedCheckpoints, 1, 20, DEFAULT_GLOBAL_CONFIG.tracking.maxDetachedCheckpoints),
				warningFiles: readBoundedInteger(tracking.warningFiles, 1, 1_000_000, DEFAULT_GLOBAL_CONFIG.tracking.warningFiles),
				warningBytes: readBoundedInteger(tracking.warningBytes, 1, Number.MAX_SAFE_INTEGER, DEFAULT_GLOBAL_CONFIG.tracking.warningBytes),
			},
			gui: {
				appMode: gui.appMode === "chat" ? "chat" : DEFAULT_GLOBAL_CONFIG.gui.appMode,
				favouritePi: isPiIdentitySlug(gui.favouritePi) ? gui.favouritePi : DEFAULT_GLOBAL_CONFIG.gui.favouritePi,
				theme: {
					mode: guiTheme.mode === "light" ? "light" : DEFAULT_GLOBAL_CONFIG.gui.theme.mode,
					preset: isGuiThemePreset(guiTheme.preset) ? guiTheme.preset : DEFAULT_GLOBAL_CONFIG.gui.theme.preset,
				},
				layout: {
					railWidth: readBoundedInteger(guiLayout.railWidth, 200, 440, DEFAULT_GLOBAL_CONFIG.gui.layout.railWidth),
					workbenchWidth: readBoundedInteger(guiLayout.workbenchWidth, 320, 800, DEFAULT_GLOBAL_CONFIG.gui.layout.workbenchWidth),
				},
				shortcuts: Object.fromEntries(Object.entries(DEFAULT_GLOBAL_CONFIG.gui.shortcuts).map(([key, fallback]) => [
					key,
					isShortcutChord(guiShortcuts[key]) ? guiShortcuts[key] : fallback,
				])) as unknown as GuiConfig["shortcuts"],
				remoteHosts,
			},
			...(shared.mcp !== undefined ? { mcp: shared.mcp } : {}),
		};
		if (
			(shared.defaultModel !== undefined && shared.defaultModel !== null && !isConfiguredModel(shared.defaultModel)) ||
			(shared.serviceTier !== undefined && shared.serviceTier !== "default" && shared.serviceTier !== "priority") ||
			(shared.honestUserAgent !== undefined && typeof shared.honestUserAgent !== "boolean") ||
			(isRecord(shared.tools) && (shared.tools as ConfigRecord).mode !== undefined && !isToolsProjectionMode((shared.tools as ConfigRecord).mode)) ||
			(safety.defaultMode !== undefined && !isSafetyMode(safety.defaultMode)) ||
			(thinking.defaultLevel !== undefined && !isDefaultThinkingLevel(thinking.defaultLevel)) ||
			(history.autoArchive !== undefined && typeof history.autoArchive !== "boolean") ||
			!validOptionalInteger(history.shortTestMaxWords, 1, 100) ||
			!validOptionalInteger(history.maxActive, 1, 1_000) ||
			!validOptionalInteger(history.maxArchived, 1, 1_000)
			|| (subagents.advisorModel !== undefined && !isAdvisorModel(subagents.advisorModel))
			|| (subagents.advisorThinkingLevel !== undefined && !isAdvisorThinkingLevel(subagents.advisorThinkingLevel))
			|| (subagents.requireAdvisor !== undefined && typeof subagents.requireAdvisor !== "boolean")
			|| (subagents.requireReviewer !== undefined && typeof subagents.requireReviewer !== "boolean")
			|| !validOptionalInteger(tracking.maxSessionCheckpoints, 1, 20)
			|| !validOptionalInteger(tracking.maxDetachedCheckpoints, 1, 20)
			|| !validOptionalInteger(tracking.warningFiles, 1, 1_000_000)
			|| !validOptionalInteger(tracking.warningBytes, 1, Number.MAX_SAFE_INTEGER)
			|| (
				tracking.maxSessionCheckpoints !== undefined &&
				tracking.maxDetachedCheckpoints !== undefined &&
				(tracking.maxDetachedCheckpoints as number) > (tracking.maxSessionCheckpoints as number)
			)
			|| config.tracking.maxDetachedCheckpoints > config.tracking.maxSessionCheckpoints
			|| (gui.appMode !== undefined && gui.appMode !== "work" && gui.appMode !== "chat")
			|| (gui.favouritePi !== undefined && !isPiIdentitySlug(gui.favouritePi))
			|| (guiTheme.mode !== undefined && guiTheme.mode !== "dark" && guiTheme.mode !== "light")
			|| (guiTheme.preset !== undefined && !isGuiThemePreset(guiTheme.preset))
			|| !validOptionalInteger(guiLayout.railWidth, 200, 440)
			|| !validOptionalInteger(guiLayout.workbenchWidth, 320, 800)
			|| Object.keys(DEFAULT_GLOBAL_CONFIG.gui.shortcuts).some((key) => guiShortcuts[key] !== undefined && !isShortcutChord(guiShortcuts[key]))
			|| (gui.remoteHosts !== undefined && !validGuiRemoteHosts(gui.remoteHosts))
		) return { diagnostic: invalidOwnedConfig(path) };
		return { config, source, sourceVersion };
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
		if (isErrorCode(error, "ENOENT")) return { version: GLOBAL_CONFIG_VERSION };
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

function withConfigLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
	const update = configMutationQueue.then(async () => {
		const parent = dirname(path);
		await mkdir(parent, { recursive: true, mode: 0o700 });
		let release: (() => Promise<void>) | undefined;
		try {
			release = await lockfile.lock(path, {
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
	});
	configMutationQueue = update.then(() => undefined, () => undefined);
	return update;
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

function formatServiceTier(serviceTier: ServiceTier): string {
	return `Service tier: ${serviceTier}.`;
}

function formatDefaultModel(defaultModel: string | null): string {
	return `Default model: ${defaultModel ?? "automatic"}.`;
}

function formatSubagentsConfig(config: SubagentsConfig): string {
	return `Advisor/reviewer model: ${config.advisorModel}; mandatory advisor ${config.requireAdvisor ? "on" : "off"}; mandatory reviewer ${config.requireReviewer ? "on" : "off"}.`;
}

function cloneDefaults(): GlobalConfig {
	return {
		version: GLOBAL_CONFIG_VERSION,
		defaultModel: DEFAULT_GLOBAL_CONFIG.defaultModel,
		serviceTier: DEFAULT_GLOBAL_CONFIG.serviceTier,
		honestUserAgent: DEFAULT_GLOBAL_CONFIG.honestUserAgent,
		tools: { ...DEFAULT_GLOBAL_CONFIG.tools },
		safety: { ...DEFAULT_GLOBAL_CONFIG.safety },
		thinking: { ...DEFAULT_GLOBAL_CONFIG.thinking },
		history: { ...DEFAULT_GLOBAL_CONFIG.history },
		subagents: { ...DEFAULT_GLOBAL_CONFIG.subagents },
		tracking: { ...DEFAULT_GLOBAL_CONFIG.tracking },
		gui: {
			appMode: DEFAULT_GLOBAL_CONFIG.gui.appMode,
			favouritePi: DEFAULT_GLOBAL_CONFIG.gui.favouritePi,
			theme: { ...DEFAULT_GLOBAL_CONFIG.gui.theme },
			layout: { ...DEFAULT_GLOBAL_CONFIG.gui.layout },
			shortcuts: { ...DEFAULT_GLOBAL_CONFIG.gui.shortcuts },
			remoteHosts: [],
		},
	};
}

function invalidResult(code: GlobalConfigDiagnostic["code"], message: string, path: string): GlobalConfigLoadResult {
	return { config: cloneDefaults(), diagnostic: diagnostic(code, `${message} Complete defaults are active.`, path), defaultModelConfigured: false };
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

function isAdvisorThinkingLevel(value: unknown): value is SubagentsConfig["advisorThinkingLevel"] {
	return ["inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value as string);
}

function isToolsProjectionMode(value: unknown): value is ToolsProjectionMode {
	return value === "flat" || value === "code" || value === "compatible";
}

function isDefaultThinkingLevel(value: unknown): value is DefaultThinkingLevel {
	return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value as string);
}

function readToolsProjectionMode(value: unknown): ToolsProjectionMode {
	return isToolsProjectionMode(value) ? value : DEFAULT_GLOBAL_CONFIG.tools.mode;
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

function isConfiguredModel(value: unknown): value is string {
	return typeof value === "string"
		&& value.length >= 3
		&& value.length <= 512
		&& /^[^\s/]+\/.+$/u.test(value)
		&& !/[\r\n\0]/u.test(value);
}

/** Copy-on-write mutation of the v2 source's `shared` section. */
function withShared(source: ConfigRecord, mutate: (shared: ConfigRecord) => void): ConfigRecord {
	const shared = isRecord(source.shared) ? { ...(source.shared as ConfigRecord) } : {};
	mutate(shared);
	return { ...source, version: GLOBAL_CONFIG_VERSION, shared };
}

/** Disk (v2, namespaced) layout of an in-memory GlobalConfig. */
function sourceFromConfig(config: GlobalConfig): ConfigRecord {
	const { version, gui, mcp, ...sharedFields } = config;
	const shared: ConfigRecord = { ...sharedFields };
	if (mcp !== undefined) shared.mcp = mcp;
	return { version, shared, gui };
}

/** Client-facing field names stay flat (e.g. "safety.defaultMode",
 *  "history.maxActive", "gui.theme.mode"); this routes them to their
 *  namespaced location in the v2 source (gui.* → gui, the rest → shared). */
function applyConfigField(source: ConfigRecord, field: GlobalConfigField, value: unknown): ConfigRecord {
	if (field.startsWith("gui.")) {
		const next: ConfigRecord = { ...source, version: GLOBAL_CONFIG_VERSION };
		const gui = isRecord(next.gui) ? { ...(next.gui as ConfigRecord) } : {};
		const [, child, leaf] = field.split(".");
		if (leaf === undefined) gui[child!] = value;
		else {
			const childRecord = isRecord(gui[child!]) ? { ...(gui[child!] as ConfigRecord) } : {};
			childRecord[leaf] = value;
			gui[child!] = childRecord;
		}
		next.gui = gui;
		return next;
	}
	return withShared(source, (shared) => {
		if (field === "defaultModel" || field === "serviceTier" || field === "honestUserAgent") {
			shared[field] = value;
			return;
		}
		const [root, leaf] = field.split(".");
		const rootRecord = isRecord(shared[root!]) ? { ...(shared[root!] as ConfigRecord) } : {};
		rootRecord[leaf!] = value;
		shared[root!] = rootRecord;
	});
}

function isPiIdentitySlug(value: unknown): value is string {
	return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(value);
}

function isGuiThemePreset(value: unknown): value is GuiThemePreset {
	return ["default", "catppuccin", "tokyo-night", "nord", "dracula", "gruvbox", "github", "vscode"].includes(String(value));
}

function isShortcutChord(value: unknown): value is string {
	if (typeof value !== "string" || value.length < 3 || value.length > 128 || /[\r\n\0]/u.test(value)) return false;
	const parts = value.split("+");
	if (parts.some((part) => !part)) return false;
	if (parts.length === 1) return /^(Escape|F(?:[1-9]|1[0-2]))$/u.test(parts[0]!);
	const modifiers = new Set(["CmdOrCtrl", "Cmd", "Ctrl", "Alt", "Option", "Shift"]);
	return parts.slice(0, -1).every((part) => modifiers.has(part)) && parts.at(-1)!.length <= 32;
}

function safeShortText(value: unknown): value is string {
	return typeof value === "string" && value.length >= 1 && value.length <= 512 && !/[\r\n\0]/u.test(value);
}

function validGuiRemoteHosts(value: unknown): value is readonly GuiRemoteHostConfig[] {
	if (!Array.isArray(value) || value.length > 32) return false;
	const ids = new Set<string>();
	for (const host of value) {
		if (!isRecord(host) || !safeShortText(host.id) || ids.has(host.id)) return false;
		ids.add(host.id);
		if (
			!safeShortText(host.label) || !safeShortText(host.sshTarget) || !safeShortText(host.remoteSocket) ||
			!safeShortText(host.addedAt) || typeof host.color !== "string" || !/^#[0-9a-f]{6}$/iu.test(host.color) ||
			!Array.isArray(host.projects) || host.projects.length > 128 || host.projects.some((path) => !safeShortText(path))
		) return false;
	}
	return true;
}

function parseGuiRemoteHosts(value: unknown, fallback: readonly GuiRemoteHostConfig[]): readonly GuiRemoteHostConfig[] {
	if (value === undefined) return fallback.map((host) => ({ ...host, projects: [...host.projects] }));
	if (!validGuiRemoteHosts(value)) return fallback.map((host) => ({ ...host, projects: [...host.projects] }));
	return value.map((host) => ({ ...host, projects: [...host.projects] }));
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
