/**
 * MyPi durable compaction checkpoints.
 *
 * Model prose is useful for synthesis, but it is not an authority boundary.
 * This module owns deterministic evidence, canonical checkpoint validation,
 * the harness-authored continuation envelope, and sealed pre-compaction
 * session snapshots.
 */

import { createHash } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText, type Message, uuidv7 } from "@earendil-works/pi-ai";
import { getAgentDir } from "../../config.ts";
import type { FileEntry, SessionEntry } from "../session-manager.ts";
import { describeUserContent, serializeConversation } from "./utils.ts";

export const CHECKPOINT_VERSION = 2 as const;
export const RETAINED_RECENT_RAW_USER_MESSAGES = 3;
export const MAX_RETAINED_RAW_USER_MESSAGES = RETAINED_RECENT_RAW_USER_MESSAGES + 1;
const LEGACY_MAX_RETAINED_RAW_USER_MESSAGES = 5;
export const CHECKPOINT_START =
	"This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.";
export const CHECKPOINT_RESUME =
	'Continue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening, do not preface with "I\'ll continue" or similar. Pick up the last task as if the break never happened.';

const BACKUP_DIR_NAME = "compaction-backups";
const BACKUP_MAX_PER_SESSION = 20;
const RECALL_MAX_CHARS = 12_000;
const EVIDENCE_LINE_MAX_CHARS = 700;

export interface RetainedRawUserMessage {
	entryId: string;
	message: AgentMessage;
}

export function isRetainedRawUserMessages(
	value: unknown,
	maxMessages = MAX_RETAINED_RAW_USER_MESSAGES,
): value is RetainedRawUserMessage[] {
	if (!Array.isArray(value) || value.length > maxMessages) return false;
	const entryIds = new Set<string>();
	return value.every((item) => {
		if (
			!item ||
			typeof item !== "object" ||
			typeof item.entryId !== "string" ||
			!item.message ||
			typeof item.message !== "object" ||
			item.message.role !== "user" ||
			entryIds.has(item.entryId)
		) {
			return false;
		}
		entryIds.add(item.entryId);
		return true;
	});
}

export interface CheckpointBackupRef {
	checkpointId: string;
	sessionId: string;
	sourceBranchHeadId: string;
	sha256: string;
	bytes: number;
	createdAt: number;
}

export interface CheckpointUserEvidence {
	id: string;
	sha256: string;
	text: string;
}

export interface CheckpointToolEvidence {
	toolCallId: string;
	toolName: string;
	isError: boolean;
	diagnostic: string;
}

export interface CheckpointEvidence {
	userMessages: CheckpointUserEvidence[];
	toolResults: CheckpointToolEvidence[];
	readFiles: string[];
	modifiedFiles: string[];
}

export interface CheckpointValidation {
	valid: boolean;
	gaps: string[];
	deterministicRepairs: string[];
	generationAttempts: number;
	method: "single-pass" | "hierarchical" | "deterministic-fallback";
}

export interface CompactionCheckpointDetails {
	checkpointVersion: typeof CHECKPOINT_VERSION;
	checkpointId: string;
	backup?: CheckpointBackupRef;
	source: {
		firstSummarizedEntryId?: string;
		lastSummarizedEntryId?: string;
		firstKeptEntryId: string;
		sourceBranchHeadId: string;
	};
	retainedUserMessages: RetainedRawUserMessage[];
	evidence: CheckpointEvidence;
	validation: CheckpointValidation;
	readFiles: string[];
	modifiedFiles: string[];
}

export interface CheckpointRecallResult {
	text: string;
	matchedEntries: number;
	truncated: boolean;
	backupSha256: string;
}

const REQUIRED_HEADINGS = [
	"## Active Request",
	"## User Intent Ledger",
	"## Governing Constraints",
	"## Progress",
	"### Done",
	"### In Progress",
	"### Blocked",
	"## Working Set",
	"## Decisions and Error History",
	"## Open Loops",
	"## Handoff",
] as const;

function safeId(value: string): string {
	const safe = value.replace(/[^A-Za-z0-9._-]/g, "_").replace(/\.{2,}/g, "_").slice(0, 120);
	if (!safe || safe === "." || safe === "..") throw new Error("Invalid compaction checkpoint identifier");
	return safe;
}

function backupDirForSession(sessionId: string): string {
	return join(getAgentDir(), BACKUP_DIR_NAME, safeId(sessionId));
}

function backupFileFor(sessionId: string, checkpointId: string): string {
	return join(backupDirForSession(sessionId), `${safeId(checkpointId)}.jsonl`);
}

