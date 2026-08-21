import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface WorkspaceSnapshot {
	status: string;
	diffStat: string;
	fingerprint: string;
}

export async function workspaceSnapshot(cwd: string): Promise<WorkspaceSnapshot> {
	try {
		const evidence = await collectGitEvidence(cwd);
		return {
			status: evidence.status.slice(0, 32_000),
			diffStat: evidence.diffStat.slice(0, 32_000),
			fingerprint: createHash("sha256").update(JSON.stringify(evidence)).digest("hex"),
		};
	} catch {
		return {
			status: "Git status unavailable.",
			diffStat: "Git diff unavailable.",
			fingerprint: createHash("sha256").update(`unavailable:${resolve(cwd)}`).digest("hex"),
		};
	}
}

export async function reviewSnapshot(cwd: string): Promise<string | undefined> {
	try {
		const evidence = await collectGitEvidence(cwd);
		const snapshot = [
			"## Working-tree status",
			evidence.status || "Clean tracked status.",
			"## Unstaged diff",
			evidence.unstaged || "None.",
			"## Staged diff",
			evidence.staged || "None.",
			"## Untracked paths",
			evidence.untracked.join("\n") || "None.",
			...(evidence.truncated ? ["## Truncation", evidence.truncated] : []),
		].join("\n\n");
		return snapshot.length > 96_000
			? `${snapshot.slice(0, 96_000)}\n\n[Review snapshot truncated at 96000 characters.]`
			: snapshot;
	} catch {
		return undefined;
	}
}

async function collectGitEvidence(cwd: string): Promise<{
	status: string;
	diffStat: string;
	unstaged: string;
	staged: string;
	untracked: string[];
	untrackedHashes: string;
	truncated?: string;
}> {
	const options = { cwd, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 };
	const [status, diffStat, unstaged, staged, untrackedResult] = await Promise.all([
		execFileAsync("git", ["status", "--short", "--untracked-files=all"], options),
		execFileAsync("git", ["diff", "--stat", "--no-ext-diff"], options),
		execFileAsync("git", ["diff", "--no-ext-diff", "--unified=3", "--", "."], options),
		execFileAsync("git", ["diff", "--cached", "--no-ext-diff", "--unified=3", "--", "."], options),
		execFileAsync("git", ["ls-files", "--others", "--exclude-standard"], options),
	]);
	const allUntracked = untrackedResult.stdout.split("\n").filter(Boolean);
	const untracked = allUntracked.slice(0, 200);
	const truncation: string[] = [];
	const bound = (value: string, maximum: number, label: string): string => {
		if (value.length <= maximum) return value;
		truncation.push(`${label} truncated from ${value.length} to ${maximum} characters.`);
		return `${value.slice(0, maximum)}\n[${label} truncated]`;
	};
	let untrackedHashes = "";
	if (untracked.length) {
		untrackedHashes = (await execFileAsync("git", ["hash-object", "--no-filters", "--", ...untracked], options)).stdout;
	}
	return {
		status: bound(status.stdout, 32_000, "status"),
		diffStat: `${diffStat.stdout}${staged.stdout ? "\n(staged changes present)" : ""}`,
		unstaged: bound(unstaged.stdout, 64_000, "unstaged diff"),
		staged: bound(staged.stdout, 64_000, "staged diff"),
		untracked,
		untrackedHashes,
		...((allUntracked.length > untracked.length || truncation.length) ? {
			truncated: [
				...truncation,
				...(allUntracked.length > untracked.length ? [`Untracked paths truncated from ${allUntracked.length} to ${untracked.length}.`] : []),
			].join(" "),
		} : {}),
	};
}
