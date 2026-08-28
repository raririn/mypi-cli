/**
 * Unified configuration file primitives (config.yaml, version 2).
 *
 * The single authority for user-facing settings across the daemon, the mypi
 * TUI, and the pizzeria GUI. On disk the file is namespaced:
 *
 *   version: 2
 *   shared:   settings every client and the daemon honor
 *   cli:      mypi TUI only
 *   gui:      pizzeria desktop only
 *
 * Clients only load their own section plus `shared`. The in-memory
 * `GlobalConfig` shape (product/global-config.ts) stays flat; this module owns
 * the disk layout: section mapping for the flat `Settings` view, deterministic
 * key ordering, and generated comments (notes such as when a value takes
 * effect). Comments are regenerated on every programmatic write — hand-written
 * comments do not survive.
 *
 * settings.json remains only as the machine-managed resource/state registry
 * (packages, extensions, skills, prompts, themes, changelog stamp, tracking
 * id, legacy provider/model pair); see core/settings-manager.ts.
 */
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { constants } from "node:fs";
import lockfile from "proper-lockfile";
import { isMap, isScalar, parseDocument, stringify, type Document } from "yaml";

export const UNIFIED_CONFIG_FILENAME = "config.yaml";
export const UNIFIED_CONFIG_VERSION = 2;
/** Pre-namespace layout: flat top-level keys plus `gui`/`mcp`. */
export const LEGACY_CONFIG_VERSION = 1;
export const MAX_UNIFIED_CONFIG_BYTES = 1024 * 1024;

export type ConfigRecord = Record<string, unknown>;

/** Flat `Settings` keys that live under `cli:` (mypi TUI only). */
export const CLI_SECTION_KEYS = new Set<string>([
	"autocompleteMaxVisible",
	"collapseChangelog",
	"doubleEscapeAction",
	"editorPaddingX",
	"enableAnalytics",
	"enableInstallTelemetry",
	"enableSkillCommands",
	"externalEditor",
	"followUpMode",
	"hideThinkingBlock",
	"images",
	"markdown",
	"npmCommand",
	"outputPad",
	"quietStartup",
	"shellCommandPrefix",
	"shellPath",
	"showCacheMissNotices",
	"showHardwareCursor",
	"steeringMode",
	"terminal",
	"theme",
	"treeFilterMode",
	"warnings",
]);

/** Flat `Settings` keys that live under `shared:` with the same name. */
export const SHARED_SECTION_KEYS = new Set<string>([
	"branchSummary",
	"compaction",
	"defaultProjectTrust",
	"enabledModels",
	"httpIdleTimeoutMs",
	"httpProxy",
	"imageGen",
	"readonly",
	"retry",
	"safety",
	"sessionDir",
	"webSearch",
	"thinkingBudgets",
	"tools",
	"transport",
	"websocketConnectTimeoutMs",
]);

/** Flat keys that stay in settings.json: machine-managed state and resource
 *  lists (converge-profile.mjs and `mypi install` keep rewriting them), plus
 *  the legacy provider/model pair that resolveConfiguredDefaultModel retires. */
export const SETTINGS_REGISTRY_KEYS = new Set<string>([
	"apiKeys",
	"defaultModel",
	"defaultProvider",
	"extensions",
	"lastChangelogVersion",
	"lastPiCoreChangelogVersion",
	"packages",
	"prompts",
	"skills",
	"themes",
	"trackingId",
]);

function isRecord(value: unknown): value is ConfigRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): ConfigRecord {
	return isRecord(value) ? value : {};
}

/** Flat `Settings`-shaped view of the unified source's cli + shared sections. */
export function settingsViewFromUnifiedSource(source: ConfigRecord): ConfigRecord {
	const shared = record(source.shared);
	const cli = record(source.cli);
	const flat: ConfigRecord = {};
	for (const key of CLI_SECTION_KEYS) {
		if (cli[key] !== undefined) flat[key] = cli[key];
	}
	for (const key of SHARED_SECTION_KEYS) {
		if (shared[key] !== undefined) flat[key] = shared[key];
	}
	const thinking = record(shared.thinking);
	if (thinking.defaultLevel !== undefined) flat.defaultThinkingLevel = thinking.defaultLevel;
	return flat;
}

