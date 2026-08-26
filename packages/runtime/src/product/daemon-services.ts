import { constants, existsSync, realpathSync } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import type { Api, AuthInteraction, AuthType, Model, Usage } from "@earendil-works/pi-ai";
import lockfile from "@bybrave/proper-lockfile2";
import { getAgentDir } from "../config.ts";
import { disposeHandoffNote } from "../core/tools/checkpoint.ts";
import { createAgentSessionServices, type AgentSessionServices } from "../core/agent-session-services.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { removeSubagentParentStorage } from "../core/subagents/storage.ts";
import type { SourceInfo } from "../core/source-info.ts";
import { ProjectTrustStore, resolveProjectTrustRoot } from "../core/trust-manager.ts";
import { archiveChat, resolveChatPaths, restoreChat } from "./mypi-chat-storage.ts";
import { CHAT_TOOL_NAMES } from "./mypi-chat.ts";
import { purgeSessionSnapshotsAcrossTrackers, WorkspaceTracker } from "./workspace-tracker.ts";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import {
	loadGlobalConfig,
	resolveConfiguredDefaultModel,
	splitConfiguredDefaultModel,
	type GlobalConfigDiagnostic,
	type HistoryConfig,
} from "./global-config.ts";
import { canonicalizePath } from "../utils/paths.ts";
import { findInitialModel } from "../core/model-resolver.ts";

const MAX_DISCOVERED_FILES = 10_000;
const MAX_SCAN_DEPTH = 4;
const MAX_SESSION_FILE_BYTES = 256 * 1024 * 1024;
const MAX_LIST_LIMIT = 1_000;
const DEFAULT_LIST_LIMIT = 200;
const MAX_READ_LIMIT = 5_000;
const DEFAULT_READ_LIMIT = 500;
const MAX_READ_BYTES = 8 * 1024 * 1024;
const DEFAULT_READ_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_CHARS = 500;
const SESSION_LOCK_STALE_MS = 30_000;
const SESSION_LOCK_UPDATE_MS = 10_000;

export interface PersistedSessionSummary {
	readonly id: string;
	readonly sessionFile: string;
	readonly cwd: string;
	/** Whether the recorded working directory still exists on this host. */
	readonly cwdExists: boolean;
	/** Product profile that owns this session: ordinary coding sessions live
	 *  under sessions/, MyPi Chat sessions under the chat root. */
	readonly profile: "coding" | "chat";
	readonly name?: string;
	readonly firstUserText: string;
	readonly createdAt: string;
	readonly modifiedAt: string;
	readonly mtimeMs: number;
	readonly entryCount: number;
	readonly schemaVersion: number;
	readonly archived: boolean;
	readonly lastUsage?: Usage;
}

export interface PersistedSessionPage {
	readonly sessions: PersistedSessionSummary[];
	readonly offset: number;
	readonly limit: number;
	readonly total: number;
	readonly hasMore: boolean;
}

export interface PersistedSessionReadResult {
	readonly id: string;
	readonly sessionFile: string;
	readonly entries: unknown[];
	readonly nextCursor?: string;
	readonly hasMore: boolean;
	readonly bytes: number;
}

export interface DaemonResourceInventoryEntry {
	readonly name: string;
	readonly description: string;
	readonly source: string;
	readonly path: string;
	readonly enabled: boolean;
	readonly scope?: string;
	readonly origin?: string;
	readonly productClass?: string;
}

export interface DaemonCommandInventoryEntry {
	readonly name: string;
	readonly description: string;
	readonly source: "extension" | "prompt" | "skill";
}

export interface PersistedSessionListOptions {
	readonly cwd?: string;
	readonly includeArchived?: boolean;
	/** Restrict to one product profile; omitted lists both. */
	readonly profile?: "coding" | "chat";
	readonly offset?: number;
	readonly limit?: number;
	readonly agentDir?: string;
}

export interface PersistedSessionReadOptions {
	readonly id?: string;
	readonly sessionFile?: string;
	readonly since?: string;
	readonly limit?: number;
	readonly maxBytes?: number;
	readonly includeArchived?: boolean;
	readonly agentDir?: string;
}

export interface SessionMaintenanceMove {
	readonly id: string;
	readonly from: string;
	readonly to: string;
	readonly snapshotsRemoved?: number;
}

export interface SessionMaintenanceResult {
	readonly config: HistoryConfig;
	readonly configDiagnostic?: GlobalConfigDiagnostic;
	readonly archivedShortTests: SessionMaintenanceMove[];
	readonly archivedOverflow: SessionMaintenanceMove[];
	readonly skipped: Array<{ readonly id: string; readonly reason: string }>;
	readonly activeCount: number;
	readonly archivedCount: number;
	readonly archivedExcess: number;
	readonly cleanupCommand?: "/archive-cleanup";
}

export interface SessionArchiveResult {
	readonly sessionId: string;
	readonly archived: boolean;
	readonly profile: "coding" | "chat";
	readonly snapshotsRemoved: number;
}

export interface ArchiveCleanupPreview {
	readonly cwd: string;
	readonly maxArchived: number;
	readonly archivedCount: number;
	readonly excess: number;
	readonly candidates: PersistedSessionSummary[];
	readonly configDiagnostic?: GlobalConfigDiagnostic;
}

export interface ProjectRemovalPreview {
	readonly project: string;
	readonly historyMode: "delete" | "archive";
	readonly active: Array<Pick<PersistedSessionSummary, "id" | "sessionFile">>;
	readonly archived: Array<Pick<PersistedSessionSummary, "id" | "sessionFile">>;
}

/** Everything a daemon needs to spawn one MyPi Chat engine child: the chat
 *  asset directory as cwd, the sealed chat tool/extension flags, and the
 *  profile environment. A missing sessionId allocates a fresh chat. */
export interface ChatEngineLaunch {
	readonly cwd: string;
	readonly args: readonly string[];
	readonly env: Readonly<Record<string, string>>;
	/** Session file path to resume; absent for a fresh chat. */
	readonly sessionPath?: string;
}

export async function prepareChatEngineLaunch(options: { agentDir?: string; sessionId?: string } = {}): Promise<ChatEngineLaunch> {
	const chat = resolveChatPaths(options.agentDir);
	await mkdir(chat.activeHistory, { recursive: true });
	await mkdir(chat.activeAssets, { recursive: true });
	const env = {
		MYPI_RUNTIME_PROFILE: "chat",
		MYPI_CHAT_ROOT: chat.root,
		PI_GUI_CHAT_ROOT: chat.root,
	};
	const baseArgs = [
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-context-files",
		"--tools",
		CHAT_TOOL_NAMES.join(","),
		"--session-dir",
		chat.activeHistory,
	];
	if (options.sessionId) {
		const summaries = await scanSessionRoot(chat.activeHistory, false, "chat");
		const match = summaries.find((session) => session.id === options.sessionId);
		if (!match) throw new Error("Chat session was not found among active chats");
		const cwd = match.cwd || join(chat.activeAssets, options.sessionId);
		await mkdir(cwd, { recursive: true });
		return { cwd, args: baseArgs, env, sessionPath: match.sessionFile };
	}
	const cwd = join(chat.activeAssets, randomUUID());
	await mkdir(cwd, { recursive: true });
	await writeFile(join(cwd, "canvas.md"), "", { flag: "wx" }).catch(() => undefined);
	return { cwd, args: baseArgs, env };
}

