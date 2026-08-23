import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { CONFIG_DIR_NAME } from "../config.ts";
import { canonicalizePath, resolvePath } from "../utils/paths.ts";

export type ProjectTrustDecision = boolean | null;
export type ProjectTrackingDecision = "track" | "dont-track" | null;

export interface ProjectTrustStoreEntry {
	path: string;
	decision: boolean;
}

export interface ProjectTrustUpdate {
	path: string;
	decision: ProjectTrustDecision;
}

export interface ProjectTrustOption {
	label: string;
	trusted: boolean;
	updates: ProjectTrustUpdate[];
	savedPath?: string;
}

interface TrustFileV2 {
	version: 2;
	trust: Record<string, boolean | null | undefined>;
	tracking: Record<string, Exclude<ProjectTrackingDecision, null> | undefined>;
}

const TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES = [
	"settings.json",
	"extensions",
	"skills",
	"prompts",
	"themes",
	"SYSTEM.md",
	"APPEND_SYSTEM.md",
] as const;

function normalizeCwd(cwd: string): string {
	return canonicalizePath(resolvePath(cwd));
}

function findNearestTrustEntry(data: TrustFileV2["trust"], cwd: string): ProjectTrustStoreEntry | null {
	let currentDir = normalizeCwd(cwd);
	while (true) {
		const value = data[currentDir];
		if (value === true || value === false) {
			return { path: currentDir, decision: value };
		}

		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) {
			return null;
		}
		currentDir = parentDir;
	}
}

export function getProjectTrustParentPath(cwd: string): string | undefined {
	const trustPath = normalizeCwd(cwd);
	const parentDir = dirname(trustPath);
	return parentDir === trustPath ? undefined : parentDir;
}

/** Resolve the nearest Git worktree root without executing project code or Git hooks. */
export function resolveProjectTrustRoot(cwd: string): string {
	let current = normalizeCwd(cwd);
	while (true) {
		if (existsSync(join(current, ".git"))) return current;
		const parent = dirname(current);
		if (parent === current) return normalizeCwd(cwd);
		current = parent;
	}
}

export function getProjectTrustOptions(cwd: string, options?: { includeSessionOnly?: boolean }): ProjectTrustOption[] {
	const trustPath = normalizeCwd(cwd);
	const trustOptions: ProjectTrustOption[] = [
		{ label: "Trust", trusted: true, updates: [{ path: trustPath, decision: true }], savedPath: trustPath },
	];
	const parentPath = getProjectTrustParentPath(cwd);
	if (parentPath !== undefined) {
		trustOptions.push({
			label: `Trust parent folder (${parentPath})`,
			trusted: true,
			updates: [
				{ path: parentPath, decision: true },
				{ path: trustPath, decision: null },
			],
			savedPath: parentPath,
		});
	}
	if (options?.includeSessionOnly) {
		trustOptions.push({ label: "Trust (this session only)", trusted: true, updates: [] });
	}
	trustOptions.push({
		label: "Do not trust",
		trusted: false,
		updates: [{ path: trustPath, decision: false }],
		savedPath: trustPath,
	});
	if (options?.includeSessionOnly) {
		trustOptions.push({ label: "Do not trust (this session only)", trusted: false, updates: [] });
	}
	return trustOptions;
}

function emptyTrustFile(): TrustFileV2 {
	return { version: 2, trust: {}, tracking: {} };
}

function readTrustFile(path: string): TrustFileV2 {
	if (!existsSync(path)) {
		return emptyTrustFile();
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8"));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to read trust store ${path}: ${message}`);
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`Invalid trust store ${path}: expected an object`);
	}

	if ((parsed as { version?: unknown }).version === 2) {
		const record = parsed as { trust?: unknown; tracking?: unknown };
		if (!record.trust || typeof record.trust !== "object" || Array.isArray(record.trust)) throw new Error(`Invalid trust store ${path}: trust must be an object`);
		if (!record.tracking || typeof record.tracking !== "object" || Array.isArray(record.tracking)) throw new Error(`Invalid trust store ${path}: tracking must be an object`);
		const data = emptyTrustFile();
		for (const [key, value] of Object.entries(record.trust)) {
			if (value !== true && value !== false && value !== null) throw new Error(`Invalid trust store ${path}: trust value for ${JSON.stringify(key)} must be true, false, or null`);
			data.trust[key] = value;
		}
		for (const [key, value] of Object.entries(record.tracking)) {
			if (value !== "track" && value !== "dont-track") throw new Error(`Invalid trust store ${path}: tracking value for ${JSON.stringify(key)} is invalid`);
			data.tracking[key] = value;
		}
		return data;
	}
	// Version-1 compatibility: the original file was the trust map itself.
	const data = emptyTrustFile();
	for (const [key, value] of Object.entries(parsed)) {
		if (value !== true && value !== false && value !== null) throw new Error(`Invalid trust store ${path}: value for ${JSON.stringify(key)} must be true, false, or null`);
		data.trust[key] = value;
	}
	return data;
}