/**
 * Route a flat `Settings` object into the unified source. Returns the next
 * source plus the leftover keys that belong to settings.json (registry/state
 * and anything unrecognized). Section keys not touched by `flat` survive.
 */
export function applySettingsToUnifiedSource(
	source: ConfigRecord,
	flat: ConfigRecord,
): { source: ConfigRecord; leftover: ConfigRecord } {
	const next: ConfigRecord = { ...source, version: UNIFIED_CONFIG_VERSION };
	const cli = { ...record(source.cli) };
	const shared = { ...record(source.shared) };
	const leftover: ConfigRecord = {};
	for (const [key, value] of Object.entries(flat)) {
		if (value === undefined) continue;
		if (CLI_SECTION_KEYS.has(key)) cli[key] = value;
		else if (SHARED_SECTION_KEYS.has(key)) shared[key] = value;
		else if (key === "defaultThinkingLevel") shared.thinking = { ...record(shared.thinking), defaultLevel: value };
		else leftover[key] = value;
	}
	next.cli = cli;
	next.shared = shared;
	return { source: next, leftover };
}

/** Keys owned by the version-1 layout that move under `shared:`. */
const V1_SHARED_TOP_KEYS = ["defaultModel", "serviceTier", "honestUserAgent", "tools", "history", "subagents", "tracking"] as const;

/** Lift a parsed version-1 record to the version-2 layout (pure; no I/O).
 *  Version-2 records pass through untouched. */
export function liftUnifiedSource(source: ConfigRecord): ConfigRecord {
	if (source.version === UNIFIED_CONFIG_VERSION) return source;
	const next: ConfigRecord = { version: UNIFIED_CONFIG_VERSION };
	const shared: ConfigRecord = {};
	const claimed = new Set<string>(["version", "gui", "mcp", ...V1_SHARED_TOP_KEYS]);
	for (const key of V1_SHARED_TOP_KEYS) {
		if (Object.hasOwn(source, key)) shared[key] = source[key];
	}
	if (Object.hasOwn(source, "mcp")) shared.mcp = source.mcp;
	next.shared = shared;
	if (Object.hasOwn(source, "gui")) next.gui = source.gui;
	for (const [key, value] of Object.entries(source)) {
		if (!claimed.has(key)) next[key] = value;
	}
	return next;
}

const TOP_KEY_ORDER = ["version", "shared", "cli", "gui"];
const SHARED_KEY_ORDER = [
	"defaultModel", "serviceTier", "honestUserAgent",
	"safety", "readonly", "webSearch", "thinking", "tools",
	"transport", "sessionDir", "defaultProjectTrust", "enabledModels",
	"httpProxy", "httpIdleTimeoutMs", "websocketConnectTimeoutMs",
	"compaction", "branchSummary", "retry", "thinkingBudgets",
	"history", "subagents", "tracking",
	"mcp",
];
const GUI_KEY_ORDER = ["appMode", "favouritePi", "thinkingView", "noticeTimeoutSeconds", "theme", "layout", "shortcuts", "remoteHosts"];

function orderRecord(source: ConfigRecord, preferred: readonly string[]): ConfigRecord {
	const ordered: ConfigRecord = {};
	for (const key of preferred) {
		if (Object.hasOwn(source, key)) ordered[key] = source[key];
	}
	for (const key of Object.keys(source).sort()) {
		if (!Object.hasOwn(ordered, key)) ordered[key] = source[key];
	}
	return ordered;
}

const FILE_HEADER = [
	" MyPi / Pizzeria configuration — the single authority for user settings.",
	" Sections: shared (all clients + daemon), cli (mypi TUI), gui (pizzeria",
	" desktop). Clients only load their own section plus shared.",
	" Comments are regenerated on every programmatic write; hand-written",
	" comments will not survive. Machine state and installed resource lists",
	" live in settings.json, which is not user configuration.",
].join("\n");