export async function listPersistedSessions(options: PersistedSessionListOptions = {}): Promise<PersistedSessionPage> {
	const roots = resolveSessionRoots(options.agentDir);
	const chat = resolveChatPaths(options.agentDir);
	const wantCoding = options.profile !== "chat";
	const wantChat = options.profile !== "coding";
	const active = [
		...(wantCoding ? await scanSessionRoot(roots.sessionsRoot, false) : []),
		...(wantChat ? await scanSessionRoot(chat.activeHistory, false, "chat") : []),
	];
	const archived = options.includeArchived
		? [
				...(wantCoding ? await scanSessionRoot(roots.archiveRoot, true) : []),
				...(wantChat ? await scanSessionRoot(chat.archiveHistory, true, "chat") : []),
			]
		: [];
	const cwd = options.cwd ? await canonicalPath(options.cwd) : undefined;
	const sessions = [...active, ...archived]
		.filter((session) => !cwd || session.cwd === cwd)
		.sort(compareNewestSession);
	const offset = boundedInteger(options.offset, 0, Number.MAX_SAFE_INTEGER, 0);
	const limit = boundedInteger(options.limit, 1, MAX_LIST_LIMIT, DEFAULT_LIST_LIMIT);
	const page = sessions.slice(offset, offset + limit);
	return { sessions: page, offset, limit, total: sessions.length, hasMore: offset + page.length < sessions.length };
}

export async function readPersistedSession(options: PersistedSessionReadOptions): Promise<PersistedSessionReadResult> {
	if (!options.id && !options.sessionFile) throw new Error("read_session requires id or sessionFile");
	const roots = resolveSessionRoots(options.agentDir);
	const chat = resolveChatPaths(options.agentDir);
	const candidates = [
		...(await scanSessionRoot(roots.sessionsRoot, false)),
		...(options.includeArchived === false ? [] : await scanSessionRoot(roots.archiveRoot, true)),
		...(await scanSessionRoot(chat.activeHistory, false, "chat")),
		...(options.includeArchived === false ? [] : await scanSessionRoot(chat.archiveHistory, true, "chat")),
	];
	const matches = candidates.filter((session) =>
		(options.id ? session.id === options.id : true) &&
		(options.sessionFile ? session.sessionFile === resolve(options.sessionFile) : true),
	);
	if (matches.length !== 1) throw new Error(matches.length === 0 ? "Persisted session was not found" : "Persisted session identity is ambiguous");
	const session = matches[0]!;
	const limit = boundedInteger(options.limit, 1, MAX_READ_LIMIT, DEFAULT_READ_LIMIT);
	const maxBytes = boundedInteger(options.maxBytes, 1_024, MAX_READ_BYTES, DEFAULT_READ_BYTES);
	const containmentRoot = session.profile === "chat"
		? (session.archived ? chat.archiveHistory : chat.activeHistory)
		: (session.archived ? roots.archiveRoot : roots.sessionsRoot);
	const handle = await openSafeSessionFile(session.sessionFile, containmentRoot);
	const entries: unknown[] = [];
	let cursorSeen = options.since === undefined;
	let bytes = 0;
	let countedEntries = 0;
	let lastEntryId: string | undefined;
	let stopped = false;
	try {
		const input = handle.createReadStream({ encoding: "utf8", autoClose: false });
		const lines = createInterface({ input, crlfDelay: Infinity });
		for await (const line of lines) {
			if (!line.trim()) continue;
			let entry: unknown;
			try {
				entry = JSON.parse(line);
			} catch {
				// Append-only writers can leave one incomplete trailing line. Stop at
				// the first malformed record rather than returning invented structure.
				break;
			}
			const id = isRecord(entry) && typeof entry.id === "string" ? entry.id : undefined;
			if (!cursorSeen) {
				if (id === options.since) cursorSeen = true;
				continue;
			}
			if (options.since !== undefined && id === options.since) continue;
			const encodedBytes = Buffer.byteLength(line, "utf8") + 1;
			if (countedEntries >= limit || bytes + encodedBytes > maxBytes) {
				stopped = true;
				break;
			}
			entries.push(entry);
			bytes += encodedBytes;
			if (id) {
				lastEntryId = id;
				countedEntries += 1;
			}
		}
	} finally {
		await handle.close();
	}
	if (!cursorSeen) throw new Error("read_session since cursor was not found");
	if (stopped && !lastEntryId) {
		throw new Error("read_session maxBytes is too small for the next complete entry");
	}
	return {
		id: session.id,
		sessionFile: session.sessionFile,
		entries,
		...(stopped && lastEntryId ? { nextCursor: lastEntryId } : {}),
		hasMore: stopped,
		bytes,
	};
}

export async function getPersistedSessionStats(options: PersistedSessionReadOptions): Promise<Record<string, unknown>> {
	const roots = resolveSessionRoots(options.agentDir);
	const chat = resolveChatPaths(options.agentDir);
	const candidates = [
		...(await scanSessionRoot(roots.sessionsRoot, false)),
		...(options.includeArchived === false ? [] : await scanSessionRoot(roots.archiveRoot, true)),
		...(await scanSessionRoot(chat.activeHistory, false, "chat")),
		...(options.includeArchived === false ? [] : await scanSessionRoot(chat.archiveHistory, true, "chat")),
	];
	const matches = candidates.filter((session) =>
		(options.id ? session.id === options.id : true) &&
		(options.sessionFile ? session.sessionFile === resolve(options.sessionFile) : true),
	);
	if (matches.length !== 1) throw new Error("Persisted session was not found or is ambiguous");
	const session = matches[0]!;
	return {
		sessionId: session.id,
		sessionFile: session.sessionFile,
		entryCount: session.entryCount,
		modifiedAt: session.modifiedAt,
		...(session.lastUsage ? { lastUsage: session.lastUsage } : {}),
	};
}

const serviceCache = new Map<string, Promise<AgentSessionServices>>();

export async function getDaemonAvailableModels(cwd: string, agentDir = getAgentDir()): Promise<Record<string, unknown>[]> {
	return (await getDaemonModelCatalog(cwd, agentDir)).models;
}