function writeTrustFile(path: string, data: TrustFileV2): void {
	const trust: TrustFileV2["trust"] = {};
	for (const key of Object.keys(data.trust).sort()) {
		const value = data.trust[key];
		if (value === true || value === false || value === null) {
			trust[key] = value;
		}
	}
	const tracking: TrustFileV2["tracking"] = {};
	for (const key of Object.keys(data.tracking).sort()) {
		const value = data.tracking[key];
		if (value === "track" || value === "dont-track") tracking[key] = value;
	}
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ version: 2, trust, tracking }, null, 2)}\n`, "utf-8");
}

function acquireTrustLockSync(path: string): () => void {
	const trustDir = dirname(path);
	mkdirSync(trustDir, { recursive: true });
	const maxAttempts = 10;
	const delayMs = 20;
	let lastError: unknown;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			return lockfile.lockSync(trustDir, { realpath: false, lockfilePath: `${path}.lock` });
		} catch (error) {
			const code =
				typeof error === "object" && error !== null && "code" in error
					? String((error as { code?: unknown }).code)
					: undefined;
			if (code !== "ELOCKED" || attempt === maxAttempts) {
				throw error;
			}
			lastError = error;
			const start = Date.now();
			while (Date.now() - start < delayMs) {
				// Sleep synchronously to avoid changing trust store callers to async.
			}
		}
	}

	if (lastError instanceof Error) {
		throw lastError;
	}
	throw new Error("Failed to acquire trust store lock");
}

function withTrustFileLock<T>(path: string, fn: () => T): T {
	const release = acquireTrustLockSync(path);
	try {
		return fn();
	} finally {
		release();
	}
}

/**
 * Returns true when cwd has project-local resources that must be gated by
 * project trust: trust-requiring entries under cwd/.pi, or .agents/skills in
 * cwd or one of its ancestors. Returns false when no such project resources
 * exist. The user/global ~/.agents/skills directory is always treated as a
 * trusted user resource and is ignored here, even when cwd is $HOME.
 */
export function hasTrustRequiringProjectResources(cwd: string): boolean {
	const homeDir = canonicalizePath(resolvePath(process.env.HOME || homedir()));
	const userAgentsSkillsDir = join(homeDir, ".agents", "skills");
	let currentDir = canonicalizePath(resolvePath(cwd));

	const configDir = join(currentDir, CONFIG_DIR_NAME);
	if (TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES.some((entry) => existsSync(join(configDir, entry)))) {
		return true;
	}

	while (true) {
		const agentsSkillsDir = join(currentDir, ".agents", "skills");
		if (agentsSkillsDir !== userAgentsSkillsDir && existsSync(agentsSkillsDir)) {
			return true;
		}

		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) {
			return false;
		}
		currentDir = parentDir;
	}
}

export class ProjectTrustStore {
	private trustPath: string;

	constructor(agentDir: string) {
		this.trustPath = join(resolvePath(agentDir), "trust.json");
	}

	get(cwd: string): ProjectTrustDecision {
		return this.getEntry(cwd)?.decision ?? null;
	}

	getEntry(cwd: string): ProjectTrustStoreEntry | null {
		return withTrustFileLock(this.trustPath, () => {
			const data = readTrustFile(this.trustPath);
			return findNearestTrustEntry(data.trust, cwd);
		});
	}

	getTracking(cwd: string): ProjectTrackingDecision {
		const key = normalizeCwd(cwd);
		return withTrustFileLock(this.trustPath, () => readTrustFile(this.trustPath).tracking[key] ?? null);
	}

	setTracking(cwd: string, decision: ProjectTrackingDecision): void {
		const key = normalizeCwd(cwd);
		withTrustFileLock(this.trustPath, () => {
			const data = readTrustFile(this.trustPath);
			if (decision === null) delete data.tracking[key];
			else data.tracking[key] = decision;
			writeTrustFile(this.trustPath, data);
		});
	}

	removeProject(cwd: string): void {
		const key = normalizeCwd(cwd);
		withTrustFileLock(this.trustPath, () => {
			const data = readTrustFile(this.trustPath);
			delete data.trust[key];
			delete data.tracking[key];
			writeTrustFile(this.trustPath, data);
		});
	}

	set(cwd: string, decision: ProjectTrustDecision): void {
		this.setMany([{ path: cwd, decision }]);
	}

	setMany(decisions: ProjectTrustUpdate[]): void {
		withTrustFileLock(this.trustPath, () => {
			const data = readTrustFile(this.trustPath);
			for (const { path, decision } of decisions) {
				const key = normalizeCwd(path);
				if (decision === null) {
					delete data.trust[key];
				} else {
					data.trust[key] = decision;
				}
			}
			writeTrustFile(this.trustPath, data);
		});
	}
}