/** Notes rendered as comments. Section paths get a block comment above the
 *  key; leaf scalars get an inline comment; maps get a comment on the key. */
const CONFIG_NOTES: Record<string, string> = {
	"shared": "Settings every client and the daemon honor.",
	"shared.defaultModel": "provider/model, or null for automatic. New sessions.",
	"shared.serviceTier": "default | priority. Applies at the next turn boundary.",
	"shared.honestUserAgent": "true advertises pizzeria/<version>. Effective within ~5s.",
	"shared.safety": "defaultMode: safe|sandbox|sandbox-ask|ask|full. bashGuard: false disables dangerous-command interception (full access only). New sessions only.",
	"shared.readonly": "preference: readonly|noread|never — persistent /readonly · /noread access mode. Next session.",
	"shared.webSearch": "provider: brave|curl for the built-in web_search tool. Next search.",
	"shared.thinking": "defaultLevel: off..max. New sessions only; clamped per model.",
	"shared.tools": "mode: flat|code|compatible. Needs a daemon restart.",
	"shared.transport": "sse|websocket|websocket-cached|auto. New sessions.",
	"shared.sessionDir": "Custom session storage directory. New sessions.",
	"shared.defaultProjectTrust": "ask|always|never for untrusted project prompts.",
	"shared.enabledModels": "Model patterns for cycling (same format as --models).",
	"shared.httpProxy": "Applied as HTTP(S)_PROXY for managed clients. New requests.",
	"shared.httpIdleTimeoutMs": "0 disables. New requests.",
	"shared.websocketConnectTimeoutMs": "0 disables. New connections.",
	"shared.compaction": "Context compaction. Next turn.",
	"shared.branchSummary": "Branch summarization. Next branch switch.",
	"shared.retry": "Provider retry policy. New requests.",
	"shared.thinkingBudgets": "Custom token budgets per thinking level.",
	"shared.history": "History maintenance. Next new-session maintenance pass.",
	"shared.subagents": "Advisor/reviewer delegation defaults. New sessions.",
	"shared.tracking": "Workspace checkpoint limits and warnings. Immediate.",
	"shared.imageGen": "provider: openai-codex — enables the generate_image tool (reads the OpenAI Codex OAuth). New sessions.",
	"shared.mcp": "MCP servers. Managed via GUI/CLI commands. New sessions.",
	"cli": "mypi TUI only — other clients do not read this section.",
	"cli.theme": "TUI color theme. Immediate.",
	"cli.externalEditor": "Ctrl+G editor command; falls back to VISUAL/EDITOR.",
	"cli.doubleEscapeAction": "fork | tree | none. Immediate.",
	"cli.steeringMode": "all | one-at-a-time. Immediate.",
	"cli.followUpMode": "all | one-at-a-time. Immediate.",
	"gui": "pizzeria desktop only — the CLI does not read this section.",
	"gui.appMode": "work | chat.",
	"gui.favouritePi": "Launch identity slug; \"rotate\" picks per launch.",
	"gui.theme": "mode: dark|light; preset palette. Immediate.",
	"gui.layout": "Rail/workbench widths in px. Immediate.",
	"gui.shortcuts": "Keyboard chords. Applied on the GUI's next config load.",
	"gui.remoteHosts": "Saved SSH remote hosts (managed via the GUI).",
	"gui.noticeTimeoutSeconds": "Toast auto-fade seconds (3-300). Applied on app start.",
};

function applyGeneratedComments(document: Document): void {
	document.commentBefore = FILE_HEADER;
	for (const [path, note] of Object.entries(CONFIG_NOTES)) {
		const parts = path.split(".");
		const parent = parts.length === 1 ? document.contents : document.getIn(parts.slice(0, -1), true);
		if (!isMap(parent)) continue;
		const leaf = parts.at(-1)!;
		const pair = parent.items.find((item) => isScalar(item.key) && item.key.value === leaf);
		if (!pair || !isScalar(pair.key)) continue;
		if (parts.length === 1) {
			// Top-level section: block comment above, blank line before.
			pair.key.commentBefore = ` ${note}`;
			pair.key.spaceBefore = true;
		} else if (isScalar(pair.value)) {
			pair.value.comment = ` ${note}`;
		} else {
			pair.key.comment = ` ${note}`;
		}
	}
}

