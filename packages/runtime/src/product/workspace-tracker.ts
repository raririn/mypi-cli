import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, open, opendir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import lockfile from "proper-lockfile";
import type { TrackingConfig } from "./global-config.ts";

const TRACKER_VERSION = 1;
const MAX_STATE_BYTES = 16 * 1024 * 1024;
const MAX_CHANGE_FILES = 500;
const MAX_PATCH_BYTES = 400_000;
const MAX_CHANGE_SET_BYTES = 1_000_000;
const SAMPLE_BYTES = 8_192;
const ESTIMATE_ENTRY_CAP = 100_000;
const ESTIMATE_TIME_MS = 2_000;

const SENSITIVE_SEGMENTS = new Set([
	".git", ".mypi", ".pi", ".agents", ".agent", ".codex", ".claude",
	".ssh", ".gnupg", ".aws", ".azure", ".kube",
]);
const SENSITIVE_FILES = new Set([
	".env", ".npmrc", ".pypirc", "credentials", "credentials.json",
	"id_rsa", "id_dsa", "id_ecdsa", "id_ed25519",
]);
const BINARY_EXTENSIONS = new Set([
	".7z", ".a", ".avi", ".bin", ".bmp", ".class", ".dmg", ".doc", ".docx",
	".exe", ".gif", ".gz", ".ico", ".jar", ".jpeg", ".jpg", ".mov", ".mp3",
	".mp4", ".o", ".obj", ".pdf", ".png", ".ppt", ".pptx", ".pyc", ".so",
	".tar", ".tgz", ".ttf", ".wav", ".webp", ".woff", ".woff2", ".xls", ".xlsx", ".zip",
]);

export type TrackerHealth = "unconfigured" | "disabled" | "missing" | "ready" | "corrupt";
export type ChangeQuality = "net" | "estimated" | "partial";

export interface WorkspaceEstimate {
	readonly files: number;
	readonly bytes: number;
	readonly truncated: boolean;
	readonly broadRoot: boolean;
	readonly warning: boolean;
}

export interface TrackedChangeFile {
	readonly fileId: string;
	readonly path: string;
	readonly status: "added" | "modified" | "deleted";
	readonly additions?: number;
	readonly deletions?: number;
	readonly opaque: boolean;
	readonly patch?: string;
	readonly diffAvailable: boolean;
	readonly provenance: "tracker" | "tool-estimate";
}

export interface WorkspaceChangeSet {
	readonly id: string;
	readonly sessionId: string;
	readonly userMessageId?: string;
	readonly checkpointId?: string;
	readonly createdAt: string;
	readonly basis: "tracker" | "tool-estimate";
	readonly quality: ChangeQuality;
	readonly trackerStatus: TrackerHealth;
	readonly files: readonly TrackedChangeFile[];
	readonly estimated: boolean;
	readonly intersection: "none" | "concurrent-session" | "rewind";
	readonly affectedTaskCount: number;
	readonly omissions: readonly string[];
}

export interface WorkspaceCheckpoint {
	readonly id: string;
	readonly snapshot: string;
	readonly sessionId: string;
	readonly userMessageId: string;
	readonly promptPreview: string;
	readonly sequence: number;
	readonly generation: number;
	readonly createdAt: string;
	readonly opaque: Readonly<Record<string, OpaqueEntry>>;
	readonly intersection: "none" | "concurrent-session" | "rewind";
	readonly affectedTaskCount: number;
	readonly affectedByRewind?: boolean;
}

interface OpaqueEntry {
	readonly size: number;
	readonly mtimeMs: number;
	readonly kind: "binary" | "symlink" | "unreadable";
}

interface TrackerState {
	version: 1;
	root: string;
	sequence: number;
	generation: number;
	currentSnapshot?: string;
	checkpoints: WorkspaceCheckpoint[];
	changeSets: Array<{ id: string; sessionId: string; userMessageId?: string; createdAt: string }>;
	tombstones: Array<{ checkpointId: string; sessionId: string; sequence: number; removedAt: string }>;
}

interface ScanResult {
	text: string[];
	opaque: Record<string, OpaqueEntry>;
	files: number;
	bytes: number;
	truncated: boolean;
}