export async function getDaemonModelCatalog(cwd: string, agentDir = getAgentDir()): Promise<{
	models: Record<string, unknown>[];
	defaultModel: Record<string, unknown> | null;
}> {
	const services = await daemonServices(cwd, agentDir);
	// The daemon outlives GUI/TUI processes: without a reload, credential
	// changes made elsewhere (terminal /logout, /login) are invisible to the
	// cached runtime for the daemon's whole lifetime (same rule as the RPC
	// path and listDaemonAuthProviders).
	await services.modelRuntime.reloadPersistedModelState();
	const configuredDefault = splitConfiguredDefaultModel(await resolveConfiguredDefaultModel({
		path: join(resolve(agentDir), "config.yaml"),
		legacyProvider: services.settingsManager.getLegacyGlobalDefaultProvider(),
		legacyModelId: services.settingsManager.getLegacyGlobalDefaultModel(),
	}));
	const initial = await findInitialModel({
		scopedModels: [],
		isContinuing: false,
		defaultProvider: configuredDefault?.provider,
		defaultModelId: configuredDefault?.modelId,
		defaultThinkingLevel: services.settingsManager.getDefaultThinkingLevel(),
		modelRuntime: services.modelRuntime,
	});
	return {
		models: services.modelRuntime.getAvailableSnapshot().map(serializeModel),
		defaultModel: initial.model ? serializeModel(initial.model) : null,
	};
}

/** One selectable login flow (a provider appears once per supported flow,
 *  mirroring the TUI's /login picker). */
export interface DaemonAuthProviderEntry {
	readonly id: string;
	readonly name: string;
	readonly authType: "oauth" | "api_key";
	/** OAuth button caption (e.g. "Claude Pro/Max"); absent for API keys. */
	readonly loginLabel?: string;
	/** False = ambient-only (env vars); the flow cannot be driven interactively. */
	readonly hasLogin: boolean;
	/** Present when the provider currently has working credentials. */
	readonly status?: { readonly type: "oauth" | "api_key"; readonly source: string };
}

/** GUI /login parity: enumerate providers exactly like the TUI picker
 *  (interactive-mode getLoginProviderOptions), but engine-free. */
export async function listDaemonAuthProviders(cwd: string, agentDir = getAgentDir()): Promise<DaemonAuthProviderEntry[]> {
	const runtime = (await daemonServices(cwd, agentDir)).modelRuntime;
	await runtime.reloadPersistedModelState();
	const entries: DaemonAuthProviderEntry[] = [];
	for (const provider of runtime.getProviders()) {
		const authStatus = runtime.getProviderAuthStatus(provider.id);
		const status = authStatus.configured
			? {
					type: runtime.isUsingOAuth(provider.id) ? ("oauth" as const) : ("api_key" as const),
					source: authStatus.label ?? authStatus.source ?? "configured",
				}
			: undefined;
		if (provider.auth.oauth) {
			entries.push({
				id: provider.id,
				name: provider.name,
				authType: "oauth",
				...(provider.auth.oauth.loginLabel ? { loginLabel: provider.auth.oauth.loginLabel } : {}),
				hasLogin: true,
				...(status ? { status } : {}),
			});
		}
		if (provider.auth.apiKey) {
			entries.push({
				id: provider.id,
				name: provider.name,
				authType: "api_key",
				hasLogin: typeof provider.auth.apiKey.login === "function",
				...(status ? { status } : {}),
			});
		}
	}
	return entries.sort((a, b) => a.name.localeCompare(b.name));
}

/** Run one provider login on the daemon's engine-free runtime. The caller
 *  owns the interaction transport (prompts/notifications over daemon frames)
 *  and cancellation via interaction.signal. Credentials land in the shared
 *  auth.json, which live engines re-read on their next model listing. */
export async function runDaemonProviderLogin(
	cwd: string,
	providerId: string,
	authType: AuthType,
	interaction: AuthInteraction,
	agentDir = getAgentDir(),
): Promise<{ providerId: string; source: string }> {
	const runtime = (await daemonServices(cwd, agentDir)).modelRuntime;
	await runtime.login(providerId, authType, interaction);
	const status = runtime.getProviderAuthStatus(providerId);
	return { providerId, source: status.label ?? status.source ?? "stored" };
}

export async function daemonProviderLogout(cwd: string, providerId: string, agentDir = getAgentDir()): Promise<void> {
	const runtime = (await daemonServices(cwd, agentDir)).modelRuntime;
	await runtime.logout(providerId);
}

export async function listDaemonSkills(cwd: string, agentDir = getAgentDir()): Promise<DaemonResourceInventoryEntry[]> {
	const services = await daemonServices(cwd, agentDir);
	return services.resourceLoader.getSkills().skills.slice(0, MAX_LIST_LIMIT).map((skill) => ({
		name: skill.name,
		description: compactText(skill.description, MAX_TEXT_CHARS),
		source: skill.sourceInfo.source,
		path: skill.filePath,
		enabled: true,
		...sourceMetadata(skill.sourceInfo),
	}));
}

export async function listDaemonExtensions(cwd: string, agentDir = getAgentDir()): Promise<DaemonResourceInventoryEntry[]> {
	const services = await daemonServices(cwd, agentDir);
	return services.resourceLoader.getExtensions().extensions.slice(0, MAX_LIST_LIMIT).map((extension) => {
		const commandDescriptions = [...extension.commands.values()].map((command) => command.description).filter(Boolean);
		const toolDescriptions = [...extension.tools.values()].map((tool) => tool.definition.description).filter(Boolean);
		const description = commandDescriptions[0] ?? toolDescriptions[0] ?? `${extension.tools.size} tools, ${extension.commands.size} commands`;
		return {
			name: productName(extension.path) ?? extension.path.split(/[\\/]/u).at(-1) ?? extension.path,
			description: compactText(description, MAX_TEXT_CHARS),
			source: extension.sourceInfo.source,
			path: extension.path,
			enabled: true,
			...sourceMetadata(extension.sourceInfo),
		};
	});
}

export async function readDaemonResourceFile(cwd: string, requestedPath: string, agentDir = getAgentDir()): Promise<{ path: string; content: string }> {
	const inventory = [...await listDaemonSkills(cwd, agentDir), ...await listDaemonExtensions(cwd, agentDir)];
	const entry = inventory.find((candidate) => candidate.path === requestedPath);
	if (!entry) throw new Error("Resource path is not in the current trusted discovery inventory.");
	const info = await lstat(entry.path);
	if (!info.isFile() || info.isSymbolicLink()) throw new Error("Discovered resource is not a regular non-symlink file.");
	if (info.size > 2 * 1024 * 1024) throw new Error("Discovered resource exceeds the 2 MiB preview limit.");
	return { path: entry.path, content: await readFile(entry.path, "utf8") };
}

/** Discover slash commands without materializing or attaching a session.
 * This uses the same cwd-bound trusted resource set as session startup so a
 * draft or idle history can present extension, prompt, and skill commands
 * before paying the runtime engine graph. */
