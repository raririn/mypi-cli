import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

export const SUBAGENT_STORAGE_VERSION = 1;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_METADATA_BYTES = 512 * 1024;
const ID_PATTERN = /^(?:sb|sa|sg)_[A-Za-z0-9_-]{32}$/u;

export type SubagentRole = "explore" | "work" | "advisor" | "review";
export type SubagentGrantStatus =
	| "queued"
	| "starting"
	| "briefing"
	| "running"
	| "cancelling"
	| "completed"
	| "failed"
	| "cancelled"
	| "timed_out";

export interface SubagentUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	/** Provider-reported cost total in USD. Absent on records written before usage attribution. */
	cost?: number;
}

export interface SubagentGrantRecord {
	grantId: string;
	batchId: string;
	prompt: string;
	status: SubagentGrantStatus;
	createdAt: string;
	startedAt?: string;
	settledAt?: string;
	lastEventAt?: string;
	reason?: string;
	answer?: string;
	usage?: SubagentUsage;
	pid?: number;
	stderrTail?: string;
}

export interface SubagentChildRecord {
	version: 1;
	childId: string;
	parentSessionId: string;
	parentBranchId: string | null;
	role: SubagentRole;
	label: string;
	task: string;
	scope?: string[];
	cwd: string;
	model: { provider: string; id: string };
	thinkingLevel?: string;
	createdAt: string;
	updatedAt: string;
	grants: SubagentGrantRecord[];
}

export interface SubagentManifest {
	version: 1;
	parentSessionId: string;
	updatedAt: string;
	children: SubagentChildRecord[];
}

function opaqueId(prefix: "sb" | "sa" | "sg"): string {
	return `${prefix}_${randomBytes(24).toString("base64url")}`;
}

export const createSubagentBatchId = (): string => opaqueId("sb");
export const createSubagentChildId = (): string => opaqueId("sa");
export const createSubagentGrantId = (): string => opaqueId("sg");

export function isOpaqueSubagentId(value: unknown, prefix?: "sb" | "sa" | "sg"): value is string {
	return typeof value === "string" && ID_PATTERN.test(value) && (!prefix || value.startsWith(`${prefix}_`));
}

export class SubagentStore {
	readonly agentDir: string;
	readonly parentSessionId: string;
	readonly root: string;
	readonly parentRoot: string;
	readonly childrenRoot: string;
	readonly manifestPath: string;
	private manifest: SubagentManifest;
	private mutationTail: Promise<void> = Promise.resolve();

	private constructor(
		agentDir: string,
		parentSessionId: string,
		manifest: SubagentManifest,
	) {
		this.agentDir = agentDir;
		this.parentSessionId = parentSessionId;
		this.root = resolve(agentDir, "subagents", "by-parent");
		this.parentRoot = resolve(this.root, parentSessionId);
		this.childrenRoot = resolve(this.parentRoot, "children");
		this.manifestPath = resolve(this.parentRoot, "manifest.json");
		this.manifest = manifest;
	}

	static async open(agentDir: string, parentSessionId: string): Promise<SubagentStore> {
		if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u.test(parentSessionId)) {
			throw new Error("Subagent parent session ID is unsafe.");
		}
		const root = resolve(agentDir, "subagents", "by-parent");
		const parentRoot = resolve(root, parentSessionId);
		const childrenRoot = resolve(parentRoot, "children");
		await ensureDirectory(resolve(agentDir));
		await ensureDirectory(resolve(agentDir, "subagents"));
		await ensureDirectory(root);
		await ensureDirectory(parentRoot);
		await ensureDirectory(childrenRoot);
		const manifestPath = resolve(parentRoot, "manifest.json");
		const manifest = await readManifest(manifestPath, parentSessionId);
		return new SubagentStore(agentDir, parentSessionId, manifest);
	}

	list(): SubagentChildRecord[] {
		return structuredClone(this.manifest.children);
	}

	get(childId: string): SubagentChildRecord | undefined {
		if (!isOpaqueSubagentId(childId, "sa")) return undefined;
		const record = this.manifest.children.find((child) => child.childId === childId);
		return record ? structuredClone(record) : undefined;
	}

	childDirectory(childId: string): string {
		if (!isOpaqueSubagentId(childId, "sa")) throw new Error("Invalid subagent child ID.");
		return contained(resolve(this.childrenRoot, childId), this.childrenRoot);
	}

	childSessionPath(childId: string): string {
		return resolve(this.childDirectory(childId), "session.jsonl");
	}

	async create(record: SubagentChildRecord): Promise<void> {
		await this.mutate(async (manifest) => {
			if (manifest.children.some((child) => child.childId === record.childId)) {
				throw new Error("Subagent child ID collision.");
			}
			const directory = this.childDirectory(record.childId);
			await ensureDirectory(directory);
			const sessionHandle = await open(resolve(directory, "session.jsonl"), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
			await sessionHandle.close();
			manifest.children.push(structuredClone(record));
			manifest.updatedAt = new Date().toISOString();
			await atomicJson(resolve(directory, "metadata.json"), record);
		});
	}

	async update(record: SubagentChildRecord): Promise<void> {
		await this.mutate(async (manifest) => {
			const index = manifest.children.findIndex((child) => child.childId === record.childId);
			if (index < 0) throw new Error("Subagent child is not owned by this parent.");
			manifest.children[index] = structuredClone(record);
			manifest.updatedAt = new Date().toISOString();
			await atomicJson(resolve(this.childDirectory(record.childId), "metadata.json"), record);
		});
	}

	async removeAll(): Promise<void> {
		await rm(this.parentRoot, { recursive: true, force: true });
	}

	private async mutate(operation: (manifest: SubagentManifest) => Promise<void>): Promise<void> {
		let release!: () => void;
		const previous = this.mutationTail;
		this.mutationTail = new Promise<void>((resolvePromise) => { release = resolvePromise; });
		await previous;
		try {
			await operation(this.manifest);
			await atomicJson(this.manifestPath, this.manifest);
		} finally {
			release();
		}
	}
}

