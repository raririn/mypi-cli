import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import lockfile from "@bybrave/proper-lockfile2";
import { getAgentDir } from "../config.ts";
import { createAgentSessionServices, type AgentSessionServices } from "../core/agent-session-services.ts";
import type { SourceInfo } from "../core/source-info.ts";
import { loadGlobalConfig, type GlobalConfigDiagnostic, type HistoryConfig } from "./global-config.ts";

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

export interface PersistedSessionListOptions {
	readonly cwd?: string;
	readonly includeArchived?: boolean;
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

export interface ArchiveCleanupPreview {
	readonly cwd: string;
	readonly maxArchived: number;
	readonly archivedCount: number;
	readonly excess: number;
	readonly candidates: PersistedSessionSummary[];
	readonly configDiagnostic?: GlobalConfigDiagnostic;
}

export async function listPersistedSessions(options: PersistedSessionListOptions = {}): Promise<PersistedSessionPage> {
	const roots = resolveSessionRoots(options.agentDir);
	const active = await scanSessionRoot(roots.sessionsRoot, false);
	const archived = options.includeArchived ? await scanSessionRoot(roots.archiveRoot, true) : [];
	const cwd = options.cwd ? await canonicalPath(options.cwd) : undefined;
	const sessions = [...active, ...archived]
		.filter((session) => !cwd || session.cwd === cwd)
		.sort((left, right) => Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt));
	const offset = boundedInteger(options.offset, 0, Number.MAX_SAFE_INTEGER, 0);
	const limit = boundedInteger(options.limit, 1, MAX_LIST_LIMIT, DEFAULT_LIST_LIMIT);
	const page = sessions.slice(offset, offset + limit);
	return { sessions: page, offset, limit, total: sessions.length, hasMore: offset + page.length < sessions.length };
}

export async function readPersistedSession(options: PersistedSessionReadOptions): Promise<PersistedSessionReadResult> {
	if (!options.id && !options.sessionFile) throw new Error("read_session requires id or sessionFile");
	const roots = resolveSessionRoots(options.agentDir);
	const candidates = [
		...(await scanSessionRoot(roots.sessionsRoot, false)),
		...(options.includeArchived === false ? [] : await scanSessionRoot(roots.archiveRoot, true)),
	];
	const matches = candidates.filter((session) =>
		(options.id ? session.id === options.id : true) &&
		(options.sessionFile ? session.sessionFile === resolve(options.sessionFile) : true),
	);
	if (matches.length !== 1) throw new Error(matches.length === 0 ? "Persisted session was not found" : "Persisted session identity is ambiguous");
	const session = matches[0]!;
	const limit = boundedInteger(options.limit, 1, MAX_READ_LIMIT, DEFAULT_READ_LIMIT);
	const maxBytes = boundedInteger(options.maxBytes, 1_024, MAX_READ_BYTES, DEFAULT_READ_BYTES);
	const handle = await openSafeSessionFile(session.sessionFile, session.archived ? roots.archiveRoot : roots.sessionsRoot);
	const entries: unknown[] = [];
	let cursorSeen = options.since === undefined;
	let bytes = 0;
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
			if (entries.length >= limit || bytes + encodedBytes > maxBytes) {
				stopped = true;
				break;
			}
			entries.push(entry);
			bytes += encodedBytes;
			if (id) lastEntryId = id;
		}
	} finally {
		await handle.close();
	}
	if (!cursorSeen) throw new Error("read_session since cursor was not found");
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
	const page = await listPersistedSessions({
		agentDir: options.agentDir,
		includeArchived: options.includeArchived !== false,
		limit: MAX_LIST_LIMIT,
	});
	const matches = page.sessions.filter((session) =>
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
	const services = await daemonServices(cwd, agentDir);
	return services.modelRuntime.getAvailableSnapshot().map(serializeModel);
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
	const currentFile = resolve(options.sessionFile);

	if (config.autoArchive) {
		const initial = (await scanSessionRoot(roots.sessionsRoot, false))
			.filter((session) => session.cwd === cwd && session.sessionFile !== currentFile)
			.sort((left, right) => Date.parse(left.modifiedAt) - Date.parse(right.modifiedAt));
		for (const session of initial) {
			if (!(await isObviousShortTest(session, roots.sessionsRoot, config.shortTestMaxWords))) continue;
			try {
				archivedShortTests.push(await archiveStoredSession(session, roots));
			} catch (error) {
				skipped.push({ id: session.id, reason: boundedMessage(error) });
			}
		}

		const remaining = (await scanSessionRoot(roots.sessionsRoot, false))
			.filter((session) => session.cwd === cwd && session.sessionFile !== currentFile)
			.sort((left, right) => Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt));
		// The current new session consumes one slot even if its header has not yet
		// appeared in a concurrent scan.
		const overflow = remaining.slice(Math.max(0, config.maxActive - 1));
		for (const session of overflow.reverse()) {
			try {
				archivedOverflow.push(await archiveStoredSession(session, roots));
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
		.sort((left, right) => Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt));
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
				await rm(session.sessionFile);
			});
			deleted.push(session.id);
		} catch (error) {
			failures.push({ id: session.id, reason: boundedMessage(error) });
		}
	}
	return { deleted, failures: failures.slice(0, 20), preview };
}

async function daemonServices(cwd: string, agentDir: string): Promise<AgentSessionServices> {
	const key = `${resolve(agentDir)}\0${resolve(cwd)}`;
	let pending = serviceCache.get(key);
	if (!pending) {
		pending = createAgentSessionServices({ cwd, agentDir, productProfile: "coding" });
		serviceCache.set(key, pending);
		pending.catch(() => serviceCache.delete(key));
	}
	return pending;
}

async function scanSessionRoot(root: string, archived: boolean): Promise<PersistedSessionSummary[]> {
	const files: string[] = [];
	await collectSessionFiles(root, root, 0, files);
	const sessions: PersistedSessionSummary[] = [];
	for (let index = 0; index < files.length; index += 8) {
		const page = await Promise.all(files.slice(index, index + 8).map((file) => summarizeSessionFile(file, root, archived)));
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

async function archiveStoredSession(
	session: PersistedSessionSummary,
	roots: { sessionsRoot: string; archiveRoot: string },
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
		await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
		await rename(session.sessionFile, destination);
	});
	return { id: session.id, from: session.sessionFile, to: destination };
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
		if (files.length >= MAX_DISCOVERED_FILES || entry.isSymbolicLink()) break;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) await collectSessionFiles(root, path, depth + 1, files);
		else if (entry.isFile() && entry.name.endsWith(".jsonl") && isContained(path, root)) files.push(resolve(path));
	}
}

async function summarizeSessionFile(file: string, root: string, archived: boolean): Promise<PersistedSessionSummary | undefined> {
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
			sessionFile: resolve(file),
			cwd: typeof header.cwd === "string" ? await canonicalPath(header.cwd) : "",
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
	const root = resolve(agentDir);
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

async function canonicalPath(path: string): Promise<string> {
	try {
		return await realpath(resolve(path));
	} catch {
		return resolve(path);
	}
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