export async function listDaemonCommands(cwd: string, agentDir = getAgentDir()): Promise<DaemonCommandInventoryEntry[]> {
	const services = await daemonServices(cwd, agentDir);
	const entries: DaemonCommandInventoryEntry[] = [];
	const extensionCommands = services.resourceLoader.getExtensions().extensions.flatMap((extension) =>
		[...extension.commands.values()].map((command) => ({
			name: command.name,
			description: compactText(command.description ?? "Extension command", MAX_TEXT_CHARS),
			source: "extension" as const,
		})),
	);
	const counts = new Map<string, number>();
	for (const command of extensionCommands) counts.set(command.name, (counts.get(command.name) ?? 0) + 1);
	const seen = new Map<string, number>();
	for (const command of extensionCommands) {
		const occurrence = (seen.get(command.name) ?? 0) + 1;
		seen.set(command.name, occurrence);
		entries.push({
			...command,
			name: (counts.get(command.name) ?? 0) > 1 ? `${command.name}:${occurrence}` : command.name,
		});
	}
	for (const prompt of services.resourceLoader.getPrompts().prompts) {
		entries.push({
			name: prompt.name,
			description: compactText(prompt.description ?? "Prompt template", MAX_TEXT_CHARS),
			source: "prompt",
		});
	}
	for (const skill of services.resourceLoader.getSkills().skills) {
		entries.push({
			name: `skill:${skill.name}`,
			description: compactText(skill.description, MAX_TEXT_CHARS),
			source: "skill",
		});
	}
	const unique = new Map<string, DaemonCommandInventoryEntry>();
	for (const entry of entries) if (!unique.has(entry.name)) unique.set(entry.name, entry);
	return [...unique.values()].slice(0, MAX_LIST_LIMIT);
}

export function clearDaemonServiceCache(): void {
	serviceCache.clear();
}

export async function runNewSessionMaintenance(options: {
	readonly sessionId: string;
	readonly sessionFile: string;
	readonly cwd: string;
	readonly agentDir?: string;
}): Promise<SessionMaintenanceResult> {
	const agentDir = options.agentDir ?? getAgentDir();
	const roots = resolveSessionRoots(agentDir);
	const loaded = await loadGlobalConfig(join(resolve(agentDir), "config.yaml"));
	const config = loaded.config.history;
	const archivedShortTests: SessionMaintenanceMove[] = [];
	const archivedOverflow: SessionMaintenanceMove[] = [];
	const skipped: Array<{ id: string; reason: string }> = [];
	const cwd = await canonicalPath(options.cwd);
	const currentFile = await canonicalPath(options.sessionFile);

	if (config.autoArchive) {
		const initial = (await scanSessionRoot(roots.sessionsRoot, false))
			.filter((session) => session.cwd === cwd && session.sessionFile !== currentFile)
			.sort(compareOldestSession);
		for (const session of initial) {
			if (!(await isObviousShortTest(session, roots.sessionsRoot, config.shortTestMaxWords))) continue;
			try {
				archivedShortTests.push(await archiveStoredSession(session, roots, agentDir));
			} catch (error) {
				skipped.push({ id: session.id, reason: boundedMessage(error) });
			}
		}

		const remaining = (await scanSessionRoot(roots.sessionsRoot, false))
			.filter((session) => session.cwd === cwd && session.sessionFile !== currentFile)
			.sort(compareNewestSession);
		// The current new session consumes one slot even if its header has not yet
		// appeared in a concurrent scan.
		const overflow = remaining.slice(Math.max(0, config.maxActive - 1));
		for (const session of overflow.reverse()) {
			try {
				archivedOverflow.push(await archiveStoredSession(session, roots, agentDir));
			} catch (error) {
				skipped.push({ id: session.id, reason: boundedMessage(error) });
			}
		}
	}

	const [active, archived] = await Promise.all([
		scanSessionRoot(roots.sessionsRoot, false),
		scanSessionRoot(roots.archiveRoot, true),
	]);
	const activeCount = active.filter((session) => session.cwd === cwd).length;
	const archivedCount = archived.filter((session) => session.cwd === cwd).length;
	const archivedExcess = Math.max(0, archivedCount - config.maxArchived);
	return {
		config,
		...(loaded.diagnostic ? { configDiagnostic: loaded.diagnostic } : {}),
		archivedShortTests,
		archivedOverflow,
		skipped: skipped.slice(0, 20),
		activeCount,
		archivedCount,
		archivedExcess,
		...(archivedExcess > 0 ? { cleanupCommand: "/archive-cleanup" as const } : {}),
	};
}

export async function previewArchiveCleanup(cwd: string, agentDir = getAgentDir()): Promise<ArchiveCleanupPreview> {
	const roots = resolveSessionRoots(agentDir);
	const loaded = await loadGlobalConfig(join(resolve(agentDir), "config.yaml"));
	const project = await canonicalPath(cwd);
	const archived = (await scanSessionRoot(roots.archiveRoot, true))
		.filter((session) => session.cwd === project)
		.sort(compareNewestSession);
	const candidates = archived.slice(loaded.config.history.maxArchived);
	return {
		cwd: project,
		maxArchived: loaded.config.history.maxArchived,
		archivedCount: archived.length,
		excess: candidates.length,
		candidates,
		...(loaded.diagnostic ? { configDiagnostic: loaded.diagnostic } : {}),
	};
}

export async function cleanupArchivedSessions(
	cwd: string,
	options: { readonly confirm: boolean; readonly agentDir?: string },
): Promise<{ readonly deleted: string[]; readonly failures: Array<{ readonly id: string; readonly reason: string }>; readonly preview: ArchiveCleanupPreview }> {
	if (!options.confirm) throw new Error("Archive cleanup requires explicit confirmation.");
	const agentDir = options.agentDir ?? getAgentDir();
	const roots = resolveSessionRoots(agentDir);
	const preview = await previewArchiveCleanup(cwd, agentDir);
	const deleted: string[] = [];
	const failures: Array<{ id: string; reason: string }> = [];
	for (const session of preview.candidates) {
		try {
			await withStoredSessionLock(session.sessionFile, async () => {
				await assertNoLegacyLease(session.sessionFile);
				const handle = await openSafeSessionFile(session.sessionFile, roots.archiveRoot);
				await handle.close();
				await removeSubagentParentStorage(agentDir, session.id);
				await rm(session.sessionFile);
				disposeHandoffNote(session.sessionFile);
			});
			deleted.push(session.id);
		} catch (error) {
			failures.push({ id: session.id, reason: boundedMessage(error) });
		}
	}
	return { deleted, failures: failures.slice(0, 20), preview };
}

export async function previewProjectRemoval(
	cwd: string,
	historyMode: "delete" | "archive",
	agentDir = getAgentDir(),
): Promise<ProjectRemovalPreview> {
	const roots = resolveSessionRoots(agentDir);
	const project = await canonicalPath(resolveProjectTrustRoot(cwd));
	const matchesProject = async (session: PersistedSessionSummary): Promise<boolean> => {
		if (!session.cwd) return false;
		return await canonicalPath(resolveProjectTrustRoot(session.cwd)) === project;
	};
	const [activeAll, archivedAll] = await Promise.all([
		scanSessionRoot(roots.sessionsRoot, false),
		scanSessionRoot(roots.archiveRoot, true),
	]);
	const active: ProjectRemovalPreview["active"] = [];
	const archived: ProjectRemovalPreview["archived"] = [];
	for (const session of activeAll) if (await matchesProject(session)) active.push({ id: session.id, sessionFile: session.sessionFile });
	for (const session of archivedAll) if (await matchesProject(session)) archived.push({ id: session.id, sessionFile: session.sessionFile });
	return { project, historyMode, active, archived };
}