function manifestFileFor(sessionId: string, checkpointId: string): string {
	return join(backupDirForSession(sessionId), `${safeId(checkpointId)}.manifest.json`);
}

function atomicWrite(file: string, data: string | Buffer, mode: number): void {
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	chmodSync(dirname(file), 0o700);
	const tmp = join(dirname(file), `.${basename(file)}.${uuidv7()}.tmp`);
	const fd = openSync(tmp, "wx", mode);
	try {
		writeFileSync(fd, data);
	} finally {
		closeSync(fd);
	}
	chmodSync(tmp, mode);
	renameSync(tmp, file);
}

function pruneBackups(sessionId: string): void {
	const dir = backupDirForSession(sessionId);
	if (!existsSync(dir)) return;
	const manifests = readdirSync(dir)
		.filter((name) => name.endsWith(".manifest.json"))
		.map((name) => ({ name, mtime: statSync(join(dir, name)).mtimeMs }))
		.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
	for (const stale of manifests.slice(BACKUP_MAX_PER_SESSION)) {
		const checkpointId = stale.name.slice(0, -".manifest.json".length);
		for (const target of [join(dir, stale.name), join(dir, `${checkpointId}.jsonl`)]) {
			try {
				unlinkSync(target);
			} catch {
				// Another process or retention pass may already have removed it.
			}
		}
	}
}

/** Create a byte-exact, private snapshot before compaction changes context. */
export function backupSessionJsonl(input: {
	sessionFile: string | undefined;
	sessionId: string;
	sourceBranchHeadId: string | undefined;
}): CheckpointBackupRef | undefined {
	if (!input.sessionFile || !input.sourceBranchHeadId || !existsSync(input.sessionFile)) return undefined;
	const checkpointId = uuidv7();
	const bytes = readFileSync(input.sessionFile);
	if (bytes.length === 0) return undefined;
	const ref: CheckpointBackupRef = {
		checkpointId,
		sessionId: input.sessionId,
		sourceBranchHeadId: input.sourceBranchHeadId,
		sha256: createHash("sha256").update(bytes).digest("hex"),
		bytes: bytes.length,
		createdAt: Date.now(),
	};
	atomicWrite(backupFileFor(input.sessionId, checkpointId), bytes, 0o600);
	atomicWrite(
		manifestFileFor(input.sessionId, checkpointId),
		`${JSON.stringify({ schemaVersion: 1, ...ref, status: "pending" })}\n`,
		0o600,
	);
	pruneBackups(input.sessionId);
	return ref;
}

export function markBackupStatus(ref: CheckpointBackupRef | undefined, status: "applied" | "failed"): void {
	if (!ref) return;
	const manifest = manifestFileFor(ref.sessionId, ref.checkpointId);
	if (!existsSync(manifest)) return;
	atomicWrite(manifest, `${JSON.stringify({ schemaVersion: 1, ...ref, status })}\n`, 0o600);
}

