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
	readonly theme: { readonly mode: "dark" | "light"; readonly preset: GuiThemePreset };
	readonly layout: { readonly railWidth: number; readonly workbenchWidth: number };
	readonly shortcuts: {
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

export interface GlobalConfig {
	readonly version: 1;
	/** Persistent provider/model selected by `/model --global`; null uses runtime resolution. */
	readonly defaultModel: string | null;
	/** Provider-neutral request tier. Unsupported models ignore `priority`. */
	readonly serviceTier: ServiceTier;
	readonly history: HistoryConfig;
	readonly subagents: SubagentsConfig;
	readonly tracking: TrackingConfig;
	readonly gui: GuiConfig;
	/** Raw `mcp` section; validated separately by the core MCP config parser. */
	readonly mcp?: unknown;
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
	history: Object.freeze({
		autoArchive: true,
		shortTestMaxWords: 10,
		maxActive: 10,
		maxArchived: 10,
	}),
	subagents: Object.freeze({ advisorModel: "inherit", requireAdvisor: false, requireReviewer: false }),
	tracking: Object.freeze({
		maxSessionCheckpoints: 3,
		maxDetachedCheckpoints: 1,
		warningFiles: 10_000,
		warningBytes: 1024 * 1024 * 1024,
	}),
	gui: Object.freeze({
		appMode: "work",
		theme: Object.freeze({ mode: "dark", preset: "default" }),
		layout: Object.freeze({ railWidth: 256, workbenchWidth: 512 }),
		shortcuts: Object.freeze({
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
	| `history.${HistoryKey}`
	| "subagents.advisorModel"
	| "subagents.requireAdvisor"
	| "subagents.requireReviewer"
	| "tracking.maxSessionCheckpoints"
	| "tracking.maxDetachedCheckpoints"
	| "tracking.warningFiles"
	| "tracking.warningBytes"
	| "gui.appMode"
	| "gui.theme.mode"
	| "gui.theme.preset"
	| "gui.layout.railWidth"
	| "gui.layout.workbenchWidth"
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
	"defaultModel", "serviceTier",
	"history.autoArchive", "history.shortTestMaxWords", "history.maxActive", "history.maxArchived",
	"subagents.advisorModel", "subagents.requireAdvisor", "subagents.requireReviewer",
	"tracking.maxSessionCheckpoints", "tracking.maxDetachedCheckpoints", "tracking.warningFiles", "tracking.warningBytes",
	"gui.appMode", "gui.theme.mode", "gui.theme.preset", "gui.layout.railWidth", "gui.layout.workbenchWidth",
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
	return { config: parsed.config, defaultModelConfigured: Object.hasOwn(parsed.source, "defaultModel") };
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
		const next = { ...source, version: GLOBAL_CONFIG_VERSION, defaultModel };
		const parsed = parseConfigRecord(stringify(next), path);
		if ("diagnostic" in parsed) throw new Error(parsed.diagnostic.message);
		await atomicWriteConfig(path, stringify(next, { lineWidth: 0 }));
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
			if (Object.hasOwn(parsed.source, "defaultModel")) return parsed.config.defaultModel;
			source = parsed.source;
		} catch (error) {
			if (!isErrorCode(error, "ENOENT")) return null;
			source = { version: GLOBAL_CONFIG_VERSION };
		}
		const next = { ...source, version: GLOBAL_CONFIG_VERSION, defaultModel: legacy };
		await atomicWriteConfig(path, stringify(next, { lineWidth: 0 }));
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
		const history = isRecord(source.history) ? { ...source.history } : {};
		history[key] = value;
		const next = { ...source, version: GLOBAL_CONFIG_VERSION, history };
		const parsed = parseConfigRecord(stringify(next), path);
		if ("diagnostic" in parsed) throw new Error(parsed.diagnostic.message);
		await atomicWriteConfig(path, stringify(next, { lineWidth: 0 }));
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
		const next = { ...source, version: GLOBAL_CONFIG_VERSION, serviceTier };
		const parsed = parseConfigRecord(stringify(next), path);
		if ("diagnostic" in parsed) throw new Error(parsed.diagnostic.message);
		await atomicWriteConfig(path, stringify(next, { lineWidth: 0 }));
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

export async function updateSubagentRequirement(
	key: "requireAdvisor" | "requireReviewer",
	value: boolean,
	path = resolveGlobalConfigPath(),
): Promise<GlobalConfig> {
	return withConfigLock(path, async () => {
		const source = await readConfigSourceForMutation(path);
		const subagents = isRecord(source.subagents) ? { ...source.subagents } : {};
		subagents[key] = value;
		const next = { ...source, version: GLOBAL_CONFIG_VERSION, subagents };
		const parsed = parseConfigRecord(stringify(next), path);
		if ("diagnostic" in parsed) throw new Error(parsed.diagnostic.message);
		await atomicWriteConfig(path, stringify(next, { lineWidth: 0 }));
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
		await atomicWriteConfig(path, stringify(next, { lineWidth: 0 }));
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
		await atomicWriteConfig(path, stringify(next, { lineWidth: 0 }));
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
		const mcp = isRecord(source.mcp) ? { ...source.mcp } : {};
		const servers = isRecord(mcp.servers) ? { ...mcp.servers } : {};
		if (record === undefined) delete servers[serverId];
		else servers[serverId] = record;
		mcp.servers = servers;
		const next = { ...source, version: GLOBAL_CONFIG_VERSION, mcp };
		if (record === undefined && Object.keys(servers).length === 0) {
			delete (next as ConfigRecord).mcp;
		}
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
		const tracking = source.tracking === undefined ? {} : source.tracking;
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
			defaultModel: source.defaultModel === null || typeof source.defaultModel === "string"
				? source.defaultModel
				: DEFAULT_GLOBAL_CONFIG.defaultModel,
			serviceTier: source.serviceTier === "priority" ? "priority" : DEFAULT_GLOBAL_CONFIG.serviceTier,
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
			...(source.mcp !== undefined ? { mcp: source.mcp } : {}),
		};
		if (
			(source.defaultModel !== undefined && source.defaultModel !== null && !isConfiguredModel(source.defaultModel)) ||
			(source.serviceTier !== undefined && source.serviceTier !== "default" && source.serviceTier !== "priority") ||
			(history.autoArchive !== undefined && typeof history.autoArchive !== "boolean") ||
			!validOptionalInteger(history.shortTestMaxWords, 1, 100) ||
			!validOptionalInteger(history.maxActive, 1, 1_000) ||
			!validOptionalInteger(history.maxArchived, 1, 1_000)
			|| (subagents.advisorModel !== undefined && !isAdvisorModel(subagents.advisorModel))
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
			|| (guiTheme.mode !== undefined && guiTheme.mode !== "dark" && guiTheme.mode !== "light")
			|| (guiTheme.preset !== undefined && !isGuiThemePreset(guiTheme.preset))
			|| !validOptionalInteger(guiLayout.railWidth, 200, 440)
			|| !validOptionalInteger(guiLayout.workbenchWidth, 320, 800)
			|| Object.keys(DEFAULT_GLOBAL_CONFIG.gui.shortcuts).some((key) => guiShortcuts[key] !== undefined && !isShortcutChord(guiShortcuts[key]))
			|| (gui.remoteHosts !== undefined && !validGuiRemoteHosts(gui.remoteHosts))
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
		history: { ...DEFAULT_GLOBAL_CONFIG.history },
		subagents: { ...DEFAULT_GLOBAL_CONFIG.subagents },
		tracking: { ...DEFAULT_GLOBAL_CONFIG.tracking },
		gui: {
			appMode: DEFAULT_GLOBAL_CONFIG.gui.appMode,
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

function applyConfigField(source: ConfigRecord, field: GlobalConfigField, value: unknown): ConfigRecord {
	const next: ConfigRecord = { ...source, version: GLOBAL_CONFIG_VERSION };
	const section = (name: string): ConfigRecord => isRecord(next[name]) ? { ...(next[name] as ConfigRecord) } : {};
	if (field === "defaultModel" || field === "serviceTier") {
		next[field] = value;
		return next;
	}
	const [root, child, leaf] = field.split(".");
	const rootRecord = section(root!);
	if (leaf === undefined) rootRecord[child!] = value;
	else {
		const childRecord = isRecord(rootRecord[child!]) ? { ...(rootRecord[child!] as ConfigRecord) } : {};
		childRecord[leaf] = value;
		rootRecord[child!] = childRecord;
	}
	next[root!] = rootRecord;
	return next;
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