export async function executeProjectRemoval(
	preview: ProjectRemovalPreview,
	options: { readonly agentDir?: string },
): Promise<{ archived: string[]; deleted: string[]; failures: Array<{ id: string; reason: string }> }> {
	const agentDir = options.agentDir ?? getAgentDir();
	const roots = resolveSessionRoots(agentDir);
	const archived: string[] = [];
	const deleted: string[] = [];
	const failures: Array<{ id: string; reason: string }> = [];
	for (const candidate of preview.active) {
		try {
			const summary = (await scanSessionRoot(roots.sessionsRoot, false)).find((session) => session.id === candidate.id && session.sessionFile === candidate.sessionFile);
			if (!summary || await canonicalPath(resolveProjectTrustRoot(summary.cwd)) !== preview.project) throw new Error("session changed after preview");
			if (preview.historyMode === "archive") {
				await archiveStoredSession(summary, roots, agentDir);
				archived.push(summary.id);
			} else {
				await withStoredSessionLock(summary.sessionFile, async () => {
					await assertNoLegacyLease(summary.sessionFile);
					const handle = await openSafeSessionFile(summary.sessionFile, roots.sessionsRoot);
					await handle.close();
					await removeSubagentParentStorage(agentDir, summary.id);
					await rm(summary.sessionFile);
				});
				deleted.push(summary.id);
			}
		} catch (error) { failures.push({ id: candidate.id, reason: boundedMessage(error) }); }
	}
	if (preview.historyMode === "delete") {
		for (const candidate of preview.archived) {
			try {
				const summary = (await scanSessionRoot(roots.archiveRoot, true)).find((session) => session.id === candidate.id && session.sessionFile === candidate.sessionFile);
				if (!summary || await canonicalPath(resolveProjectTrustRoot(summary.cwd)) !== preview.project) throw new Error("session changed after preview");
				await withStoredSessionLock(summary.sessionFile, async () => {
					await assertNoLegacyLease(summary.sessionFile);
					const handle = await openSafeSessionFile(summary.sessionFile, roots.archiveRoot);
					await handle.close();
					await removeSubagentParentStorage(agentDir, summary.id);
					await rm(summary.sessionFile);
				});
				deleted.push(summary.id);
			} catch (error) { failures.push({ id: candidate.id, reason: boundedMessage(error) }); }
		}
	}
	return { archived, deleted, failures: failures.slice(0, 50) };
}

async function daemonServices(cwd: string, agentDir: string): Promise<AgentSessionServices> {
	let projectTrusted = false;
	try {
		projectTrusted = new ProjectTrustStore(agentDir).get(cwd) === true;
	} catch {
		// A malformed or unsafe trust store cannot grant project code authority.
	}
	const key = `${resolve(agentDir)}\0${resolve(cwd)}\0${projectTrusted ? "trusted" : "untrusted"}`;
	let pending = serviceCache.get(key);
	if (!pending) {
		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });
		pending = createAgentSessionServices({ cwd, agentDir, settingsManager, productProfile: "coding" });
		serviceCache.set(key, pending);
		pending.catch(() => serviceCache.delete(key));
	}
	return pending;
}

async function scanSessionRoot(root: string, archived: boolean, profile: "coding" | "chat" = "coding"): Promise<PersistedSessionSummary[]> {
	const files: string[] = [];
	await collectSessionFiles(root, root, 0, files);
	const sessions: PersistedSessionSummary[] = [];
	for (let index = 0; index < files.length; index += 8) {
		const page = await Promise.all(files.slice(index, index + 8).map((file) => summarizeSessionFile(file, root, archived, profile)));
		for (const session of page) if (session) sessions.push(session);
	}
	return sessions;
}

async function isObviousShortTest(
	session: PersistedSessionSummary,
	root: string,
	maxWords: number,
): Promise<boolean> {
	if (session.name) return false;
	const handle = await openSafeSessionFile(session.sessionFile, root).catch(() => undefined);
	if (!handle) return false;
	const entries: Record<string, unknown>[] = [];
	try {
		const input = handle.createReadStream({ encoding: "utf8", autoClose: false });
		const lines = createInterface({ input, crlfDelay: Infinity });
		for await (const line of lines) {
			if (!line.trim()) continue;
			let entry;
			try { entry = JSON.parse(line); } catch { return false; }
			if (isRecord(entry)) entries.push(entry);
			if (entries.length > 100_000) return false;
		}
	} finally {
		await handle.close();
	}
	if (entries[0]?.type !== "session") return false;
	const body = entries.slice(1);
	const byId = new Map(body.filter((entry) => typeof entry.id === "string").map((entry) => [String(entry.id), entry]));
	let current = [...body].reverse().find((entry) => typeof entry.id === "string");
	const branch: Record<string, unknown>[] = [];
	const seen = new Set<string>();
	while (current) {
		const id = String(current.id);
		if (seen.has(id)) return false;
		seen.add(id);
		branch.push(current);
		current = typeof current.parentId === "string" ? byId.get(current.parentId) : undefined;
	}
	branch.reverse();
	if (branch.some((entry) => entry.type === "compaction" || entry.type === "branch_summary")) return false;
	const messages = branch.filter((entry) => entry.type === "message");
	if (messages.length !== 2 || !isRecord(messages[0]?.message) || !isRecord(messages[1]?.message)) return false;
	const user = messages[0]!.message as Record<string, unknown>;
	const assistant = messages[1]!.message as Record<string, unknown>;
	if (user.role !== "user" || assistant.role !== "assistant") return false;
	if (!textOnlyUserContent(user.content) || !textOnlyAssistantContent(assistant.content)) return false;
	const userText = messageText(user.content);
	const assistantText = messageText(assistant.content);
	return Boolean(userText && assistantText && wordCount(userText) < maxWords && wordCount(assistantText) < maxWords);
}

export interface SessionCompactionResult {
	readonly sessionId: string;
	readonly sessionFile: string;
	readonly compacted: boolean;
	readonly removedEntries: number;
	readonly bytesBefore: number;
	readonly bytesAfter: number;
}

/** Custom types written as full-state snapshots before the engine's
 *  snapshot policy existed; their older copies are equally dead weight. */
const LEGACY_SNAPSHOT_CUSTOM_TYPES = new Set(["mypi-goal", "mypi-plan-goal"]);

interface CompactionLine {
	readonly raw: string;
	readonly entry: { id?: string; parentId?: string | null; type?: string; customType?: string; snapshot?: boolean } | null;
}

function isSnapshotLine(line: CompactionLine): boolean {
	const entry = line.entry;
	if (!entry || entry.type !== "custom" || typeof entry.id !== "string") return false;
	return entry.snapshot === true || (typeof entry.customType === "string" && LEGACY_SNAPSHOT_CUSTOM_TYPES.has(entry.customType));
}