function isSensitivePath(path: string): boolean {
	const segments = path.split(/[\\/]/u).filter(Boolean);
	if (segments.some((segment) => SENSITIVE_SEGMENTS.has(segment.toLowerCase()))) return true;
	const name = segments.at(-1)?.toLowerCase() ?? "";
	return SENSITIVE_FILES.has(name) || name.startsWith(".env.") || /\.(?:pem|p12|pfx|key)$/iu.test(name);
}

function extension(path: string): string {
	const name = basename(path).toLowerCase();
	const index = name.lastIndexOf(".");
	return index >= 0 ? name.slice(index) : "";
}

async function looksBinary(path: string): Promise<boolean> {
	if (BINARY_EXTENSIONS.has(extension(path))) return true;
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(path, "r");
		const sample = Buffer.allocUnsafe(SAMPLE_BYTES);
		const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
		for (let index = 0; index < bytesRead; index += 1) if (sample[index] === 0) return true;
		return false;
	} catch {
		return true;
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

async function scanWorkspace(root: string, options?: { estimateOnly?: boolean }): Promise<ScanResult> {
	const started = Date.now();
	const result: ScanResult = { text: [], opaque: {}, files: 0, bytes: 0, truncated: false };
	const visit = async (directory: string): Promise<void> => {
		if (result.truncated) return;
		let stream: Awaited<ReturnType<typeof opendir>>;
		try { stream = await opendir(directory); } catch { return; }
		for await (const entry of stream) {
			if (options?.estimateOnly && (result.files >= ESTIMATE_ENTRY_CAP || Date.now() - started > ESTIMATE_TIME_MS)) {
				result.truncated = true;
				return;
			}
			const absolute = join(directory, entry.name);
			const rel = relative(root, absolute).split(sep).join("/");
			if (!rel || isSensitivePath(rel)) continue;
			if (entry.isDirectory()) {
				await visit(absolute);
				continue;
			}
			let info: Awaited<ReturnType<typeof lstat>>;
			try { info = await lstat(absolute); } catch { continue; }
			if (info.isSymbolicLink()) {
				result.files += 1;
				result.opaque[rel] = { size: 0, mtimeMs: info.mtimeMs, kind: "symlink" };
				continue;
			}
			if (!info.isFile()) continue;
			result.files += 1;
			result.bytes += info.size;
			if (options?.estimateOnly) continue;
			if (await looksBinary(absolute)) result.opaque[rel] = { size: info.size, mtimeMs: info.mtimeMs, kind: "binary" };
			else result.text.push(rel);
		}
	};
	await visit(root);
	result.text.sort();
	return result;
}

function execGit(gitDir: string, workTree: string, args: readonly string[], options?: { input?: string | Buffer }): Promise<string> {
	return new Promise((resolvePromise, rejectPromise) => {
		const child = execFile(
			"git",
			["-c", "core.autocrlf=false", "-c", "core.symlinks=true", "-c", "user.name=MyPi Tracker", "-c", "user.email=tracker@localhost", `--git-dir=${gitDir}`, `--work-tree=${workTree}`, ...args],
			{ cwd: workTree, timeout: 60_000, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
			(error, stdout, stderr) => error ? rejectPromise(new Error(stderr.trim() || error.message)) : resolvePromise(stdout),
		);
		if (options?.input !== undefined) child.stdin?.end(options.input);
	});
}

function trackerKey(root: string): string {
	return createHash("sha256").update(root).digest("hex").slice(0, 32);
}

async function canonical(path: string): Promise<string> {
	return await realpath(resolve(path));
}

function emptyState(root: string): TrackerState {
	return { version: TRACKER_VERSION, root, sequence: 0, generation: 0, checkpoints: [], changeSets: [], tombstones: [] };
}

async function readState(path: string, root: string): Promise<TrackerState> {
	try {
		const info = await lstat(path);
		if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_STATE_BYTES) throw new Error("unsafe tracker state");
		const parsed = JSON.parse(await readFile(path, "utf8")) as TrackerState;
		if (parsed.version !== TRACKER_VERSION || parsed.root !== root || !Array.isArray(parsed.checkpoints) || !Array.isArray(parsed.changeSets) || !Array.isArray(parsed.tombstones)) throw new Error("invalid tracker state");
		return parsed;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState(root);
		throw error;
	}
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
	const parent = dirname(path);
	await mkdir(parent, { recursive: true, mode: 0o700 });
	const temporary = join(parent, `.state.${process.pid}.${randomUUID()}.tmp`);
	await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
	await rename(temporary, path);
}

function broadRoot(root: string): boolean {
	const parent = dirname(root);
	return parent === root || root === resolve(process.env.HOME || "__no_home__");
}

export async function estimateWorkspaceTracking(rootInput: string, config: TrackingConfig): Promise<WorkspaceEstimate> {
	const root = await canonical(rootInput);
	const scan = await scanWorkspace(root, { estimateOnly: true });
	const broad = broadRoot(root);
	return {
		files: scan.files,
		bytes: scan.bytes,
		truncated: scan.truncated,
		broadRoot: broad,
		warning: broad || scan.truncated || scan.files > config.warningFiles || scan.bytes > config.warningBytes,
	};
}

export class WorkspaceTracker {
	readonly agentDir: string;
	readonly config: TrackingConfig;
	readonly root: string;
	readonly directory: string;
	readonly gitDirectory: string;
	readonly statePath: string;
	readonly changeDirectory: string;

	private constructor(agentDir: string, root: string, config: TrackingConfig) {
		this.agentDir = agentDir;
		this.config = config;
		this.root = root;
		this.directory = join(resolve(agentDir), "trackers", trackerKey(root));
		this.gitDirectory = join(this.directory, "repo");
		this.statePath = join(this.directory, "state.json");
		this.changeDirectory = join(this.directory, "changes");
	}

	static async open(agentDir: string, root: string, config: TrackingConfig): Promise<WorkspaceTracker> {
		return new WorkspaceTracker(agentDir, await canonical(root), config);
	}

	static async openStored(agentDir: string, key: string, config: TrackingConfig): Promise<WorkspaceTracker> {
		if (!/^[a-f0-9]{32}$/u.test(key)) throw new Error("Invalid stored tracker identity.");
		const directory = join(resolve(agentDir), "trackers", key);
		const raw = JSON.parse(await readFile(join(directory, "state.json"), "utf8")) as { root?: unknown };
		if (typeof raw.root !== "string" || trackerKey(raw.root) !== key) throw new Error("Stored tracker identity mismatch.");
		return new WorkspaceTracker(agentDir, raw.root, config);
	}

	async health(configured: "track" | "dont-track" | null): Promise<TrackerHealth> {
		if (configured === null) return "unconfigured";
		if (configured === "dont-track") return "disabled";
		return await this.storageHealth();
	}

	async storageHealth(): Promise<"missing" | "ready" | "corrupt"> {
		try {
			const stateExists = await stat(this.statePath).then(() => true, () => false);
			const repoExists = await stat(join(this.gitDirectory, "HEAD")).then(() => true, () => false);
			if (!stateExists && !repoExists) return "missing";
			if (!stateExists || !repoExists) return "corrupt";
			await readState(this.statePath, this.root);
			await execGit(this.gitDirectory, this.root, ["rev-parse", "--git-dir"]);
			return "ready";
		} catch {
			return "corrupt";
		}
	}

	private async locked<T>(operation: (state: TrackerState) => Promise<T>): Promise<T> {
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		const release = await lockfile.lock(this.directory, {
			realpath: false,
			lockfilePath: `${this.directory}.lock`,
			stale: 60_000,
			update: 20_000,
			retries: { retries: 20, factor: 1.5, minTimeout: 20, maxTimeout: 500 },
		});
		try { return await operation(await readState(this.statePath, this.root)); }
		finally { await release(); }
	}

	private async ensureRepository(): Promise<void> {
		if (await stat(join(this.gitDirectory, "HEAD")).then(() => true, () => false)) return;
		await mkdir(this.gitDirectory, { recursive: true, mode: 0o700 });
		await new Promise<void>((resolvePromise, rejectPromise) => {
			execFile("git", ["init", "--bare", this.gitDirectory], { timeout: 30_000 }, (error, _stdout, stderr) => error ? rejectPromise(new Error(stderr || error.message)) : resolvePromise());
		});
		await execGit(this.gitDirectory, this.root, ["config", "core.bare", "false"]);
	}

	private changeSetPath(id: string): string {
		if (!/^[a-f0-9-]{16,64}$/iu.test(id)) throw new Error("Invalid change-set identity.");
		return join(this.changeDirectory, `${id}.json`);
	}

	private async writeChangeSet(changeSet: WorkspaceChangeSet): Promise<void> {
		await mkdir(this.changeDirectory, { recursive: true, mode: 0o700 });
		await atomicWrite(this.changeSetPath(changeSet.id), changeSet);
	}

	private async readChangeSet(id: string): Promise<WorkspaceChangeSet | undefined> {
		try {
			const path = this.changeSetPath(id);
			const info = await lstat(path);
			if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) throw new Error("unsafe change-set file");
			const value = JSON.parse(await readFile(path, "utf8")) as WorkspaceChangeSet;
			return value.id === id && Array.isArray(value.files) ? value : undefined;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}

	private async capture(ref?: string): Promise<{ snapshot: string; opaque: Record<string, OpaqueEntry>; truncated: boolean }> {
		await this.ensureRepository();
		const scan = await scanWorkspace(this.root);
		await execGit(this.gitDirectory, this.root, ["read-tree", "--empty"]);
		if (scan.text.length > 0) {
			const pathFile = join(this.directory, `.paths.${process.pid}.${randomUUID()}`);
			try {
				await writeFile(pathFile, `${scan.text.join("\0")}\0`, { mode: 0o600 });
				await execGit(this.gitDirectory, this.root, ["add", "-f", "--all", `--pathspec-from-file=${pathFile}`, "--pathspec-file-nul"]);
			} finally {
				await rm(pathFile, { force: true });
			}
		}
		const tree = (await execGit(this.gitDirectory, this.root, ["write-tree"])).trim();
		const snapshot = (await execGit(this.gitDirectory, this.root, ["commit-tree", tree], { input: `MyPi checkpoint ${new Date().toISOString()}\n` })).trim();
		if (ref) await execGit(this.gitDirectory, this.root, ["update-ref", ref, snapshot]);
		return { snapshot, opaque: scan.opaque, truncated: scan.truncated };
	}

	async createCheckpoint(input: {
		sessionId: string;
		userMessageId: string;
		promptPreview: string;
		intersection?: "none" | "concurrent-session" | "rewind";
		affectedTaskCount?: number;
	}): Promise<WorkspaceCheckpoint> {
		return this.locked(async (state) => {
			const id = randomUUID();
			const captured = await this.capture(`refs/mypi/checkpoints/${id}`);
			state.sequence += 1;
			const checkpoint: WorkspaceCheckpoint = {
				id,
				snapshot: captured.snapshot,
				sessionId: input.sessionId,
				userMessageId: input.userMessageId,
				promptPreview: input.promptPreview.replace(/[\r\n]+/gu, " ").slice(0, 240),
				sequence: state.sequence,
				generation: state.generation,
				createdAt: new Date().toISOString(),
				opaque: captured.opaque,
				intersection: input.intersection ?? "none",
				affectedTaskCount: input.affectedTaskCount ?? 0,
			};
			state.checkpoints.push(checkpoint);
			state.currentSnapshot = checkpoint.snapshot;
			await this.pruneSession(state, input.sessionId, this.config.maxSessionCheckpoints);
			await atomicWrite(this.statePath, state);
			return checkpoint;
		});
	}

	private async pruneSession(state: TrackerState, sessionId: string, limit: number): Promise<void> {
		const owned = state.checkpoints.filter((item) => item.sessionId === sessionId).sort((a, b) => a.sequence - b.sequence);
		for (const checkpoint of owned.slice(0, Math.max(0, owned.length - limit))) {
			state.checkpoints = state.checkpoints.filter((item) => item.id !== checkpoint.id);
			state.tombstones.push({ checkpointId: checkpoint.id, sessionId, sequence: checkpoint.sequence, removedAt: new Date().toISOString() });
			await execGit(this.gitDirectory, this.root, ["update-ref", "-d", `refs/mypi/checkpoints/${checkpoint.id}`]).catch(() => undefined);
		}
		if (state.tombstones.length > 10_000) state.tombstones.splice(0, state.tombstones.length - 10_000);
	}

	async pruneDetached(sessionId: string): Promise<void> {
		await this.locked(async (state) => {
			await this.pruneSession(state, sessionId, this.config.maxDetachedCheckpoints);
			await atomicWrite(this.statePath, state);
		});
	}

	/** Archiving is a recovery-data destruction boundary. Remove every
	 * checkpoint ref owned by the session while retaining materialized change
	 * sets for read-only archived Diff. */
	async purgeSessionSnapshots(sessionId: string): Promise<number> {
		if (await this.storageHealth() === "missing") return 0;
		return this.locked(async (state) => {
			const owned = state.checkpoints.filter((item) => item.sessionId === sessionId);
			for (const checkpoint of owned) {
				await execGit(this.gitDirectory, this.root, ["update-ref", "-d", `refs/mypi/checkpoints/${checkpoint.id}`]).catch(() => undefined);
			}
			state.checkpoints = state.checkpoints.filter((item) => item.sessionId !== sessionId);
			state.tombstones = state.tombstones.filter((item) => item.sessionId !== sessionId);
			state.currentSnapshot = state.checkpoints
				.slice()
				.sort((left, right) => right.sequence - left.sequence)[0]?.snapshot;
			await atomicWrite(this.statePath, state);
			if (owned.length > 0) {
				await execGit(this.gitDirectory, this.root, ["reflog", "expire", "--expire=now", "--all"]).catch(() => undefined);
				await execGit(this.gitDirectory, this.root, ["gc", "--prune=now"]).catch(() => undefined);
			}
			return owned.length;
		});
	}

	private async diffSnapshots(
		from: string,
		to: string,
		fromOpaque: Readonly<Record<string, OpaqueEntry>>,
		toOpaque: Readonly<Record<string, OpaqueEntry>>,
	): Promise<{ files: TrackedChangeFile[]; omissions: string[] }> {
		const additions = new Map<string, { additions: number; deletions: number }>();
		const numstat = await execGit(this.gitDirectory, this.root, ["diff", "--no-renames", "--numstat", from, to]);
		for (const line of numstat.split("\n")) {
			const [add, del, path] = line.split("\t");
			if (!path) continue;
			additions.set(path, { additions: Number(add) || 0, deletions: Number(del) || 0 });
		}
		const statuses = new Map<string, "added" | "modified" | "deleted">();
		const names = await execGit(this.gitDirectory, this.root, ["diff", "--no-renames", "--name-status", from, to]);
		for (const line of names.split("\n")) {
			const [status, path] = line.split("\t");
			if (!path) continue;
			statuses.set(path, status === "A" ? "added" : status === "D" ? "deleted" : "modified");
		}
		const opaquePaths = new Set([...Object.keys(fromOpaque), ...Object.keys(toOpaque)]);
		for (const path of opaquePaths) {
			const before = fromOpaque[path];
			const after = toOpaque[path];
			if (!before && after) statuses.set(path, "added");
			else if (before && !after) statuses.set(path, "deleted");
			else if (before && after && (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.kind !== after.kind)) statuses.set(path, "modified");
		}
		const files: TrackedChangeFile[] = [];
		const omissions: string[] = [];
		let patchBytes = 0;
		for (const [path, status] of [...statuses].sort(([left], [right]) => left.localeCompare(right)).slice(0, MAX_CHANGE_FILES)) {
			const opaque = path in fromOpaque || path in toOpaque;
			let patch: string | undefined;
			if (!opaque) {
				const candidate = await execGit(this.gitDirectory, this.root, ["diff", "--no-renames", "--unified=3", from, to, "--", path]);
				if (Buffer.byteLength(candidate) <= MAX_PATCH_BYTES && patchBytes + Buffer.byteLength(candidate) <= MAX_CHANGE_SET_BYTES) {
					patch = candidate;
					patchBytes += Buffer.byteLength(candidate);
				} else omissions.push(`Diff omitted for ${path}: bounded change-data limit reached.`);
			}
			const counts = additions.get(path);
			files.push({
				fileId: randomUUID(), path, status,
				...(counts && !opaque ? counts : {}),
				opaque,
				...(patch ? { patch } : {}),
				diffAvailable: Boolean(patch),
				provenance: "tracker",
			});
		}
		if (statuses.size > MAX_CHANGE_FILES) omissions.push(`${statuses.size - MAX_CHANGE_FILES} changed paths omitted by the file-count limit.`);
		return { files, omissions };
	}

	async finalizeChangeSet(input: {
		sessionId: string;
		checkpointId: string;
		intersection?: "none" | "concurrent-session" | "rewind";
		affectedTaskCount?: number;
		partialReason?: string;
	}): Promise<WorkspaceChangeSet> {
		return this.locked(async (state) => {
			const checkpoint = state.checkpoints.find((item) => item.id === input.checkpointId && item.sessionId === input.sessionId);
			if (!checkpoint) throw new Error("Checkpoint is unavailable for this session.");
			const captured = await this.capture();
			const diff = await this.diffSnapshots(checkpoint.snapshot, captured.snapshot, checkpoint.opaque, captured.opaque);
			const changeSet: WorkspaceChangeSet = {
				id: randomUUID(), sessionId: input.sessionId, userMessageId: checkpoint.userMessageId, checkpointId: checkpoint.id,
				createdAt: new Date().toISOString(), basis: "tracker",
				quality: captured.truncated || input.partialReason ? "partial" : "net", trackerStatus: "ready",
				files: diff.files, estimated: false,
				intersection: input.intersection ?? checkpoint.intersection,
				affectedTaskCount: input.affectedTaskCount ?? checkpoint.affectedTaskCount,
				omissions: [...diff.omissions, ...(captured.truncated ? ["Workspace scan was truncated."] : []), ...(input.partialReason ? [input.partialReason] : [])],
			};
			await this.writeChangeSet(changeSet);
			state.changeSets.push({ id: changeSet.id, sessionId: changeSet.sessionId, ...(changeSet.userMessageId ? { userMessageId: changeSet.userMessageId } : {}), createdAt: changeSet.createdAt });
			await atomicWrite(this.statePath, state);
			return changeSet;
		});
	}

	async listCheckpoints(sessionId: string): Promise<WorkspaceCheckpoint[]> {
		return this.locked(async (state) => state.checkpoints.filter((item) => item.sessionId === sessionId).sort((a, b) => b.sequence - a.sequence));
	}

	async bindCheckpointToUserMessage(sessionId: string, checkpointId: string, userMessageId: string, promptPreview?: string): Promise<void> {
		await this.locked(async (state) => {
			const index = state.checkpoints.findIndex((item) => item.id === checkpointId && item.sessionId === sessionId);
			if (index < 0) return;
			const current = state.checkpoints[index]!;
			state.checkpoints[index] = {
				...current,
				userMessageId,
				...(promptPreview ? { promptPreview: promptPreview.replace(/[\r\n]+/gu, " ").slice(0, 240) } : {}),
			};
			await atomicWrite(this.statePath, state);
		});
	}

	async getChangeSet(id: string, sessionId: string): Promise<WorkspaceChangeSet | undefined> {
		return this.locked(async (state) => {
			if (!state.changeSets.some((item) => item.id === id && item.sessionId === sessionId)) return undefined;
			return await this.readChangeSet(id);
		});
	}

	async listChangeSets(sessionId: string): Promise<WorkspaceChangeSet[]> {
		return this.locked(async (state) => {
			const values = await Promise.all(state.changeSets.filter((item) => item.sessionId === sessionId).map((item) => this.readChangeSet(item.id)));
			return values.filter((item): item is WorkspaceChangeSet => Boolean(item));
		});
	}

	async previewRewind(sessionId: string, checkpointId: string): Promise<{ checkpoint: WorkspaceCheckpoint; files: readonly TrackedChangeFile[]; affectedOtherTasks: number; laterOwned: number; sequence: number; generation: number }> {
		return this.locked(async (state) => {
			const checkpoint = state.checkpoints.find((item) => item.id === checkpointId && item.sessionId === sessionId);
			if (!checkpoint) throw new Error("Checkpoint is unavailable for this session.");
			const current = await this.capture();
			const diff = await this.diffSnapshots(checkpoint.snapshot, current.snapshot, checkpoint.opaque, current.opaque);
			const later = state.checkpoints.filter((item) => item.sequence > checkpoint.sequence);
			return {
				checkpoint, files: diff.files,
				affectedOtherTasks: new Set(later.filter((item) => item.sessionId !== sessionId).map((item) => item.sessionId)).size,
				laterOwned: later.filter((item) => item.sessionId === sessionId).length,
				sequence: state.sequence, generation: state.generation,
			};
		});
	}

	async rewind(input: { sessionId: string; checkpointId: string; expectedSequence: number; expectedGeneration: number }): Promise<{ removed: number; affectedOtherTasks: number; generation: number }> {
		return this.locked(async (state) => {
			if (state.sequence !== input.expectedSequence || state.generation !== input.expectedGeneration) throw new Error("Tracker changed after preview; preview rewind again.");
			const checkpoint = state.checkpoints.find((item) => item.id === input.checkpointId && item.sessionId === input.sessionId);
			if (!checkpoint) throw new Error("Checkpoint is unavailable for this session.");
			const later = state.checkpoints.filter((item) => item.sequence > checkpoint.sequence);
			const affectedSessions = new Set(later.filter((item) => item.sessionId !== input.sessionId).map((item) => item.sessionId));
			await this.capture(); // synchronize the private index with current eligible text paths
			await execGit(this.gitDirectory, this.root, ["read-tree", "--reset", "-u", `${checkpoint.snapshot}^{tree}`]);
			for (const item of later.filter((entry) => entry.sessionId === input.sessionId)) {
				state.checkpoints = state.checkpoints.filter((entry) => entry.id !== item.id);
				state.tombstones.push({ checkpointId: item.id, sessionId: item.sessionId, sequence: item.sequence, removedAt: new Date().toISOString() });
				await execGit(this.gitDirectory, this.root, ["update-ref", "-d", `refs/mypi/checkpoints/${item.id}`]).catch(() => undefined);
			}
			state.checkpoints = state.checkpoints.map((item) => item.sequence > checkpoint.sequence && item.sessionId !== input.sessionId ? { ...item, affectedByRewind: true } : item);
			state.generation += 1;
			state.sequence += 1;
			state.currentSnapshot = checkpoint.snapshot;
			await atomicWrite(this.statePath, state);
			return { removed: later.filter((item) => item.sessionId === input.sessionId).length, affectedOtherTasks: affectedSessions.size, generation: state.generation };
		});
	}

	async removeAll(): Promise<void> {
		await rm(this.directory, { recursive: true, force: true });
		await rm(`${this.directory}.lock`, { recursive: true, force: true }).catch(() => undefined);
	}

	async rebuild(): Promise<void> {
		await this.removeAll();
		await this.locked(async (state) => {
			const captured = await this.capture();
			state.currentSnapshot = captured.snapshot;
			await atomicWrite(this.statePath, state);
		});
	}
}

/** Remove tracker storage even when the recorded project directory no longer
 * exists. Project cleanup must not require reopening the former work tree. */
export async function removeWorkspaceTracker(agentDir: string, root: string): Promise<void> {
	const directory = join(resolve(agentDir), "trackers", trackerKey(resolve(root)));
	await rm(directory, { recursive: true, force: true });
	await rm(`${directory}.lock`, { recursive: true, force: true }).catch(() => undefined);
}

/** Remove a session's recovery snapshots from every project tracker. Sessions
 * may outlive or move away from their workspace, so archive cannot rely on
 * resolving one currently-existing cwd. */
export async function purgeSessionSnapshotsAcrossTrackers(
	agentDir: string,
	sessionId: string,
	config: TrackingConfig,
): Promise<number> {
	const root = join(resolve(agentDir), "trackers");
	let stream: Awaited<ReturnType<typeof opendir>>;
	try { stream = await opendir(root); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
		throw error;
	}
	let removed = 0;
	for await (const entry of stream) {
		if (!entry.isDirectory() || !/^[a-f0-9]{32}$/u.test(entry.name)) continue;
		try {
			const tracker = await WorkspaceTracker.openStored(agentDir, entry.name, config);
			removed += await tracker.purgeSessionSnapshots(sessionId);
		} catch {
			// A corrupt tracker is already unusable for rewind; archive continues
			// through healthy trackers and the corruption warning remains visible.
		}
	}
	return removed;
}

export function estimatedChangeSet(input: {
	sessionId: string;
	id?: string;
	userMessageId?: string;
	createdAt?: string;
	trackerStatus: TrackerHealth;
	files: Array<Omit<TrackedChangeFile, "fileId" | "provenance">>;
	intersection?: "none" | "concurrent-session" | "rewind";
	affectedTaskCount?: number;
	omissions?: string[];
}): WorkspaceChangeSet {
	return {
		id: input.id ?? randomUUID(), sessionId: input.sessionId,
		...(input.userMessageId ? { userMessageId: input.userMessageId } : {}),
		createdAt: input.createdAt ?? new Date().toISOString(),
		basis: "tool-estimate", quality: "estimated", trackerStatus: input.trackerStatus,
		files: input.files.slice(0, MAX_CHANGE_FILES).map((file) => ({ ...file, fileId: randomUUID(), provenance: "tool-estimate" })),
		estimated: true, intersection: input.intersection ?? "none",
		affectedTaskCount: input.affectedTaskCount ?? 0,
		omissions: input.omissions ?? [],
	};
}

function stableEstimateId(sessionId: string, userMessageId: string): string {
	return `estimated-${createHash("sha256").update(`${sessionId}\0${userMessageId}`).digest("hex").slice(0, 24)}`;
}

function messageQueuedMode(message: Record<string, unknown>): "steer" | "followUp" | null {
	if (!Array.isArray(message.content)) return null;
	for (const part of message.content) {
		if (!part || typeof part !== "object") continue;
		const mode = (part as { mypiQueuedMessageMode?: unknown }).mypiQueuedMessageMode;
		if (mode === "steer" || mode === "followUp") return mode;
	}
	return null;
}

/** Project historical sessions into the same daemon-owned estimated change
 *  shape used when tracking is disabled or unavailable. */
export function estimatePersistedSessionChanges(sessionId: string, entries: readonly unknown[]): WorkspaceChangeSet[] {
	const results: WorkspaceChangeSet[] = [];
	let current: { id: string; createdAt?: string; calls: Map<string, { name: string; args: Record<string, unknown> }>; files: Map<string, Omit<TrackedChangeFile, "fileId" | "provenance">> } | undefined;
	const finish = () => {
		if (!current) return;
		results.push(estimatedChangeSet({
			sessionId,
			id: stableEstimateId(sessionId, current.id),
			userMessageId: current.id,
			createdAt: current.createdAt,
			trackerStatus: "missing",
			files: [...current.files.values()],
			omissions: ["Historical changes are estimated from successful file-tool activity."],
		}));
		current = undefined;
	};
	for (const raw of entries) {
		if (!raw || typeof raw !== "object") continue;
		const entry = raw as Record<string, unknown>;
		if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
		const message = entry.message as Record<string, unknown>;
		if (message.role === "user") {
			if (messageQueuedMode(message) === "steer") continue;
			finish();
			const id = typeof entry.id === "string" ? entry.id : `user-${results.length + 1}`;
			current = { id, createdAt: typeof entry.timestamp === "string" ? entry.timestamp : undefined, calls: new Map(), files: new Map() };
			continue;
		}
		if (!current) continue;
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (!block || typeof block !== "object") continue;
				const call = block as Record<string, unknown>;
				if (call.type !== "toolCall" || typeof call.id !== "string") continue;
				current.calls.set(call.id, { name: typeof call.name === "string" ? call.name : "", args: call.arguments && typeof call.arguments === "object" ? call.arguments as Record<string, unknown> : {} });
			}
			continue;
		}
		if (message.role !== "toolResult" || message.isError === true || typeof message.toolCallId !== "string") continue;
		const call = current.calls.get(message.toolCallId);
		if (!call) continue;
		const candidate = call.args.path ?? call.args.file_path ?? call.args.filePath;
		if (typeof candidate !== "string" || !candidate) continue;
		const path = candidate.replaceAll("\\", "/");
		const details = message.details && typeof message.details === "object" ? message.details as Record<string, unknown> : {};
		const patch = typeof details.patch === "string" ? details.patch : undefined;
		const counts = patch ? patchCountsForEstimate(patch) : typeof call.args.content === "string"
			? { additions: call.args.content ? call.args.content.split("\n").length - (call.args.content.endsWith("\n") ? 1 : 0) : 0, deletions: 0 }
			: { additions: 0, deletions: 0 };
		const previous = current.files.get(path);
		const boundedPatch = patch && Buffer.byteLength(patch) <= MAX_PATCH_BYTES ? patch : undefined;
		current.files.set(path, {
			path, status: previous?.status ?? "modified",
			additions: (previous?.additions ?? 0) + counts.additions,
			deletions: (previous?.deletions ?? 0) + counts.deletions,
			opaque: false,
			...(boundedPatch ? { patch: boundedPatch } : {}),
			diffAvailable: Boolean(boundedPatch),
		});
	}
	finish();
	return results;
}

function patchCountsForEstimate(patch: string): { additions: number; deletions: number } {
	let additions = 0;
	let deletions = 0;
	for (const line of patch.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
		else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
	}
	return { additions, deletions };
}
