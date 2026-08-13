import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import {
	CHECKPOINT_RESUME,
	CHECKPOINT_START,
	backupSessionJsonl,
	deterministicCheckpoint,
	extractCheckpointEvidence,
	markBackupStatus,
	recallCheckpointSource,
	repairCheckpointSummary,
	verifyCheckpointSummary,
	wrapCheckpointSummary,
} from "../src/core/compaction/checkpoint.ts";

describe("durable compaction checkpoints", () => {
	let tempRoot: string;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "mypi-compaction-checkpoint-"));
		previousAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = join(tempRoot, "agent");
	});

	afterEach(() => {
		if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = previousAgentDir;
	});

	it("uses the exact Claude-style continuation envelope", () => {
		const wrapped = wrapCheckpointSummary("## Active Request\n- Continue testing.", "checkpoint-1");

		expect(wrapped.startsWith(`${CHECKPOINT_START}\n\n`)).toBe(true);
		expect(wrapped.endsWith(CHECKPOINT_RESUME)).toBe(true);
		expect(wrapped).toContain("use recall_compacted_history for checkpoint checkpoint-1");
	});

	it("repairs mechanically provable omissions and verifies the fallback", () => {
		const evidence = extractCheckpointEvidence(
			[
				{ role: "user", content: "Preserve the exact migration constraint.", timestamp: Date.now() },
				{
					role: "toolResult",
					toolCallId: "call-failed",
					toolName: "bash",
					content: [{ type: "text", text: "Exact failure: migration invariant changed" }],
					isError: true,
					timestamp: Date.now(),
				},
			],
			["src/read.ts"],
			["src/changed.ts"],
		);
		const repaired = repairCheckpointSummary("## Active Request\n- Continue.", evidence);

		expect(verifyCheckpointSummary(repaired.summary, evidence)).toEqual([]);
		expect(repaired.summary).toContain("[U1] Preserve the exact migration constraint.");
		expect(repaired.summary).toContain("src/changed.ts");
		expect(repaired.summary).toContain("Exact failure: migration invariant changed");
		expect(verifyCheckpointSummary(deterministicCheckpoint(evidence), evidence)).toEqual([]);
	});

	it("backs up byte-exact JSONL privately and recalls only the checkpoint branch", () => {
		const sourceFile = join(tempRoot, "session.jsonl");
		const lines = [
			{ type: "session", version: 3, id: "session-a", timestamp: new Date().toISOString(), cwd: tempRoot },
			{
				type: "message",
				id: "root-user",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "main branch mandate", timestamp: Date.now() },
			},
			{
				type: "message",
				id: "main-assistant",
				parentId: "root-user",
				timestamp: new Date().toISOString(),
				message: {
					role: "assistant",
					content: [{ type: "text", text: "main branch evidence" }],
					api: "test",
					provider: "test",
					model: "test",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "stop",
					timestamp: Date.now(),
				},
			},
			{
				type: "message",
				id: "sibling-user",
				parentId: "root-user",
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "SIBLING-BRANCH-SECRET", timestamp: Date.now() },
			},
		];
		const exactJsonl = `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
		writeFileSync(sourceFile, exactJsonl);

		const ref = backupSessionJsonl({
			sessionFile: sourceFile,
			sessionId: "session-a",
			sourceBranchHeadId: "main-assistant",
		});
		expect(ref).toBeDefined();
		const backupDir = join(process.env[ENV_AGENT_DIR]!, "compaction-backups", "session-a");
		const backupFile = join(backupDir, `${ref!.checkpointId}.jsonl`);
		const manifestFile = join(backupDir, `${ref!.checkpointId}.manifest.json`);

		expect(readFileSync(backupFile, "utf8")).toBe(exactJsonl);
		expect(statSync(backupDir).mode & 0o777).toBe(0o700);
		expect(statSync(backupFile).mode & 0o777).toBe(0o600);
		expect(statSync(manifestFile).mode & 0o777).toBe(0o600);
		const recall = recallCheckpointSource({ ref: ref!, query: "main branch" });
		expect(recall.text).toContain("main branch mandate");
		expect(recall.text).toContain("main branch evidence");
		expect(recall.text).not.toContain("SIBLING-BRANCH-SECRET");
		expect(recallCheckpointSource({ ref: ref!, query: "SIBLING-BRANCH-SECRET" }).matchedEntries).toBe(0);

		markBackupStatus(ref, "applied");
		expect(JSON.parse(readFileSync(manifestFile, "utf8")).status).toBe("applied");

		chmodSync(backupFile, 0o600);
		writeFileSync(backupFile, `${exactJsonl}corrupt\n`);
		expect(() => recallCheckpointSource({ ref: ref! })).toThrow("integrity check failed");
	});
});