/**
 * Plans a transcript compaction: snapshot custom entries are last-writer-wins
 * on restore, so any snapshot that is shadowed by a deeper same-type snapshot
 * on EVERY leaf path through it carries no information. Removal reparents the
 * children of removed entries so every branch chain still resolves. All other
 * lines — messages, events, unparseable tails — are preserved verbatim.
 */
export function planSessionCompaction(content: string): {
	readonly output: string;
	readonly removedEntries: number;
} {
	const rawLines = content.split("\n");
	const lines: CompactionLine[] = rawLines
		.filter((raw, index) => raw.trim().length > 0 || index < rawLines.length - 1)
		.map((raw) => {
			if (!raw.trim()) return { raw, entry: null };
			try {
				return { raw, entry: JSON.parse(raw) as CompactionLine["entry"] };
			} catch {
				return { raw, entry: null };
			}
		});
	const byId = new Map<string, number>();
	for (const [index, line] of lines.entries()) {
		if (line.entry && typeof line.entry.id === "string") byId.set(line.entry.id, index);
	}
	const referencedAsParent = new Set<string>();
	for (const line of lines) {
		if (line.entry && typeof line.entry.parentId === "string") referencedAsParent.add(line.entry.parentId);
	}
	// Every leaf walks toward the root; the deepest snapshot per customType on
	// that path is load-bearing, the rest are shadowed.
	const kept = new Set<number>();
	for (const [index, line] of lines.entries()) {
		if (!line.entry || typeof line.entry.id !== "string") continue;
		if (referencedAsParent.has(line.entry.id)) continue; // not a leaf
		const seenTypes = new Set<string>();
		let cursor: number | undefined = index;
		let guard = lines.length + 1;
		while (cursor !== undefined && guard-- > 0) {
			const current: CompactionLine = lines[cursor]!;
			if (isSnapshotLine(current)) {
				const customType = current.entry!.customType!;
				if (!seenTypes.has(customType)) {
					seenTypes.add(customType);
					kept.add(cursor);
				}
			}
			const parentId: string | null | undefined = current.entry?.parentId;
			cursor = typeof parentId === "string" ? byId.get(parentId) : undefined;
		}
	}
	const removedIds = new Set<string>();
	for (const [index, line] of lines.entries()) {
		if (isSnapshotLine(line) && !kept.has(index)) removedIds.add(line.entry!.id!);
	}
	if (removedIds.size === 0) return { output: content, removedEntries: 0 };
	// Reparent survivors across removed ancestors so branch chains resolve.
	const resolveParent = (start: string | null | undefined): string | null => {
		let current: string | null = start ?? null;
		let guard = lines.length + 1;
		while (current !== null && removedIds.has(current) && guard-- > 0) {
			const index = byId.get(current);
			const next: string | null | undefined = index === undefined ? null : lines[index]!.entry?.parentId;
			current = typeof next === "string" ? next : null;
		}
		return current;
	};
	const outputLines: string[] = [];
	for (const line of lines) {
		const entry = line.entry;
		if (entry && typeof entry.id === "string" && removedIds.has(entry.id)) continue;
		if (entry && typeof entry.parentId === "string" && removedIds.has(entry.parentId)) {
			outputLines.push(JSON.stringify({ ...entry, parentId: resolveParent(entry.parentId) }));
		} else {
			outputLines.push(line.raw);
		}
	}
	return { output: `${outputLines.join("\n")}\n`, removedEntries: removedIds.size };
}

/**
 * Compacts one stored session file in place. Refuses while a writer holds the
 * session lock ("nothing runs away during cleaning"): live sessions are never
 * touched. The rewrite is verified — reparsed, every branch chain resolved —
 * before atomically replacing the original.
 */
async function compactStoredSessionFile(sessionFile: string, containmentRoot: string): Promise<{ removedEntries: number; bytesBefore: number; bytesAfter: number }> {
	return withStoredSessionLock(sessionFile, async () => {
		await assertNoLegacyLease(sessionFile);
		return compactSessionFileUnlocked(sessionFile, containmentRoot);
	});
}

/** Caller must hold the stored-session lock. */
async function compactSessionFileUnlocked(sessionFile: string, containmentRoot: string): Promise<{ removedEntries: number; bytesBefore: number; bytesAfter: number }> {
	{
		const handle = await openSafeSessionFile(sessionFile, containmentRoot);
		let content: string;
		try {
			content = await handle.readFile({ encoding: "utf8" });
		} finally {
			await handle.close();
		}
		const plan = planSessionCompaction(content);
		if (plan.removedEntries === 0) {
			return { removedEntries: 0, bytesBefore: content.length, bytesAfter: content.length };
		}
		// Verify before replacing: every parentId in the output must resolve.
		const verifyIds = new Set<string>();
		const verifyEntries: { id?: string; parentId?: string | null }[] = [];
		for (const raw of plan.output.split("\n")) {
			if (!raw.trim()) continue;
			const entry = JSON.parse(raw) as { id?: string; parentId?: string | null };
			verifyEntries.push(entry);
			if (typeof entry.id === "string") verifyIds.add(entry.id);
		}
		for (const entry of verifyEntries) {
			if (typeof entry.parentId === "string" && !verifyIds.has(entry.parentId)) {
				throw new Error("compaction verification failed: unresolved parent chain");
			}
		}
		const temporary = `${sessionFile}.compact.tmp`;
		await writeFile(temporary, plan.output, { encoding: "utf8", mode: 0o600 });
		await rename(temporary, sessionFile);
		return { removedEntries: plan.removedEntries, bytesBefore: content.length, bytesAfter: plan.output.length };
	}
}

/** Daemon service: compact a persisted (non-live) session by id. */
export async function compactPersistedSession(sessionId: string, agentDir = getAgentDir()): Promise<SessionCompactionResult> {
	const page = await listPersistedSessions({ agentDir, includeArchived: true, limit: MAX_LIST_LIMIT });
	const matches = page.sessions.filter((session) => session.id === sessionId);
	if (matches.length !== 1) throw new Error(matches.length === 0 ? `Session not found: ${sessionId}` : `Session identity is ambiguous: ${sessionId}`);
	const session = matches[0]!;
	const roots = resolveSessionRoots(agentDir);
	const chat = resolveChatPaths(agentDir);
	const containmentRoot = session.profile === "chat"
		? (session.archived ? chat.archiveHistory : chat.activeHistory)
		: (session.archived ? roots.archiveRoot : roots.sessionsRoot);
	const result = await compactStoredSessionFile(session.sessionFile, containmentRoot);
	clearDaemonServiceCache();
	return { sessionId, sessionFile: session.sessionFile, compacted: result.removedEntries > 0, ...result };
}

