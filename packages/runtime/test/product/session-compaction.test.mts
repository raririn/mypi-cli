import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	clearDaemonServiceCache,
	compactPersistedSession,
	planSessionCompaction,
} from "../../src/product/daemon-services.ts";

const stamp = new Date().toISOString();
const line = (entry: Record<string, unknown>) => JSON.stringify({ timestamp: stamp, ...entry });

test("plan keeps only the deepest snapshot per type per branch and reparents survivors", () => {
	const content = [
		line({ type: "session", version: 3, id: "s1", cwd: "/w" }),
		line({ type: "message", id: "m1", parentId: null, message: { role: "user", content: "hi" } }),
		line({ type: "custom", customType: "mypi-plan-goal", id: "g1", parentId: "m1", data: { v: 1 } }),
		line({ type: "custom", customType: "mypi-plan-goal", id: "g2", parentId: "g1", data: { v: 2 } }),
		line({ type: "custom", customType: "other-event", id: "e1", parentId: "g2", data: { note: "kept" } }),
		line({ type: "custom", customType: "mypi-plan-goal", id: "g3", parentId: "e1", data: { v: 3 } }),
		line({ type: "message", id: "m2", parentId: "g3", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }),
	].join("\n") + "\n";
	const plan = planSessionCompaction(content);
	assert.equal(plan.removedEntries, 2); // g1, g2 shadowed by g3
	const kept = plan.output.trim().split("\n").map((raw) => JSON.parse(raw) as { id?: string; parentId?: string | null; customType?: string });
	const ids = kept.map((entry) => entry.id);
	assert.deepEqual(ids, ["s1", "m1", "e1", "g3", "m2"]);
	// e1's parent chain skips the removed g1/g2 and lands on m1.
	assert.equal(kept.find((entry) => entry.id === "e1")?.parentId, "m1");
	// Non-snapshot custom events survive.
	assert.ok(kept.some((entry) => entry.customType === "other-event"));
});

test("plan is branch-aware: each fork keeps its own deepest snapshot", () => {
	const content = [
		line({ type: "session", version: 3, id: "s1", cwd: "/w" }),
		line({ type: "message", id: "m1", parentId: null, message: { role: "user", content: "root" } }),
		line({ type: "custom", customType: "mypi-goal", id: "gA", parentId: "m1", data: { v: "shared" }, snapshot: true }),
		// Branch 1 continues past gA with a deeper snapshot.
		line({ type: "custom", customType: "mypi-goal", id: "gB", parentId: "gA", data: { v: "b1" }, snapshot: true }),
		line({ type: "message", id: "m2", parentId: "gB", message: { role: "assistant", content: [{ type: "text", text: "one" }] } }),
		// Branch 2 forks straight off gA — for that leaf gA is the deepest.
		line({ type: "message", id: "m3", parentId: "gA", message: { role: "assistant", content: [{ type: "text", text: "two" }] } }),
	].join("\n") + "\n";
	const plan = planSessionCompaction(content);
	assert.equal(plan.removedEntries, 0); // gA load-bearing for branch 2, gB for branch 1
});

test("plan preserves unparseable trailing lines and empty input", () => {
	const torn = [
		line({ type: "session", version: 3, id: "s1", cwd: "/w" }),
		line({ type: "custom", customType: "mypi-plan-goal", id: "g1", parentId: null, data: { v: 1 } }),
		line({ type: "custom", customType: "mypi-plan-goal", id: "g2", parentId: "g1", data: { v: 2 } }),
		'{"type":"message","id":"torn' ,
	].join("\n");
	const plan = planSessionCompaction(torn);
	assert.equal(plan.removedEntries, 1);
	assert.ok(plan.output.includes('{"type":"message","id":"torn'));
	assert.deepEqual(planSessionCompaction("").removedEntries, 0);
});

test("compactPersistedSession rewrites the stored file atomically and reports metrics", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "mypi-compaction-"));
	const activeDir = join(agentDir, "sessions", "project");
	await mkdir(activeDir, { recursive: true });
	const cwd = join(agentDir, "workspace");
	await mkdir(cwd, { recursive: true });
	const entries = [
		line({ type: "session", version: 3, id: "big", cwd }),
		line({ type: "message", id: "m1", parentId: null, message: { role: "user", content: "hello", timestamp: Date.now() } }),
	];
	let parent = "m1";
	for (let index = 0; index < 200; index += 1) {
		const id = `g${index}`;
		entries.push(line({ type: "custom", customType: "mypi-plan-goal", id, parentId: parent, data: { revision: index, blob: "x".repeat(500) } }));
		parent = id;
	}
	entries.push(line({ type: "message", id: "m2", parentId: parent, message: { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: Date.now() } }));
	const sessionFile = join(activeDir, "big.jsonl");
	await writeFile(sessionFile, `${entries.join("\n")}\n`);
	clearDaemonServiceCache();

	const result = await compactPersistedSession("big", agentDir);
	assert.equal(result.compacted, true);
	assert.equal(result.removedEntries, 199); // only the deepest snapshot survives
	assert.ok(result.bytesAfter < result.bytesBefore / 50);

	const rewritten = (await readFile(sessionFile, "utf8")).trim().split("\n").map((raw) => JSON.parse(raw) as { id?: string; parentId?: string | null; customType?: string });
	assert.equal(rewritten.filter((entry) => entry.customType === "mypi-plan-goal").length, 1);
	assert.equal(rewritten.find((entry) => entry.customType === "mypi-plan-goal")?.id, "g199");
	// The assistant message reparents onto the surviving snapshot; the
	// snapshot reparents onto the first message — the chain must resolve.
	assert.equal(rewritten.find((entry) => entry.id === "m2")?.parentId, "g199");
	assert.equal(rewritten.find((entry) => entry.id === "g199")?.parentId, "m1");

	// Second pass is a no-op.
	clearDaemonServiceCache();
	const again = await compactPersistedSession("big", agentDir);
	assert.equal(again.compacted, false);
	assert.equal(again.removedEntries, 0);
});