function safeLine(value: string, maxChars = EVIDENCE_LINE_MAX_CHARS): string {
	const normalized = value
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^(?:(?:#{1,6}|[-*+]|>)\s+)+/, "");
	if (normalized.length <= maxChars) return normalized;
	const head = Math.ceil(maxChars * 0.6);
	const tail = maxChars - head;
	return `${normalized.slice(0, head)} [… ${normalized.length - maxChars} characters omitted …] ${normalized.slice(-tail)}`;
}

export function extractCheckpointEvidence(
	messages: Message[],
	readFiles: string[],
	modifiedFiles: string[],
): CheckpointEvidence {
	const userMessages: CheckpointUserEvidence[] = [];
	const toolResults: CheckpointToolEvidence[] = [];
	let userIndex = 0;
	for (const message of messages) {
		if (message.role === "user") {
			const text = describeUserContent(message.content);
			if (!text.trim()) continue;
			userIndex++;
			userMessages.push({
				id: `U${userIndex}`,
				sha256: createHash("sha256")
					.update(typeof message.content === "string" ? message.content : JSON.stringify(message.content))
					.digest("hex"),
				text: safeLine(text, 4_000),
			});
		} else if (message.role === "toolResult") {
			const text = contentText(message.content, "");
			if (!text.trim()) continue;
			toolResults.push({
				toolCallId: message.toolCallId,
				toolName: message.toolName,
				isError: message.isError,
				diagnostic: safeLine(text, message.isError ? 1_200 : 400),
			});
		}
	}
	return { userMessages, toolResults, readFiles, modifiedFiles };
}

function findSectionRange(summary: string, heading: string): { start: number; end: number } | undefined {
	const start = summary.indexOf(heading);
	if (start < 0) return undefined;
	const rest = summary.slice(start + heading.length);
	const match = rest.match(/\n##?\s+/);
	return { start, end: match ? start + heading.length + (match.index ?? rest.length) : summary.length };
}

function appendToSection(summary: string, heading: string, lines: string[]): string {
	if (lines.length === 0) return summary;
	const range = findSectionRange(summary, heading);
	if (!range) return `${summary.trim()}\n\n${heading}\n${lines.join("\n")}\n`;
	const before = summary.slice(0, range.end).trimEnd();
	const after = summary.slice(range.end);
	return `${before}\n${lines.join("\n")}${after}`;
}

export function verifyCheckpointSummary(summary: string, evidence: CheckpointEvidence): string[] {
	const gaps: string[] = [];
	if (summary.trimStart().split(/\r?\n/, 1)[0] !== "## Active Request") gaps.push("checkpoint-preamble");
	for (const match of summary.matchAll(/^(#{2,3}\s+.+?)\s*$/gm)) {
		if (!REQUIRED_HEADINGS.includes(match[1] as (typeof REQUIRED_HEADINGS)[number])) {
			gaps.push(`unexpected-heading:${match[1]}`);
		}
	}
	let previousHeadingIndex = -1;
	for (const heading of REQUIRED_HEADINGS) {
		const pattern = new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "gm");
		const matches = [...summary.matchAll(pattern)];
		if (matches.length === 0) {
			gaps.push(`missing-heading:${heading}`);
			continue;
		}
		if (matches.length > 1) gaps.push(`duplicate-heading:${heading}`);
		const headingIndex = matches[0].index ?? -1;
		if (headingIndex < previousHeadingIndex) gaps.push(`heading-order:${heading}`);
		previousHeadingIndex = Math.max(previousHeadingIndex, headingIndex);
	}
	for (const user of evidence.userMessages) {
		if (!summary.includes(`[${user.id}]`)) gaps.push(`missing-user:${user.id}`);
	}
	for (const file of evidence.modifiedFiles) {
		if (!summary.includes(file)) gaps.push(`missing-modified-file:${file}`);
	}
	for (const result of evidence.toolResults.filter((item) => item.isError)) {
		const diagnosticNeedle = result.diagnostic.slice(0, Math.min(120, result.diagnostic.length));
		if (diagnosticNeedle.length > 8 && !summary.includes(diagnosticNeedle)) {
			gaps.push(`missing-error:${result.toolName}#${result.toolCallId}`);
		}
	}
	const blocked = findSectionRange(summary, "### Blocked");
	if (evidence.toolResults.some((item) => item.isError) && blocked) {
		const blockedText = summary.slice(blocked.start, blocked.end);
		if (/\b(?:none|no blockers?)\b/i.test(blockedText)) gaps.push("blocked-contradicts-errors");
	}
	const handoff = findSectionRange(summary, "## Handoff");
	if (!handoff || !/^- Immediate next operation:\s*\S.+$/m.test(summary.slice(handoff.start, handoff.end))) {
		gaps.push("missing-immediate-next-operation");
	}
	return gaps;
}

/** Patch facts the harness can prove without asking another model. */
export function repairCheckpointSummary(
	summary: string,
	evidence: CheckpointEvidence,
): { summary: string; repairs: string[] } {
	let repaired = summary.trim();
	const repairs: string[] = [];
	for (const heading of REQUIRED_HEADINGS) {
		if (!repaired.includes(heading)) {
			repaired += `\n\n${heading}\n- None recorded.`;
			repairs.push(`inserted-heading:${heading}`);
		}
	}
	const missingUsers = evidence.userMessages.filter((user) => !repaired.includes(`[${user.id}]`));
	if (missingUsers.length > 0) {
		repaired = appendToSection(
			repaired,
			"## User Intent Ledger",
			missingUsers.map((user) => `- [${user.id}] ${safeLine(user.text)}`),
		);
		repairs.push(...missingUsers.map((user) => `inserted-user:${user.id}`));
	}
	const missingFiles = evidence.modifiedFiles.filter((file) => !repaired.includes(file));
	if (missingFiles.length > 0) {
		repaired = appendToSection(repaired, "## Working Set", missingFiles.map((file) => `- ${safeLine(file)}`));
		repairs.push(...missingFiles.map((file) => `inserted-modified-file:${file}`));
	}
	const missingErrors = evidence.toolResults.filter((item) => {
		if (!item.isError) return false;
		const needle = item.diagnostic.slice(0, Math.min(120, item.diagnostic.length));
		return needle.length > 8 && !repaired.includes(needle);
	});
	if (missingErrors.length > 0) {
		repaired = appendToSection(
			repaired,
			"### Blocked",
			missingErrors.map((item) => `- ${safeLine(item.toolName)}#${safeLine(item.toolCallId)}: ${item.diagnostic}`),
		);
		const blocked = findSectionRange(repaired, "### Blocked");
		if (blocked) {
			const blockedText = repaired
				.slice(blocked.start, blocked.end)
				.replace(/^- (?:None|No blockers?)[^\n]*\n?/gim, "");
			repaired = `${repaired.slice(0, blocked.start)}${blockedText}${repaired.slice(blocked.end)}`;
		}
		repaired = appendToSection(
			repaired,
			"## Decisions and Error History",
			missingErrors.map(
				(item) => `- **Unresolved ${safeLine(item.toolName)}#${safeLine(item.toolCallId)}** — ${item.diagnostic}`,
			),
		);
		repairs.push(...missingErrors.map((item) => `inserted-error:${item.toolName}#${item.toolCallId}`));
	}
	const handoff = findSectionRange(repaired, "## Handoff");
	if (!handoff || !/^- Immediate next operation:\s*\S.+$/m.test(repaired.slice(handoff.start, handoff.end))) {
		repaired = appendToSection(
			repaired,
			"## Handoff",
			["- Immediate next operation: Resume the latest controlling user request using the working set above."],
		);
		repairs.push("inserted-immediate-next-operation");
	}
	return { summary: `${repaired.trim()}\n`, repairs };
}

export function deterministicCheckpoint(evidence: CheckpointEvidence, _previousSummary?: string): string {
	const latestUser = evidence.userMessages.at(-1);
	const userLedger = evidence.userMessages.length
		? evidence.userMessages.map((user) => `- [${user.id}] ${safeLine(user.text)}`).join("\n")
		: "- None recorded.";
	const errors = evidence.toolResults.filter((item) => item.isError);
	return `## Active Request
- Primary goal: ${latestUser ? safeLine(latestUser.text) : "Continue the current task."}
- Latest controlling user mandate: ${latestUser ? safeLine(latestUser.text) : "Not recoverable from deterministic evidence."}
- Intended end state: Complete the latest user request without repeating verified work.

## User Intent Ledger
${userLedger}

## Governing Constraints
- Preserve user-authored requirements and current repository policy. Consult the source checkpoint before guessing.

## Progress
### Done
- [x] No completion is claimed by the deterministic fallback without explicit evidence.

### In Progress
- [ ] Resume the latest user request from the retained raw context and working set.

### Blocked
${errors.length ? errors.map((item) => `- ${item.toolName}#${item.toolCallId}: ${item.diagnostic}`).join("\n") : "- None mechanically identified."}

## Working Set
${[...evidence.modifiedFiles, ...evidence.readFiles].length ? [...evidence.modifiedFiles, ...evidence.readFiles].map((file) => `- ${safeLine(file)}`).join("\n") : "- None mechanically identified."}

## Decisions and Error History
${errors.length ? errors.map((item) => `- **Unresolved ${item.toolName}#${item.toolCallId}** — ${item.diagnostic}`).join("\n") : "- None mechanically identified."}

## Open Loops
- [high] Reconstruct any semantic detail missing from this safety checkpoint before changing state.

## Handoff
- Last completed operation: The prior context was mechanically extracted; model synthesis was unavailable or invalid.
- Immediate next operation: Inspect the retained raw messages and working set, then use checkpoint recall if a necessary detail is missing.
- Ordered follow-up work: Continue the latest request; verify before claiming completion.
- Continuation behavior: Act immediately unless authoritative runtime state requires waiting.
- Do not repeat, revert, publish, or claim: Do not invent prior completion or verification.`;
}

export function wrapCheckpointSummary(summary: string, checkpointId: string): string {
	return `${CHECKPOINT_START}\n\n${summary.trim()}\n\nIf a necessary detail appears missing or inconsistent, use recall_compacted_history for checkpoint ${checkpointId} before guessing or repeating work.\n\n${CHECKPOINT_RESUME}`;
}

export function isCompactionCheckpointDetails(value: unknown): value is CompactionCheckpointDetails {
	if (!value || typeof value !== "object") return false;
	const details = value as Partial<CompactionCheckpointDetails>;
	const source = details.source as Partial<CompactionCheckpointDetails["source"]> | undefined;
	const backup = details.backup as Partial<CheckpointBackupRef> | undefined;
	return (
		details.checkpointVersion === CHECKPOINT_VERSION &&
		typeof details.checkpointId === "string" &&
		details.checkpointId.length > 0 &&
		!!source &&
		typeof source.firstKeptEntryId === "string" &&
		typeof source.sourceBranchHeadId === "string" &&
		(!backup ||
			(typeof backup.checkpointId === "string" &&
				backup.checkpointId === details.checkpointId &&
				typeof backup.sessionId === "string" &&
				typeof backup.sourceBranchHeadId === "string" &&
				backup.sourceBranchHeadId === source.sourceBranchHeadId &&
				typeof backup.sha256 === "string" &&
				/^[a-f0-9]{64}$/.test(backup.sha256) &&
				typeof backup.bytes === "number" &&
				Number.isSafeInteger(backup.bytes) &&
				backup.bytes > 0)) &&
		isRetainedRawUserMessages(details.retainedUserMessages, LEGACY_MAX_RETAINED_RAW_USER_MESSAGES)
	);
}

function parseBackupEntries(ref: CheckpointBackupRef): FileEntry[] {
	const file = backupFileFor(ref.sessionId, ref.checkpointId);
	const bytes = readFileSync(file);
	const digest = createHash("sha256").update(bytes).digest("hex");
	if (digest !== ref.sha256 || bytes.length !== ref.bytes) throw new Error("Compaction backup integrity check failed");
	return bytes
		.toString("utf8")
		.split(/\r?\n/)
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as FileEntry);
}

function branchFromBackup(entries: FileEntry[], leafId: string): SessionEntry[] {
	const sessionEntries = entries.filter((entry): entry is SessionEntry => entry.type !== "session");
	const byId = new Map(sessionEntries.map((entry) => [entry.id, entry]));
	const path: SessionEntry[] = [];
	let current = byId.get(leafId);
	while (current) {
		path.push(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	path.reverse();
	return path;
}

function renderRecallEntry(entry: SessionEntry): string {
	if (entry.type === "message") {
		const message = entry.message as AgentMessage;
		if (message.role === "user" || message.role === "assistant" || message.role === "toolResult") {
			const text = serializeConversation([message]);
			const label =
				message.role === "toolResult"
					? `toolResult ${message.toolName}#${message.toolCallId}${message.isError ? " error" : ""}`
					: message.role;
			return `[${entry.id} ${label}] ${text}`;
		}
		return `[${entry.id} ${message.role}] ${JSON.stringify(message)}`;
	}
	if (entry.type === "custom_message") return `[${entry.id} custom:${entry.customType}] ${JSON.stringify(entry.content)}`;
	if (entry.type === "branch_summary") return `[${entry.id} branch-summary] ${entry.summary}`;
	return `[${entry.id} ${entry.type}]`;
}

export function recallCheckpointSource(input: {
	ref: CheckpointBackupRef;
	query?: string;
	aroundEntryId?: string;
	maxChars?: number;
}): CheckpointRecallResult {
	const entries = branchFromBackup(parseBackupEntries(input.ref), input.ref.sourceBranchHeadId);
	let selected: SessionEntry[];
	if (input.aroundEntryId) {
		const index = entries.findIndex((entry) => entry.id === input.aroundEntryId);
		if (index < 0) throw new Error("Entry is not present on the checkpoint branch");
		selected = entries.slice(Math.max(0, index - 3), index + 4);
	} else if (input.query?.trim()) {
		const needle = input.query.toLocaleLowerCase();
		selected = entries.filter((entry) => renderRecallEntry(entry).toLocaleLowerCase().includes(needle)).slice(-20);
	} else {
		selected = entries.slice(-12);
	}
	const raw = selected.map(renderRecallEntry).join("\n\n");
	const maxChars = Math.min(RECALL_MAX_CHARS, Math.max(1_000, input.maxChars ?? 8_000));
	if (raw.length <= maxChars) {
		return { text: raw || "No matching checkpoint entries.", matchedEntries: selected.length, truncated: false, backupSha256: input.ref.sha256 };
	}
	const head = Math.ceil(maxChars * 0.6);
	const tail = maxChars - head;
	return {
		text: `${raw.slice(0, head)}\n\n[... ${raw.length - maxChars} characters omitted from the middle ...]\n\n${raw.slice(-tail)}`,
		matchedEntries: selected.length,
		truncated: true,
		backupSha256: input.ref.sha256,
	};
}