/** Deterministic, commented serialization of a unified (version-2) source. */
export function serializeUnifiedConfig(source: ConfigRecord): string {
	const lifted = liftUnifiedSource(source);
	const ordered = orderRecord(lifted, TOP_KEY_ORDER);
	if (isRecord(ordered.shared)) ordered.shared = orderRecord(ordered.shared, SHARED_KEY_ORDER);
	if (isRecord(ordered.cli)) ordered.cli = orderRecord(ordered.cli, []);
	if (isRecord(ordered.gui)) ordered.gui = orderRecord(ordered.gui, GUI_KEY_ORDER);
	const document = parseDocument(stringify(ordered, { lineWidth: 0 }), { uniqueKeys: true });
	applyGeneratedComments(document);
	const text = document.toString({ lineWidth: 0 });
	return text.endsWith("\n") ? text : `${text}\n`;
}

/** Sync read of the unified source; lifts version-1 files in memory. Returns
 *  undefined when the file does not exist. Throws on unsafe or malformed
 *  files — callers treat that scope as read-only (never overwrite). */
export function readUnifiedSourceSync(path: string): ConfigRecord | undefined {
	if (!existsSync(path)) return undefined;
	const info = lstatSync(path);
	if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Unified configuration is not a regular non-symlink file: ${path}`);
	if (info.size > MAX_UNIFIED_CONFIG_BYTES) throw new Error(`Unified configuration exceeds ${MAX_UNIFIED_CONFIG_BYTES} bytes: ${path}`);
	const document = parseDocument(readFileSync(path, "utf8"), { uniqueKeys: true });
	if (document.errors.length > 0) throw new Error(`Unified configuration is malformed YAML: ${path}`);
	const source = document.toJS({ maxAliasCount: 0 });
	if (source === null || source === undefined) return undefined;
	if (!isRecord(source)) throw new Error(`Unified configuration must be a YAML mapping: ${path}`);
	if (source.version !== UNIFIED_CONFIG_VERSION && source.version !== LEGACY_CONFIG_VERSION) {
		throw new Error(`Unified configuration version is unsupported: ${path}`);
	}
	return liftUnifiedSource(source);
}

/** Sync atomic write (tmp + fsync + rename, 0600) of a unified source. */
export function writeUnifiedSourceSync(path: string, source: ConfigRecord): void {
	const parent = dirname(path);
	mkdirSync(parent, { recursive: true, mode: 0o700 });
	const temporary = join(parent, `.${UNIFIED_CONFIG_FILENAME}.${process.pid}.${randomUUID()}.tmp`);
	const descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
	try {
		writeSync(descriptor, serializeUnifiedConfig(source));
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
	try {
		renameSync(temporary, path);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

/** Sync lock on the unified file, compatible with product/global-config.ts's
 *  async lock (same `${path}.lock` lockfile). Retries briefly on contention. */
export function lockUnifiedConfigSync(path: string): () => void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const maxAttempts = 10;
	const delayMs = 20;
	let lastError: unknown;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			return lockfile.lockSync(path, { realpath: false, lockfilePath: `${path}.lock` });
		} catch (error) {
			const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : undefined;
			if (code !== "ELOCKED" || attempt === maxAttempts) throw error;
			lastError = error;
			const start = Date.now();
			while (Date.now() - start < delayMs) {
				// Sleep synchronously; callers are sync by contract.
			}
		}
	}
	throw (lastError as Error) ?? new Error("Failed to acquire unified configuration lock");
}

export function resolveUnifiedConfigPath(agentDir: string): string {
	return join(agentDir, UNIFIED_CONFIG_FILENAME);
}