async function archiveStoredSession(
	session: PersistedSessionSummary,
	roots: { sessionsRoot: string; archiveRoot: string },
	agentDir: string,
): Promise<SessionMaintenanceMove> {
	const relativePath = relative(resolve(roots.sessionsRoot), resolve(session.sessionFile));
	if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) throw new Error("session escapes active history root");
	const destination = join(roots.archiveRoot, relativePath);
	if (!isContained(destination, roots.archiveRoot)) throw new Error("archive destination escapes managed root");
	await withStoredSessionLock(session.sessionFile, async () => {
		await assertNoLegacyLease(session.sessionFile);
		const handle = await openSafeSessionFile(session.sessionFile, roots.sessionsRoot);
		await handle.close();
		try {
			await lstat(destination);
			throw new Error("archive destination already exists");
		} catch (error) {
			if (!isErrorCode(error, "ENOENT")) throw error;
		}
		// Archiving is the natural compaction point: superseded state
		// snapshots are dropped before the file moves. Best-effort — a
		// compaction failure must never block archiving.
		await compactSessionFileUnlocked(session.sessionFile, roots.sessionsRoot).catch(() => undefined);
		await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
		await rename(session.sessionFile, destination);
	});
	const snapshotsRemoved = await destroySessionSnapshots(agentDir, session.cwd, session.id);
	return { id: session.id, from: session.sessionFile, to: destination, snapshotsRemoved };
}

async function restoreStoredSession(
	session: PersistedSessionSummary,
	roots: { sessionsRoot: string; archiveRoot: string },
): Promise<void> {
	const relativePath = relative(resolve(roots.archiveRoot), resolve(session.sessionFile));
	if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) throw new Error("session escapes archive root");
	const destination = join(roots.sessionsRoot, relativePath);
	if (!isContained(destination, roots.sessionsRoot)) throw new Error("restore destination escapes managed root");
	await withStoredSessionLock(session.sessionFile, async () => {
		const handle = await openSafeSessionFile(session.sessionFile, roots.archiveRoot);
		await handle.close();
		try {
			await lstat(destination);
			throw new Error("restore destination already exists");
		} catch (error) {
			if (!isErrorCode(error, "ENOENT")) throw error;
		}
		await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
		await rename(session.sessionFile, destination);
	});
}

export async function destroySessionSnapshots(agentDir: string, cwd: string, sessionId: string): Promise<number> {
	void cwd;
	const loaded = await loadGlobalConfig(join(resolve(agentDir), "config.yaml"));
	return purgeSessionSnapshotsAcrossTrackers(agentDir, sessionId, loaded.config.tracking);
}

export interface SessionDeleteResult {
	readonly sessionId: string;
	readonly profile: "coding" | "chat";
	readonly snapshotsRemoved: number;
}

/** Permanently delete one persisted session (engine-free storage side; the
 *  daemon closes any live engine child before calling this). Same safety
 *  ladder as archive cleanup: writer lock, legacy-lease check, confinement
 *  to a managed root, subagent storage, snapshots, then the transcript. */
export async function deletePersistedSession(
	sessionId: string,
	agentDir = getAgentDir(),
): Promise<SessionDeleteResult> {
	const page = await listPersistedSessions({ agentDir, includeArchived: true, limit: MAX_LIST_LIMIT });
	const matches = page.sessions.filter((session) => session.id === sessionId);
	if (matches.length !== 1) throw new Error(matches.length === 0 ? `Session not found: ${sessionId}` : `Session identity is ambiguous: ${sessionId}`);
	const session = matches[0]!;
	const roots = resolveSessionRoots(agentDir);
	const chat = resolveChatPaths(agentDir);
	const containing = [roots.sessionsRoot, roots.archiveRoot, chat.activeHistory, chat.archiveHistory].find(
		(candidate) => isContained(resolve(session.sessionFile), resolve(candidate)),
	);
	if (!containing) throw new Error("Session file escapes its managed roots");
	await withStoredSessionLock(session.sessionFile, async () => {
		await assertNoLegacyLease(session.sessionFile);
		const handle = await openSafeSessionFile(session.sessionFile, containing);
		await handle.close();
		await removeSubagentParentStorage(agentDir, session.id);
		await rm(session.sessionFile);
		disposeHandoffNote(session.sessionFile);
	});
	const snapshotsRemoved = await destroySessionSnapshots(agentDir, session.cwd, session.id).catch(() => 0);
	clearDaemonServiceCache();
	return { sessionId, profile: session.profile, snapshotsRemoved };
}

export async function setPersistedSessionArchived(
	sessionId: string,
	archived: boolean,
	agentDir = getAgentDir(),
): Promise<SessionArchiveResult> {
	const page = await listPersistedSessions({ agentDir, includeArchived: true, limit: MAX_LIST_LIMIT });
	const matches = page.sessions.filter((session) => session.id === sessionId);
	if (matches.length !== 1) throw new Error(matches.length === 0 ? `Session not found: ${sessionId}` : `Session identity is ambiguous: ${sessionId}`);
	const session = matches[0]!;
	if (session.archived === archived) {
		const snapshotsRemoved = archived ? await destroySessionSnapshots(agentDir, session.cwd, session.id) : 0;
		return { sessionId, archived, profile: session.profile, snapshotsRemoved };
	}
	if (session.profile === "chat") {
		if (archived) await archiveChat(sessionId, resolveChatPaths(agentDir));
		else await restoreChat(sessionId, resolveChatPaths(agentDir));
	} else {
		const roots = resolveSessionRoots(agentDir);
		if (archived) {
			const move = await archiveStoredSession(session, roots, agentDir);
			// An archived session will never compact again; its handoff note
			// (which lives next to the ACTIVE-root file) would just be orphaned.
			disposeHandoffNote(session.sessionFile);
			clearDaemonServiceCache();
			return { sessionId, archived, profile: session.profile, snapshotsRemoved: move.snapshotsRemoved ?? 0 };
		}
		else await restoreStoredSession(session, roots);
	}
	const snapshotsRemoved = archived ? await destroySessionSnapshots(agentDir, session.cwd, session.id) : 0;
	clearDaemonServiceCache();
	return { sessionId, archived, profile: session.profile, snapshotsRemoved };
}

async function withStoredSessionLock<T>(sessionFile: string, operation: () => Promise<T>): Promise<T> {
	let release: (() => Promise<void>) | undefined;
	try {
		release = await lockfile.lock(sessionFile, {
			realpath: false,
			lockfilePath: `${sessionFile}.lock`,
			stale: SESSION_LOCK_STALE_MS,
			update: SESSION_LOCK_UPDATE_MS,
			retries: 0,
		});
		return await operation();
	} catch (error) {
		if (isErrorCode(error, "ELOCKED")) throw new Error("session has an active writer lock");
		throw error;
	} finally {
		await release?.().catch(() => undefined);
	}
}

async function assertNoLegacyLease(sessionFile: string): Promise<void> {
	try {
		await lstat(`${sessionFile}.lease`);
		throw new Error("session has a legacy or external writer lease");
	} catch (error) {
		if (!isErrorCode(error, "ENOENT")) throw error;
	}
}

