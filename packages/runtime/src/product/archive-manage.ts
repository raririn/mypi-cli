import { constants, existsSync, type Dirent } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, rm, rmdir, stat } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import lockfile from "@bybrave/proper-lockfile2";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "../core/extensions/types.ts";
import { type SessionInfo, SessionManager } from "../core/session-manager.ts";
import { removeSubagentParentStorage } from "../core/subagents/storage.ts";
import { compactPersistedSession } from "./daemon-services.ts";
import { loadGlobalConfig } from "./global-config.ts";
import { purgeSessionSnapshotsAcrossTrackers } from "./workspace-tracker.ts";

const TOOL_NAMES = [
	"session_archive_stats",
	"list_session_archives",
	"inspect_session_archive",
	"archive_session",
	"compact_session_history",
	"archive_sessions_older_than",
	"archive_sessions_with_max_user_messages",
	"restore_archived_session",
	"delete_archived_session",
	"delete_archived_sessions_older_than",
	"delete_orphaned_session",
] as const;
const TOOL_NAME_SET = new Set<string>(TOOL_NAMES);
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;
const MAX_PREVIEW_CHARS = 160;
const MAX_FAILURES_SHOWN = 20;
const HOUR_MS = 60 * 60 * 1000;
const SESSION_LOCK_STALE_MS = 30_000;
const SESSION_LOCK_UPDATE_MS = 10_000;
const STATE_SCHEMA = Type.Union([Type.Literal("active"), Type.Literal("archived"), Type.Literal("all")]);
const AGE_SCHEMA = Type.Number({
	minimum: 0.01,
	maximum: 876_000,
	description: "Strict age threshold in hours, measured from the session's last user/assistant activity",
});
const USER_MESSAGE_COUNT_SCHEMA = Type.Integer({
	minimum: 0,
	maximum: 1_000_000,
	description: "Maximum number of user-role messages on the session's current branch, inclusive",
});
const HELP = `# /archive-manage — manage MyPi session archives

## Syntax

/archive-manage
/archive-manage <request>
/archive-manage --help

## Examples

/archive-manage summarize my unarchived, archived, and writer-owned sessions
/archive-manage archive all unarchived sessions older than 12 hours
/archive-manage archive all sessions with at most 3 user messages
/archive-manage permanently delete archived sessions older than 24 hours
/archive-manage find archived sessions from this project
/archive-manage list orphaned sessions whose project folder is gone, then delete them

## Behavior and state lifetime

The command starts one agent turn with temporary archive-only tools. Broad inventory starts with compact counts. Listings are filterable and paginated (20 records by default), omit previews by default, and offer a separate one-session inspection tool. Dedicated bulk tools handle age-based archive, user-message-count archive, and delete requests without listing every matching session or making one tool call per session. All archive tools are removed when the agent turn ends.

Unarchived identifies JSONL storage under \`sessions/\`; writer ownership is a separate state reported from fresh atomic lock heartbeats, with live legacy lease-only owners identified during migration. Normal history discovery indexes \`sessions/\`, while archived JSONL files live in \`session-archive/\`.

## Safety boundaries

Archiving moves files and can be reversed. It preserves the current session and every session with an active atomic writer lock. Permanent deletion is restricted to files already under \`session-archive/\`, requires an explicit deletion request or confirmation from the user, and requires \`confirm: true\` in the tool call.

## Failure behavior and limitations

Bulk operations are best-effort rather than atomic: successful files remain changed if another match fails, and the result reports compact failure counts and IDs. Age uses the latest recorded user/assistant activity rather than the archive date. User-message thresholds count user-role entries on the current session branch. Ownership snapshots are observational; every mutation still acquires the authoritative lock. This command targets the local MyPi session store; connect to a remote host to manage its store.`;

type SessionState = "active" | "archived";
type RequestedState = SessionState | "all";

interface ArchivePaths {
	readonly agentDir: string;
	readonly sessionsRoot: string;
	readonly archiveRoot: string;
}

interface SessionRecord {
	readonly state: SessionState;
	readonly session: SessionInfo;
}

interface BulkFailure {
	readonly sessionId: string;
	readonly reason: string;
}

async function destroySessionSnapshots(agentDir: string, _cwd: string, sessionId: string): Promise<number> {
	const loaded = await loadGlobalConfig(join(agentDir, "config.yaml"));
	return purgeSessionSnapshotsAcrossTrackers(agentDir, sessionId, loaded.config.tracking);
}

type WriterState = "atomic-lock" | "legacy-lease" | "unlocked" | "stale-legacy-lease" | "unknown";

interface WriterStatus {
	readonly state: WriterState;
	readonly surface?: string;
	readonly pid?: number;
}

