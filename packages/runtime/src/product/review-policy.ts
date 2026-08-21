import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveProjectTrustRoot } from "../core/trust-manager.ts";
import { REVIEWER_DEFAULT_PROMPT } from "./subagent-prompts.ts";

export const PROJECT_REVIEW_POLICY = join(".mypi", "REVIEW.md");
export const MAX_REVIEW_POLICY_BYTES = 32 * 1024;

export interface ResolvedReviewPolicy {
	readonly policy: string;
	readonly source: "builtin" | "project";
	readonly path?: string;
}

export async function resolveReviewPolicy(cwd: string, projectTrusted: boolean): Promise<ResolvedReviewPolicy> {
	const root = resolveProjectTrustRoot(cwd);
	const path = join(root, PROJECT_REVIEW_POLICY);
	try {
		const info = await lstat(path);
		if (!projectTrusted) throw new Error("REVIEW_POLICY_INVALID: project review policy requires trusted project state.");
		if (info.isSymbolicLink() || !info.isFile() || info.size < 1 || info.size > MAX_REVIEW_POLICY_BYTES) {
			throw new Error(`REVIEW_POLICY_INVALID: ${path} must be a non-empty regular non-symlink file no larger than ${MAX_REVIEW_POLICY_BYTES} bytes.`);
		}
		const policy = (await readFile(path, "utf8")).trim();
		if (!policy) throw new Error(`REVIEW_POLICY_INVALID: ${path} is empty.`);
		return { policy, source: "project", path };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { policy: REVIEWER_DEFAULT_PROMPT, source: "builtin" };
		throw error;
	}
}