async function collectSessionFiles(root: string, directory: string, depth: number, files: string[]): Promise<void> {
	if (depth > MAX_SCAN_DEPTH || files.length >= MAX_DISCOVERED_FILES) return;
	let entries;
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (files.length >= MAX_DISCOVERED_FILES) break;
		if (entry.isSymbolicLink()) continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) await collectSessionFiles(root, path, depth + 1, files);
		else if (entry.isFile() && entry.name.endsWith(".jsonl") && isContained(path, root)) files.push(resolve(path));
	}
}

async function summarizeSessionFile(file: string, root: string, archived: boolean, profile: "coding" | "chat" = "coding"): Promise<PersistedSessionSummary | undefined> {
	let handle;
	try {
		handle = await openSafeSessionFile(file, root);
		const stats = await handle.stat();
		let header: Record<string, unknown> | undefined;
		let name: string | undefined;
		let firstUserText = "";
		let entryCount = 0;
		let lastActivity: number | undefined;
		let lastUsage: Usage | undefined;
		const input = handle.createReadStream({ encoding: "utf8", autoClose: false });
		const lines = createInterface({ input, crlfDelay: Infinity });
		for await (const line of lines) {
			if (!line.trim()) continue;
			let entry: unknown;
			try {
				entry = JSON.parse(line);
			} catch {
				break;
			}
			if (!header) {
				if (!isRecord(entry) || entry.type !== "session" || typeof entry.id !== "string") return undefined;
				header = entry;
				continue;
			}
			entryCount += 1;
			if (!isRecord(entry)) continue;
			if (entry.type === "session_info") name = typeof entry.name === "string" && entry.name.trim() ? compactText(entry.name, 200) : undefined;
			if (entry.type !== "message" || !isRecord(entry.message)) continue;
			const message = entry.message;
			if (message.role === "user" && !firstUserText) firstUserText = compactText(messageText(message.content), MAX_TEXT_CHARS);
			if (message.role === "assistant" && isUsage(message.usage)) lastUsage = message.usage;
			if (message.role === "user" || message.role === "assistant") {
				const timestamp = typeof message.timestamp === "number" ? message.timestamp : Date.parse(String(entry.timestamp ?? ""));
					if (Number.isFinite(timestamp)) lastActivity = Math.max(lastActivity ?? 0, timestamp);
			}
		}
		if (!header) return undefined;
		const createdAt = validIso(header.timestamp) ?? new Date(stats.birthtimeMs || stats.mtimeMs).toISOString();
		const modifiedTime = lastActivity ?? (Date.parse(createdAt) || stats.mtimeMs);
		return {
			id: String(header.id),
			sessionFile: await canonicalPath(file),
			cwd: typeof header.cwd === "string" ? await canonicalPath(header.cwd) : "",
			cwdExists: typeof header.cwd === "string" && existsSync(resolve(header.cwd)),
			profile,
			...(name ? { name } : {}),
			firstUserText,
			createdAt,
			modifiedAt: new Date(modifiedTime).toISOString(),
			mtimeMs: stats.mtimeMs,
			entryCount,
			schemaVersion: Number.isInteger(header.version) ? Number(header.version) : 1,
			archived,
			...(lastUsage ? { lastUsage } : {}),
		};
	} catch {
		return undefined;
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

async function openSafeSessionFile(file: string, root: string) {
	const resolvedFile = resolve(file);
	const resolvedRoot = resolve(root);
	if (!isContained(resolvedFile, resolvedRoot)) throw new Error("Session file escapes its managed root");
	const info = await lstat(resolvedFile);
	if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_SESSION_FILE_BYTES) throw new Error("Session file is unsafe or oversized");
	const rootReal = await realpath(resolvedRoot);
	const parentReal = await realpath(dirname(resolvedFile));
	if (!isContained(parentReal, rootReal)) throw new Error("Session parent escapes its managed root");
	const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
	const handle = await open(resolvedFile, constants.O_RDONLY | noFollow);
	const opened = await handle.stat();
	if (!opened.isFile() || opened.size > MAX_SESSION_FILE_BYTES) {
		await handle.close();
		throw new Error("Session file changed during validation");
	}
	return handle;
}

function resolveSessionRoots(agentDir = getAgentDir()): { sessionsRoot: string; archiveRoot: string } {
	let root = resolve(agentDir);
	try {
		root = realpathSync(root);
	} catch {
		// The profile may not exist yet; callers will observe empty roots.
	}
	return { sessionsRoot: join(root, "sessions"), archiveRoot: join(root, "session-archive") };
}

function serializeModel(model: Model<Api>): Record<string, unknown> {
	return {
		provider: model.provider,
		id: model.id,
		name: model.name,
		api: model.api,
		reasoning: model.reasoning,
		input: [...model.input],
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		...(model.cost ? { cost: model.cost } : {}),
	};
}

function sourceMetadata(source: SourceInfo): Record<string, string> {
	return {
		scope: source.scope,
		origin: source.origin,
		...(source.productClass ? { productClass: source.productClass } : {}),
	};
}

function productName(path: string): string | undefined {
	return /^<product:[^:>]+:([^>]+)>$/u.exec(path)?.[1];
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is Record<string, unknown> => isRecord(part) && part.type === "text")
		.map((part) => (typeof part.text === "string" ? part.text : ""))
		.join(" ");
}

function compactText(value: string, limit: number): string {
	const compact = value.replace(/\s+/gu, " ").trim();
	return compact.length <= limit ? compact : `${compact.slice(0, Math.max(0, limit - 1))}…`;
}

function isContained(path: string, root: string): boolean {
	const rel = relative(resolve(root), resolve(path));
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function boundedInteger(value: number | undefined, minimum: number, maximum: number, fallback: number): number {
	return Number.isInteger(value) && value! >= minimum && value! <= maximum ? value! : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUsage(value: unknown): value is Usage {
	return isRecord(value) && typeof value.input === "number" && typeof value.output === "number";
}

function validIso(value: unknown): string | undefined {
	if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return undefined;
	return new Date(value).toISOString();
}

function compareNewestSession(left: PersistedSessionSummary, right: PersistedSessionSummary): number {
	return (
		Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt) ||
		Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
		right.id.localeCompare(left.id)
	);
}

function compareOldestSession(left: PersistedSessionSummary, right: PersistedSessionSummary): number {
	return -compareNewestSession(left, right);
}

async function canonicalPath(path: string): Promise<string> {
	return canonicalizePath(resolve(path));
}

function textOnlyUserContent(content: unknown): boolean {
	if (typeof content === "string") return content.trim().length > 0;
	return Array.isArray(content) && content.length > 0 && content.every((part) => isRecord(part) && part.type === "text" && typeof part.text === "string");
}

function textOnlyAssistantContent(content: unknown): boolean {
	return Array.isArray(content) && content.length > 0 && content.every((part) =>
		isRecord(part) &&
		(part.type === "text" || part.type === "thinking") &&
		(part.type !== "text" || typeof part.text === "string"),
	);
}

function wordCount(value: string): number {
	return value.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

function boundedMessage(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/gu, " ").slice(0, 500);
}

function isErrorCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === code;
}