export async function removeSubagentParentStorage(agentDir: string, parentSessionId: string): Promise<void> {
	if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u.test(parentSessionId)) {
		throw new Error("Subagent parent session ID is unsafe.");
	}
	const root = resolve(agentDir, "subagents", "by-parent");
	const target = contained(resolve(root, parentSessionId), root);
	try {
		const info = await lstat(target);
		if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Subagent parent storage is unsafe.");
		await rm(target, { recursive: true, force: false });
	} catch (error) {
		if (!isCode(error, "ENOENT")) throw error;
	}
}

export async function hasSubagentParentStorage(agentDir: string, parentSessionId: string): Promise<boolean> {
	if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u.test(parentSessionId)) return false;
	const target = resolve(agentDir, "subagents", "by-parent", parentSessionId);
	try {
		const info = await lstat(target);
		if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Subagent parent storage is unsafe.");
		return true;
	} catch (error) {
		if (isCode(error, "ENOENT")) return false;
		throw error;
	}
}

async function readManifest(path: string, parentSessionId: string): Promise<SubagentManifest> {
	try {
		const info = await lstat(path);
		if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_MANIFEST_BYTES) {
			throw new Error("Subagent manifest is unsafe or oversized.");
		}
		const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
		if (!isManifest(parsed, parentSessionId)) throw new Error("Subagent manifest is invalid.");
		return parsed;
	} catch (error) {
		if (isCode(error, "ENOENT")) {
			return { version: SUBAGENT_STORAGE_VERSION, parentSessionId, updatedAt: new Date().toISOString(), children: [] };
		}
		throw error;
	}
}

function isManifest(value: unknown, parentSessionId: string): value is SubagentManifest {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<SubagentManifest>;
	if (record.version !== 1 || record.parentSessionId !== parentSessionId || !Array.isArray(record.children)) return false;
	if (record.children.length > 256 || typeof record.updatedAt !== "string") return false;
	return record.children.every((child) => isChild(child, parentSessionId));
}

function isChild(value: unknown, parentSessionId: string): value is SubagentChildRecord {
	if (!value || typeof value !== "object") return false;
	const child = value as Partial<SubagentChildRecord>;
	return child.version === 1
		&& isOpaqueSubagentId(child.childId, "sa")
		&& child.parentSessionId === parentSessionId
		&& ["explore", "work", "advisor", "review"].includes(child.role ?? "")
		&& typeof child.label === "string" && child.label.length <= 200
		&& typeof child.task === "string" && child.task.length <= 16_384
		&& typeof child.cwd === "string"
		&& typeof child.createdAt === "string"
		&& typeof child.updatedAt === "string"
		&& Boolean(child.model && typeof child.model.provider === "string" && typeof child.model.id === "string")
		&& Array.isArray(child.grants) && child.grants.length <= 128
		&& child.grants.every((grant) => isOpaqueSubagentId(grant?.grantId, "sg")
			&& isOpaqueSubagentId(grant?.batchId, "sb") && typeof grant.prompt === "string"
			&& grant.prompt.length <= 16_384 && typeof grant.status === "string");
}

async function ensureDirectory(path: string): Promise<void> {
	try {
		const info = await lstat(path);
		if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Unsafe subagent directory: ${path}`);
		return;
	} catch (error) {
		if (!isCode(error, "ENOENT")) throw error;
	}
	await mkdir(path, { recursive: false, mode: 0o700 });
	await chmod(path, 0o700);
}

async function atomicJson(path: string, value: unknown): Promise<void> {
	const payload = `${JSON.stringify(value, null, 2)}\n`;
	const maximum = path.endsWith("manifest.json") ? MAX_MANIFEST_BYTES : MAX_METADATA_BYTES;
	if (Buffer.byteLength(payload) > maximum) throw new Error("Subagent metadata exceeds its storage bound.");
	const temporary = resolve(dirname(path), `.${randomUUID()}.tmp`);
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
		await handle.writeFile(payload, "utf8");
		await handle.sync();
		await handle.close();
		handle = undefined;
		await rename(temporary, path);
		await chmod(path, 0o600);
	} finally {
		await handle?.close().catch(() => undefined);
		await rm(temporary, { force: true }).catch(() => undefined);
	}
}

function contained(path: string, root: string): string {
	const normalizedRoot = resolve(root);
	const normalizedPath = resolve(path);
	if (normalizedPath !== normalizedRoot && !normalizedPath.startsWith(`${normalizedRoot}${sep}`)) {
		throw new Error("Subagent path escapes its parent store.");
	}
	return normalizedPath;
}

function isCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error
		&& (error as NodeJS.ErrnoException).code === code;
}