export default function archiveManageExtension(pi: ExtensionAPI): void {
	const paths = resolveArchivePaths();
	let active = false;
	let toolsBeforeArchiveManage: string[] | undefined;

	const restoreTools = (ctx?: ExtensionContext) => {
		active = false;
		if (toolsBeforeArchiveManage) pi.setActiveTools(toolsBeforeArchiveManage);
		else pi.setActiveTools(pi.getActiveTools().filter((name) => !TOOL_NAME_SET.has(name)));
		toolsBeforeArchiveManage = undefined;
		ctx?.ui.setStatus("archive-manage", undefined);
	};

	pi.registerTool({
		name: "session_archive_stats",
		label: "Session Archive Stats",
		description:
			"Return compact unarchived/archive storage counts and a separate writer-ownership snapshot, optionally including counts older than an age threshold. Prefer this over listing for broad inventory questions. Available only during /archive-manage.",
		promptSnippet: "Summarize stored and writer-owned MyPi session counts",
		parameters: Type.Object({
			older_than_hours: Type.Optional(AGE_SCHEMA),
		}),
		async execute(_toolCallId, params) {
			assertArchiveMode(active);
			const records = await loadSessionRecords(paths, "all");
			const hours = params.older_than_hours;
			const cutoff = hours === undefined ? undefined : ageCutoff(hours);
			const unarchivedSessions = records.filter((record) => record.state === "active");
			const archivedSessions = records.filter((record) => record.state === "archived");
			const writerStatuses = await Promise.all(
				unarchivedSessions.map((record) => inspectWriterStatus(record.session.path)),
			);
			const atomicLocks = writerStatuses.filter((status) => status.state === "atomic-lock").length;
			const legacyLeases = writerStatuses.filter((status) => status.state === "legacy-lease").length;
			const unknownWriters = writerStatuses.filter((status) => status.state === "unknown").length;
			const format = (label: string, sessions: readonly SessionRecord[]) => {
				if (cutoff === undefined) return `${label}: ${sessions.length}`;
				const old = sessions.filter((record) => record.session.modified.getTime() < cutoff).length;
				return `${label}: ${sessions.length} total; ${old} older than ${formatHours(hours!)}h`;
			};
			const text = [
				format("Unarchived stored", unarchivedSessions),
				format("Archived stored", archivedSessions),
				`Writer-protected unarchived now: ${atomicLocks + legacyLeases + unknownWriters} (atomic locks ${atomicLocks}; live/foreign legacy leases ${legacyLeases}; unknown ${unknownWriters})`,
			].join("\n");
			return textResult(text, {
				active: unarchivedSessions.length,
				unarchived: unarchivedSessions.length,
				archived: archivedSessions.length,
				writerLocked: atomicLocks,
				legacyWriterLeased: legacyLeases,
				writerUnknown: unknownWriters,
				olderThanHours: hours,
				cutoff: cutoff === undefined ? undefined : new Date(cutoff).toISOString(),
			});
		},
	});

	pi.registerTool({
		name: "list_session_archives",
		label: "List Session Archives",
		description: `List compact MyPi session metadata with storage-state/age filters, current-branch user-message counts, writer state, and offset pagination. The active filter selects unarchived storage; writerState reports process ownership. Returns at most ${MAX_LIST_LIMIT} records and omits previews by default. Available only during /archive-manage.`,
		promptSnippet: "List a bounded page of filtered MyPi sessions",
		parameters: Type.Object({
			state: Type.Optional(STATE_SCHEMA),
			older_than_hours: Type.Optional(AGE_SCHEMA),
			offset: Type.Optional(
				Type.Integer({ minimum: 0, description: "Zero-based offset into the filtered newest-first results" }),
			),
			limit: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: MAX_LIST_LIMIT,
					description: `Maximum records to return; defaults to ${DEFAULT_LIST_LIMIT}`,
				}),
			),
			include_preview: Type.Optional(
				Type.Boolean({
					description: `Include a normalized first-message preview capped at ${MAX_PREVIEW_CHARS} characters`,
				}),
			),
			orphaned_only: Type.Optional(
				Type.Boolean({
					description: "Only sessions whose recorded project folder no longer exists on this host",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			assertArchiveMode(active);
			const state = (params.state ?? "all") as RequestedState;
			const cutoff = params.older_than_hours === undefined ? undefined : ageCutoff(params.older_than_hours);
			const records = (await loadSessionRecords(paths, state)).filter(
				(record) =>
					(cutoff === undefined || record.session.modified.getTime() < cutoff) &&
					(!params.orphaned_only || !existsSync(record.session.cwd)),
			);
			const offset = params.offset ?? 0;
			const limit = params.limit ?? DEFAULT_LIST_LIMIT;
			const page = records.slice(offset, offset + limit);
			return textResult(await formatSessionListing(records, page, offset, Boolean(params.include_preview)), {
				total: records.length,
				offset,
				limit,
				returned: page.length,
				hasMore: offset + page.length < records.length,
			});
		},
	});

	pi.registerTool({
		name: "inspect_session_archive",
		label: "Inspect Session Archive",
		description:
			"Inspect one unarchived or archived session by exact ID, including its bounded preview, total message count, current-branch user-message count, and writer state. Use only after a compact listing identifies a session needing detail. Available only during /archive-manage.",
		promptSnippet: "Inspect one MyPi session's archive metadata",
		parameters: Type.Object({
			session_id: Type.String({ minLength: 1, description: "Exact session ID returned by list_session_archives" }),
			state: Type.Optional(STATE_SCHEMA),
		}),
		async execute(_toolCallId, params) {
			assertArchiveMode(active);
			const record = requireUniqueRecord(
				await loadSessionRecords(paths, (params.state ?? "all") as RequestedState),
				params.session_id,
			);
			const session = record.session;
			const [userMessageCount, writerStatus] = await Promise.all([
				countCurrentBranchUserMessages(session.path),
				inspectWriterStatus(session.path),
			]);
			const metadata = {
				storageState: storageStateLabel(record.state),
				sessionId: session.id,
				name: session.name ?? undefined,
				cwd: session.cwd,
				createdAt: session.created.toISOString(),
				modifiedAt: session.modified.toISOString(),
				messageCount: session.messageCount,
				userMessageCount,
				...writerStatusMetadata(writerStatus),
				preview: compactText(session.firstMessage, 1_000),
			};
			return textResult(JSON.stringify(metadata), metadata);
		},
	});

	pi.registerTool({
		name: "archive_session",
		label: "Archive Session",
		description:
			"Move one unarchived, non-writer-owned MyPi session out of normal history discovery into the archive. Available only during /archive-manage.",
		promptSnippet: "Archive one unarchived MyPi session",
		parameters: Type.Object({
			session_id: Type.String({
				minLength: 1,
				description: "Exact unarchived session ID returned by list_session_archives",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			assertArchiveMode(active);
			const session = requireUniqueSession(
				await listStoredSessions(paths.sessionsRoot),
				params.session_id,
				"active",
			);
			assertNotCurrentSession(session, ctx);
			return withSessionWriterLock(session.path, async () => {
				const destination = archivedPathFor(session.path, paths);
				await moveFile(session.path, destination);
				const snapshotsRemoved = await destroySessionSnapshots(paths.agentDir, session.cwd, session.id);
				return textResult(`Archived unarchived session ${session.id}.`, {
					sessionId: session.id,
					from: session.path,
					to: destination,
					snapshotsRemoved,
				});
			});
		},
	});

	pi.registerTool({
		name: "compact_session_history",
		label: "Compact Session History",
		description:
			"Rewrite one non-writer-owned session's transcript, dropping superseded state snapshots (last copy per branch is kept; messages and events are untouched). Refuses live sessions; the rewrite is verified before replacing the file. Available only during /archive-manage.",
		promptSnippet: "Compact one MyPi session's transcript",
		parameters: Type.Object({
			session_id: Type.String({
				minLength: 1,
				description: "Exact session ID returned by list_session_archives",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			assertArchiveMode(active);
			const all = [
				...(await listStoredSessions(paths.sessionsRoot)),
				...(await listStoredSessions(paths.archiveRoot)),
			];
			const session = requireUniqueSession(all, params.session_id, "any");
			assertNotCurrentSession(session, ctx);
			const result = await compactPersistedSession(session.id, paths.agentDir);
			return textResult(
				result.compacted
					? `Compacted session ${session.id}: removed ${result.removedEntries} superseded snapshots (${result.bytesBefore} → ${result.bytesAfter} bytes).`
					: `Session ${session.id} had nothing to compact.`,
				{ ...result },
			);
		},
	});

	pi.registerTool({
		name: "archive_sessions_older_than",
		label: "Archive Sessions Older Than",
		description:
			"Bulk-archive unarchived sessions whose last activity is strictly older than the requested number of hours. The current and writer-protected sessions are skipped. This avoids listing or calling archive_session once per match. Available only during /archive-manage.",
		promptSnippet: "Bulk-archive unarchived MyPi sessions by last-activity age",
		parameters: Type.Object({ older_than_hours: AGE_SCHEMA }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			assertArchiveMode(active);
			const cutoff = ageCutoff(params.older_than_hours);
			const candidates = (await listStoredSessions(paths.sessionsRoot)).filter(
				(session) => session.modified.getTime() < cutoff,
			);
			const failures: BulkFailure[] = [];
			let archived = 0;
			for (const session of candidates) {
				try {
					assertNotCurrentSession(session, ctx);
					await withSessionWriterLock(session.path, async () => {
						await moveFile(session.path, archivedPathFor(session.path, paths));
						await destroySessionSnapshots(paths.agentDir, session.cwd, session.id);
						archived++;
					});
				} catch (error) {
					failures.push({ sessionId: session.id, reason: compactError(error) });
				}
			}
			return bulkResult("Archived", archived, candidates.length, params.older_than_hours, cutoff, failures);
		},
	});

	pi.registerTool({
		name: "archive_sessions_with_max_user_messages",
		label: "Archive Sessions With Max User Messages",
		description:
			"Bulk-archive every unarchived session whose current branch has at most the requested number of user-role messages. The current and writer-protected sessions are skipped. Use this directly instead of listing and issuing one archive call per match. Available only during /archive-manage.",
		promptSnippet: "Bulk-archive unarchived MyPi sessions by current-branch user-message count",
		parameters: Type.Object({ max_user_messages: USER_MESSAGE_COUNT_SCHEMA }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			assertArchiveMode(active);
			const sessions = await listStoredSessions(paths.sessionsRoot);
			const candidates: SessionInfo[] = [];
			const failures: BulkFailure[] = [];
			for (const session of sessions) {
				try {
					if ((await countCurrentBranchUserMessages(session.path)) <= params.max_user_messages)
						candidates.push(session);
				} catch (error) {
					failures.push({
						sessionId: session.id,
						reason: `could not count user messages: ${compactError(error)}`,
					});
				}
			}

			let archived = 0;
			for (const session of candidates) {
				try {
					assertNotCurrentSession(session, ctx);
					await withSessionWriterLock(session.path, async () => {
						await moveFile(session.path, archivedPathFor(session.path, paths));
						await destroySessionSnapshots(paths.agentDir, session.cwd, session.id);
						archived++;
					});
				} catch (error) {
					failures.push({ sessionId: session.id, reason: compactError(error) });
				}
			}
			return userCountBulkResult(archived, candidates.length, sessions.length, params.max_user_messages, failures);
		},
	});

	pi.registerTool({
		name: "restore_archived_session",
		label: "Restore Archived Session",
		description:
			"Return one archived MyPi session to its original active history folder. Available only during /archive-manage.",
		promptSnippet: "Restore one archived MyPi session",
		parameters: Type.Object({
			session_id: Type.String({
				minLength: 1,
				description: "Exact archived session ID returned by list_session_archives",
			}),
		}),
		async execute(_toolCallId, params) {
			assertArchiveMode(active);
			const session = requireUniqueSession(
				await listStoredSessions(paths.archiveRoot),
				params.session_id,
				"archived",
			);
			return withSessionWriterLock(session.path, async () => {
				const destination = restoredPathFor(session.path, paths);
				await moveFile(session.path, destination);
				await removeEmptyParent(session.path, paths.archiveRoot);
				return textResult(`Restored archived session ${session.id}.`, {
					sessionId: session.id,
					from: session.path,
					to: destination,
				});
			});
		},
	});

	pi.registerTool({
		name: "delete_archived_session",
		label: "Delete Archived Session",
		description:
			"Permanently remove one session that is already archived. This cannot delete active history and requires explicit user confirmation. Available only during /archive-manage.",
		promptSnippet: "Permanently delete one archived MyPi session",
		parameters: Type.Object({
			session_id: Type.String({
				minLength: 1,
				description: "Exact archived session ID returned by list_session_archives",
			}),
			confirm: Type.Literal(true, {
				description: "Must be true only after the user explicitly requests or confirms permanent deletion",
			}),
		}),
		async execute(_toolCallId, params) {
			assertArchiveMode(active);
			if (params.confirm !== true) throw new Error("Permanent deletion requires confirm=true.");
			const session = requireUniqueSession(
				await listStoredSessions(paths.archiveRoot),
				params.session_id,
				"archived",
			);
			assertContained(session.path, paths.archiveRoot, "archive");
			return withSessionWriterLock(session.path, async () => {
				await removeSubagentParentStorage(dirname(paths.sessionsRoot), session.id);
				await rm(session.path);
				await removeEmptyParent(session.path, paths.archiveRoot);
				return textResult(`Permanently deleted archived session ${session.id}.`, { sessionId: session.id });
			});
		},
	});

	pi.registerTool({
		name: "delete_archived_sessions_older_than",
		label: "Delete Archived Sessions Older Than",
		description:
			"Permanently delete all already-archived sessions whose last activity is strictly older than the requested number of hours. Requires an explicit user deletion request or confirmation and confirm=true. Available only during /archive-manage.",
		promptSnippet: "Permanently delete archived MyPi sessions by last-activity age",
		parameters: Type.Object({
			older_than_hours: AGE_SCHEMA,
			confirm: Type.Literal(true, {
				description:
					"Must be true only after the user explicitly requests or confirms this bulk permanent deletion",
			}),
		}),
		async execute(_toolCallId, params) {
			assertArchiveMode(active);
			if (params.confirm !== true) throw new Error("Bulk permanent deletion requires confirm=true.");
			const cutoff = ageCutoff(params.older_than_hours);
			const candidates = (await listStoredSessions(paths.archiveRoot)).filter(
				(session) => session.modified.getTime() < cutoff,
			);
			const failures: BulkFailure[] = [];
			let deleted = 0;
			for (const session of candidates) {
				try {
					assertContained(session.path, paths.archiveRoot, "archive");
					await withSessionWriterLock(session.path, async () => {
						await removeSubagentParentStorage(dirname(paths.sessionsRoot), session.id);
						await rm(session.path);
						await removeEmptyParent(session.path, paths.archiveRoot);
						deleted++;
					});
				} catch (error) {
					failures.push({ sessionId: session.id, reason: compactError(error) });
				}
			}
			return bulkResult(
				"Permanently deleted",
				deleted,
				candidates.length,
				params.older_than_hours,
				cutoff,
				failures,
			);
		},
	});

	pi.registerTool({
		name: "delete_orphaned_session",
		label: "Delete Orphaned Session",
		description:
			"Permanently remove one session (active or archived) whose recorded project folder no longer exists on this host. Refuses when the folder still exists — use list_session_archives with orphaned_only to find candidates. Requires explicit user confirmation. Available only during /archive-manage.",
		promptSnippet: "Permanently delete one orphaned MyPi session",
		parameters: Type.Object({
			session_id: Type.String({
				minLength: 1,
				description: "Exact session ID returned by list_session_archives with orphaned_only=true",
			}),
			confirm: Type.Literal(true, {
				description: "Must be true only after the user explicitly requests or confirms permanent deletion",
			}),
		}),
		async execute(_toolCallId, params) {
			assertArchiveMode(active);
			if (params.confirm !== true) throw new Error("Permanent deletion requires confirm=true.");
			const record = requireUniqueRecord(await loadSessionRecords(paths, "all"), params.session_id);
			const session = record.session;
			if (existsSync(session.cwd)) {
				throw new Error(
					`Session ${session.id} is not orphaned: its project folder still exists at ${session.cwd}. Use archive_session or delete_archived_session instead.`,
				);
			}
			const storageRoot = record.state === "archived" ? paths.archiveRoot : paths.sessionsRoot;
			assertContained(session.path, storageRoot, record.state === "archived" ? "archive" : "session storage");
			return withSessionWriterLock(session.path, async () => {
				await removeSubagentParentStorage(dirname(paths.sessionsRoot), session.id);
				await rm(session.path);
				await removeEmptyParent(session.path, storageRoot);
				return textResult(
					`Permanently deleted orphaned ${record.state} session ${session.id} (project folder ${session.cwd} is gone).`,
					{ sessionId: session.id, state: record.state, cwd: session.cwd },
				);
			});
		},
	});

	const handleCommand = async (args: string, ctx: ExtensionContext) => {
		const request = args.trim();
		if (request === "--help" || request === "help") {
			await ctx.ui.editor("Archive management help", HELP);
			return;
		}
		if (!ctx.isIdle()) {
			ctx.ui.notify("The agent is busy; wait for it to finish before starting /archive-manage.", "warning");
			return;
		}
		toolsBeforeArchiveManage = pi.getActiveTools().filter((name) => !TOOL_NAME_SET.has(name));
		pi.setActiveTools([...toolsBeforeArchiveManage, ...TOOL_NAMES]);
		active = true;
		ctx.ui.setStatus("archive-manage", "ARCHIVE MANAGE");
		pi.sendUserMessage(
			request ||
				"Summarize my unarchived, archived, and currently writer-protected sessions, then help me decide whether to archive, restore, or permanently remove any of them. Ask before permanent deletion.",
		);
	};

	pi.registerCommand("archive-manage", {
		description: "Manage session archives with compact, temporary agent tools",
		handler: handleCommand,
	});

	pi.on("input", async (event, ctx) => {
		if (event.source !== "extension") return undefined;
		const match = event.text.trim().match(/^\/archive-manage(?:\s+([\s\S]*))?$/i);
		if (!match) return undefined;
		await handleCommand(match[1] ?? "", ctx);
		return { action: "handled" };
	});
	pi.on("tool_call", (event) => {
		if (TOOL_NAME_SET.has(event.toolName) && !active) {
			return { block: true, reason: `${event.toolName} is only available during /archive-manage.` };
		}
		return undefined;
	});
	pi.on("before_agent_start", (event) => {
		if (!active) {
			const currentTools = pi.getActiveTools();
			if (currentTools.some((name) => TOOL_NAME_SET.has(name))) {
				pi.setActiveTools(currentTools.filter((name) => !TOOL_NAME_SET.has(name)));
			}
			return undefined;
		}
		return {
			systemPrompt: `${event.systemPrompt}\n\n[ARCHIVE MANAGEMENT ACTIVE]\nUse the temporary archive tools for session-history changes. Treat active as the backward-compatible filter name for unarchived storage and use writerState or session_archive_stats for ownership. Prefer session_archive_stats for broad inventory. Keep listings filtered and paginated; previews are opt-in, and inspect_session_archive is for one record. For age-based or user-message-count bulk requests, call the matching dedicated bulk tool directly instead of listing every match or issuing per-session calls. Permanent deletion requires an explicit user request or confirmation and confirm=true. Preserve the session running this command.`,
		};
	});
	pi.on("agent_end", (_event, ctx) => restoreTools(ctx));
	pi.on("session_start", (_event, ctx) => restoreTools(ctx));
	pi.on("session_shutdown", () => restoreTools());

	// Custom tools are active by default after registration. Deactivate them from
	// session_start, once Pi has initialized the extension runtime; action methods
	// such as getActiveTools/setActiveTools are not valid during extension loading.
}

function resolveArchivePaths(): ArchivePaths {
	const configuredAgentDir = process.env.MYPI_AGENT_DIR || process.env.MYPI_CODING_AGENT_DIR;
	const agentDir = resolve(configuredAgentDir || join(homedir(), ".mypi", "agent"));
	const sessionsRoot = resolve(join(agentDir, "sessions"));
	return { agentDir, sessionsRoot, archiveRoot: join(dirname(sessionsRoot), "session-archive") };
}

async function loadSessionRecords(paths: ArchivePaths, state: RequestedState): Promise<SessionRecord[]> {
	const [activeSessions, archivedSessions] = await Promise.all([
		state === "archived" ? Promise.resolve([]) : listStoredSessions(paths.sessionsRoot),
		state === "active" ? Promise.resolve([]) : listStoredSessions(paths.archiveRoot),
	]);
	return [
		...activeSessions.map((session): SessionRecord => ({ state: "active", session })),
		...archivedSessions.map((session): SessionRecord => ({ state: "archived", session })),
	].sort((left, right) => right.session.modified.getTime() - left.session.modified.getTime());
}

async function listStoredSessions(storageRoot: string): Promise<SessionInfo[]> {
	let entries: Dirent[];
	try {
		entries = await readdir(storageRoot, { withFileTypes: true });
	} catch (error) {
		if (isErrorCode(error, "ENOENT")) return [];
		throw error;
	}
	const groups = await Promise.all(
		entries
			.filter((entry) => entry.isDirectory())
			.map((entry) => SessionManager.listAll(join(storageRoot, entry.name))),
	);
	return groups.flat().sort((left, right) => right.modified.getTime() - left.modified.getTime());
}

async function formatSessionListing(
	matches: readonly SessionRecord[],
	page: readonly SessionRecord[],
	offset: number,
	includePreview: boolean,
): Promise<string> {
	if (matches.length === 0) return "No matching sessions found.";
	const unarchived = matches.filter((record) => record.state === "active").length;
	const archived = matches.length - unarchived;
	const first = page.length === 0 ? 0 : offset + 1;
	const last = offset + page.length;
	const hasMore = last < matches.length;
	const header = `Matched ${matches.length} stored sessions (unarchived ${unarchived}, archived ${archived}); showing ${first}-${last}.${hasMore ? ` Use offset=${last} for more.` : ""}`;
	const lines = await Promise.all(
		page.map(async ({ state, session }) => {
			const [userMessageCount, writerStatus] = await Promise.all([
				countCurrentBranchUserMessages(session.path),
				inspectWriterStatus(session.path),
			]);
			return JSON.stringify({
				storageState: storageStateLabel(state),
				sessionId: session.id,
				modifiedAt: session.modified.toISOString(),
				name: session.name ? compactText(session.name, 120) : undefined,
				cwd: compactText(session.cwd, 240),
				messageCount: session.messageCount,
				userMessageCount,
				...writerStatusMetadata(writerStatus),
				preview: includePreview ? compactText(session.firstMessage, MAX_PREVIEW_CHARS) : undefined,
			});
		}),
	);
	return [header, ...lines].join("\n");
}

function storageStateLabel(state: SessionState): "unarchived" | "archived" {
	return state === "active" ? "unarchived" : "archived";
}

function requireUniqueRecord(records: readonly SessionRecord[], sessionId: string): SessionRecord {
	const matches = records.filter((record) => record.session.id === sessionId);
	if (matches.length === 0)
		throw new Error(`No session found with ID ${sessionId}. Use list_session_archives with a narrow filter first.`);
	if (matches.length > 1)
		throw new Error(`Multiple session files have ID ${sessionId}; specify state or resolve the duplicate manually.`);
	return matches[0]!;
}

function requireUniqueSession(sessions: readonly SessionInfo[], sessionId: string, state: string): SessionInfo {
	const matches = sessions.filter((session) => session.id === sessionId);
	if (matches.length === 0)
		throw new Error(
			`No ${state} session found with ID ${sessionId}. Run list_session_archives with state=${state} first.`,
		);
	if (matches.length > 1)
		throw new Error(`Multiple ${state} session files have ID ${sessionId}; resolve the duplicate manually.`);
	return matches[0]!;
}

function assertNotCurrentSession(session: SessionInfo, ctx: ExtensionContext): void {
	const currentFile = ctx.sessionManager.getSessionFile();
	if (currentFile && resolve(currentFile) === resolve(session.path)) {
		throw new Error("current session");
	}
}

function ageCutoff(hours: number): number {
	if (!Number.isFinite(hours) || hours < 0.01 || hours > 876_000) {
		throw new Error("older_than_hours must be a finite number from 0.01 through 876000.");
	}
	return Date.now() - hours * HOUR_MS;
}

function formatHours(hours: number): string {
	return Number.isInteger(hours) ? String(hours) : String(Number(hours.toFixed(2)));
}

function bulkResult(
	verb: "Archived" | "Permanently deleted",
	completed: number,
	matched: number,
	hours: number,
	cutoff: number,
	failures: readonly BulkFailure[],
) {
	let text = `${verb} ${completed}/${matched} matching sessions older than ${formatHours(hours)}h (cutoff ${new Date(cutoff).toISOString()}).`;
	if (failures.length > 0) {
		const shown = failures.slice(0, MAX_FAILURES_SHOWN).map((failure) => `${failure.sessionId} (${failure.reason})`);
		text += `\nSkipped/failed ${failures.length}: ${shown.join("; ")}`;
		if (failures.length > shown.length) text += `; …and ${failures.length - shown.length} more`;
	}
	return textResult(text, {
		completed,
		matched,
		failed: failures.length,
		olderThanHours: hours,
		cutoff: new Date(cutoff).toISOString(),
		failures: failures.slice(0, MAX_FAILURES_SHOWN),
	});
}

function userCountBulkResult(
	completed: number,
	matched: number,
	scanned: number,
	maxUserMessages: number,
	failures: readonly BulkFailure[],
) {
	let text = `Archived ${completed}/${matched} matching unarchived sessions with at most ${maxUserMessages} user messages (scanned ${scanned}).`;
	if (failures.length > 0) {
		const shown = failures.slice(0, MAX_FAILURES_SHOWN).map((failure) => `${failure.sessionId} (${failure.reason})`);
		text += `\nSkipped/failed ${failures.length}: ${shown.join("; ")}`;
		if (failures.length > shown.length) text += `; …and ${failures.length - shown.length} more`;
	}
	return textResult(text, {
		completed,
		matched,
		scanned,
		failed: failures.length,
		maxUserMessages,
		failures: failures.slice(0, MAX_FAILURES_SHOWN),
	});
}

async function countCurrentBranchUserMessages(sessionFile: string): Promise<number> {
	const entries = new Map<string, { readonly parentId: string | null; readonly user: boolean }>();
	let leafId: string | undefined;
	for (const line of (await readFile(sessionFile, "utf8")).split("\n")) {
		if (!line.trim()) continue;
		const entry = JSON.parse(line) as {
			type?: unknown;
			id?: unknown;
			parentId?: unknown;
			message?: { role?: unknown };
		};
		const id = entry.id;
		if (entry.type === "session" || typeof id !== "string") continue;
		const parentId = entry.parentId;
		if (parentId !== null && typeof parentId !== "string") {
			throw new Error(`Session entry ${id} has an invalid parentId.`);
		}
		entries.set(id, {
			parentId: parentId as string | null,
			user: entry.type === "message" && entry.message?.role === "user",
		});
		leafId = id;
	}

	let count = 0;
	const visited = new Set<string>();
	while (leafId) {
		if (visited.has(leafId)) throw new Error(`Session branch contains a cycle at ${leafId}.`);
		visited.add(leafId);
		const entry = entries.get(leafId);
		if (!entry) throw new Error(`Session branch references missing entry ${leafId}.`);
		if (entry.user) count++;
		leafId = entry.parentId ?? undefined;
	}
	return count;
}

async function inspectWriterStatus(sessionFile: string): Promise<WriterStatus> {
	let locked: boolean;
	try {
		locked = await lockfile.check(sessionFile, {
			realpath: false,
			lockfilePath: `${sessionFile}.lock`,
			stale: SESSION_LOCK_STALE_MS,
		});
	} catch {
		return { state: "unknown" };
	}

	const legacy = await readLeaseForStatus(sessionFile);
	if (locked) {
		return legacy.state === "valid"
			? { state: "atomic-lock", surface: legacy.surface, pid: legacy.pid }
			: { state: "atomic-lock" };
	}
	if (legacy.state === "missing") return { state: "unlocked" };
	if (legacy.state === "invalid") return { state: "unknown" };
	if (legacy.hostname === hostname() && probePid(legacy.pid) === "dead") {
		return { state: "stale-legacy-lease", surface: legacy.surface, pid: legacy.pid };
	}
	return { state: "legacy-lease", surface: legacy.surface, pid: legacy.pid };
}

async function readLeaseForStatus(
	sessionFile: string,
): Promise<
	| { readonly state: "missing" }
	| { readonly state: "invalid" }
	| { readonly state: "valid"; readonly pid: number; readonly hostname: string; readonly surface: string }
> {
	let raw: string;
	try {
		raw = await readFile(`${sessionFile}.lease`, "utf8");
	} catch (error) {
		return isErrorCode(error, "ENOENT") ? { state: "missing" } : { state: "invalid" };
	}
	try {
		const parsed = JSON.parse(raw) as { pid?: unknown; hostname?: unknown; surface?: unknown };
		if (
			!Number.isInteger(parsed.pid) ||
			(parsed.pid as number) <= 0 ||
			typeof parsed.hostname !== "string" ||
			typeof parsed.surface !== "string"
		) {
			return { state: "invalid" };
		}
		return { state: "valid", pid: parsed.pid as number, hostname: parsed.hostname, surface: parsed.surface };
	} catch {
		return { state: "invalid" };
	}
}

function writerStatusMetadata(status: WriterStatus): Record<string, unknown> {
	return {
		writerState: status.state,
		writerSurface: status.surface,
		writerPid: status.pid,
	};
}

function compactText(text: string, maxChars: number): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxChars) return normalized;
	return `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

function compactError(error: unknown): string {
	return compactText(error instanceof Error ? error.message : String(error), 160);
}

function archivedPathFor(sessionFile: string, paths: ArchivePaths): string {
	const relativePath = assertContained(sessionFile, paths.sessionsRoot, "active session history");
	return join(paths.archiveRoot, relativePath);
}

function restoredPathFor(sessionFile: string, paths: ArchivePaths): string {
	const relativePath = assertContained(sessionFile, paths.archiveRoot, "archive");
	return join(paths.sessionsRoot, relativePath);
}

function assertContained(path: string, root: string, label: string): string {
	const relativePath = relative(resolve(root), resolve(path));
	if (
		!relativePath ||
		relativePath === ".." ||
		relativePath.startsWith("../") ||
		relativePath.startsWith("..\\") ||
		isAbsolute(relativePath)
	) {
		throw new Error(`Session file is outside MyPi's ${label}: ${path}`);
	}
	return relativePath;
}

async function moveFile(source: string, destination: string): Promise<void> {
	await mkdir(dirname(destination), { recursive: true });
	try {
		await stat(destination);
		throw new Error(`Refusing to overwrite existing session file: ${destination}`);
	} catch (error) {
		if (!isErrorCode(error, "ENOENT")) throw error;
	}
	try {
		await rename(source, destination);
	} catch (error) {
		if (!isErrorCode(error, "EXDEV")) throw error;
		await copyFile(source, destination, constants.COPYFILE_EXCL);
		await rm(source);
	}
}

async function clearDeadLegacyLease(sessionFile: string): Promise<void> {
	const leasePath = `${sessionFile}.lease`;
	let raw: string;
	try {
		raw = await readFile(leasePath, "utf8");
	} catch (error) {
		if (isErrorCode(error, "ENOENT")) return;
		throw new Error("session has an active writer lease: ownership could not be verified safely");
	}

	let lease: { pid: number; hostname: string; startedAt: string; surface: string };
	try {
		const parsed = JSON.parse(raw) as Partial<typeof lease>;
		if (
			!Number.isInteger(parsed.pid) ||
			parsed.pid! <= 0 ||
			typeof parsed.hostname !== "string" ||
			typeof parsed.startedAt !== "string" ||
			typeof parsed.surface !== "string"
		) {
			throw new Error("invalid lease");
		}
		lease = parsed as typeof lease;
	} catch {
		// Archive operations are destructive enough to fail closed when advisory
		// ownership data is malformed or cannot be understood.
		throw new Error("session has an active writer lease: ownership data is malformed");
	}

	// A foreign host cannot be probed safely. In particular, MyPi GUI leases do
	// not heartbeat, so age alone must never authorize a destructive mutation.
	if (lease.hostname !== hostname()) {
		throw new Error("session has an active writer lease from another host");
	}
	if (probePid(lease.pid) !== "dead") {
		throw new Error("session has an active writer lease: owner PID is live or unverifiable");
	}

	// Reduce the check/remove race: never remove a lease that changed ownership
	// after the PID probe. This is still advisory rather than a filesystem lock,
	// but it prevents deleting an observed replacement lease.
	let currentRaw: string;
	try {
		currentRaw = await readFile(leasePath, "utf8");
	} catch (error) {
		if (isErrorCode(error, "ENOENT")) return;
		throw new Error("session has an active writer lease: ownership could not be reverified safely");
	}
	if (currentRaw !== raw) {
		throw new Error("session has an active writer lease: ownership changed during archive validation");
	}
	await rm(leasePath);
}

async function withSessionWriterLock<T>(sessionFile: string, operation: () => Promise<T>): Promise<T> {
	let compromised: Error | undefined;
	let release: (() => Promise<void>) | undefined;
	try {
		release = await lockfile.lock(sessionFile, {
			realpath: false,
			lockfilePath: `${sessionFile}.lock`,
			stale: SESSION_LOCK_STALE_MS,
			update: SESSION_LOCK_UPDATE_MS,
			retries: 0,
			onCompromised: (error) => {
				compromised = error;
			},
		});
	} catch (error) {
		if (isErrorCode(error, "ELOCKED")) throw new Error("session has an active atomic writer lock");
		throw error;
	}

	try {
		await clearDeadLegacyLease(sessionFile);
		if (compromised) throw new Error(`session writer lock was compromised: ${compromised.message}`);
		return await operation();
	} finally {
		await release();
	}
}

function probePid(pid: number): "alive" | "dead" | "unknown" {
	try {
		process.kill(pid, 0);
		return "alive";
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return "dead";
		if (code === "EPERM") return "alive";
		return "unknown";
	}
}

async function removeEmptyParent(file: string, archiveRoot: string): Promise<void> {
	const parent = dirname(resolve(file));
	if (parent === resolve(archiveRoot)) return;
	try {
		await rmdir(parent);
	} catch {
		// Expected when other archives remain in the workspace directory.
	}
}

function assertArchiveMode(active: boolean): void {
	if (!active) throw new Error("Archive tools are only available during /archive-manage.");
}

function textResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

function isErrorCode(error: unknown, code: string): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === code);
}
