import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveReviewPolicy } from "../../src/product/review-policy.ts";

test("project REVIEW policy replaces the default only for a trusted safe file", async () => {
	const root = await mkdtemp(join(tmpdir(), "mypi-review-policy-"));
	try {
		const missing = await resolveReviewPolicy(root, true);
		assert.equal(missing.source, "builtin");
		assert.match(missing.policy, /concrete defects introduced or exposed/);

		await mkdir(join(root, ".mypi"), { mode: 0o700 });
		await writeFile(join(root, ".mypi", "REVIEW.md"), "Review database migrations for rollback safety.\n", { mode: 0o600 });
		const project = await resolveReviewPolicy(root, true);
		assert.deepEqual(project, {
			policy: "Review database migrations for rollback safety.",
			source: "project",
			path: join(await realpath(root), ".mypi", "REVIEW.md"),
		});
		await assert.rejects(resolveReviewPolicy(root, false), /trusted project/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("project REVIEW policy fails closed for empty, oversized, and symlink files", async () => {
	const root = await mkdtemp(join(tmpdir(), "mypi-review-policy-unsafe-"));
	const policyDir = join(root, ".mypi");
	const policy = join(policyDir, "REVIEW.md");
	try {
		await mkdir(policyDir, { mode: 0o700 });
		await writeFile(policy, "", { mode: 0o600 });
		await assert.rejects(resolveReviewPolicy(root, true), /REVIEW_POLICY_INVALID/);
		await writeFile(policy, "x".repeat(33 * 1024));
		await assert.rejects(resolveReviewPolicy(root, true), /REVIEW_POLICY_INVALID/);
		await rm(policy);
		const outside = join(root, "outside.md");
		await writeFile(outside, "unsafe");
		await symlink(outside, policy);
		await assert.rejects(resolveReviewPolicy(root, true), /REVIEW_POLICY_INVALID/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
