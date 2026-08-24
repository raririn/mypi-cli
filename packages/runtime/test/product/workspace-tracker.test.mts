import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectTrustStore } from "../../src/core/trust-manager.ts";
import { DEFAULT_GLOBAL_CONFIG } from "../../src/product/global-config.ts";
import { estimateWorkspaceTracking, WorkspaceTracker } from "../../src/product/workspace-tracker.ts";

test("tracking consent migrates the legacy trust map without inheriting tracking", async () => {
  const root = await mkdtemp(join(tmpdir(), "mypi-tracking-trust-"));
  const agentDir = join(root, "agent");
  const parent = join(root, "parent");
  const child = join(parent, "child");
  await mkdir(child, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  const canonicalParent = await realpath(parent);
  await writeFile(join(agentDir, "trust.json"), `${JSON.stringify({ [canonicalParent]: true })}\n`, { mode: 0o600 });
  try {
    const store = new ProjectTrustStore(agentDir);
    assert.equal(store.get(child), true);
    assert.equal(store.getTracking(child), null, "tracking is exact-root and never inherited");
    store.setTracking(child, "track");
    assert.equal(store.getTracking(child), "track");
    const source = JSON.parse(await readFile(join(agentDir, "trust.json"), "utf8"));
    assert.equal(source.version, 2);
    assert.equal(source.trust[canonicalParent], true);
    assert.equal(source.tracking[await realpath(child)], "track");
    store.removeProject(child);
    assert.equal(store.get(child), true, "project removal permits parent trust to apply again");
    assert.equal(store.getTracking(child), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tracker ignores user ignore rules, excludes sensitive paths, and retains text-only net changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "mypi-workspace-tracker-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(join(workspace, ".ssh"), { recursive: true });
  await writeFile(join(workspace, ".gitignore"), "dist/\n");
  await mkdir(join(workspace, "dist"), { recursive: true });
  await writeFile(join(workspace, "dist", "result.txt"), "before\n");
  await writeFile(join(workspace, ".ssh", "id_ed25519"), "secret\n");
  await writeFile(join(workspace, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]));
  try {
    const tracker = await WorkspaceTracker.open(agentDir, workspace, DEFAULT_GLOBAL_CONFIG.tracking);
    const first = await tracker.createCheckpoint({ sessionId: "s1", userMessageId: "u1", promptPreview: "first prompt" });
    await writeFile(join(workspace, "dist", "result.txt"), "after\nline\n");
    await writeFile(join(workspace, "created.txt"), "created\n");
    await writeFile(join(workspace, ".ssh", "id_ed25519"), "changed secret\n");
    await writeFile(join(workspace, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2]));
    const changes = await tracker.finalizeChangeSet({ sessionId: "s1", checkpointId: first.id });
    assert.equal(changes.basis, "tracker");
    assert.equal(changes.estimated, false);
    assert.ok(changes.files.some((file) => file.path === "dist/result.txt" && file.diffAvailable));
    assert.ok(changes.files.some((file) => file.path === "created.txt" && file.status === "added"));
    assert.ok(changes.files.some((file) => file.path === "image.png" && file.opaque && !file.diffAvailable));
    assert.ok(!changes.files.some((file) => file.path.includes(".ssh")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("checkpoint retention is per session and rewind preserves foreign checkpoints", async () => {
  const root = await mkdtemp(join(tmpdir(), "mypi-workspace-rewind-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "value.txt"), "zero\n");
  const config = { ...DEFAULT_GLOBAL_CONFIG.tracking, maxSessionCheckpoints: 3, maxDetachedCheckpoints: 1 };
  try {
    const tracker = await WorkspaceTracker.open(agentDir, workspace, config);
    const a1 = await tracker.createCheckpoint({ sessionId: "a", userMessageId: "a1", promptPreview: "A one" });
    await writeFile(join(workspace, "value.txt"), "one\n");
    await tracker.createCheckpoint({ sessionId: "b", userMessageId: "b1", promptPreview: "B one" });
    await writeFile(join(workspace, "value.txt"), "two\n");
    await tracker.createCheckpoint({ sessionId: "a", userMessageId: "a2", promptPreview: "A two" });
    await writeFile(join(workspace, "value.txt"), "three\n");
    const a3 = await tracker.createCheckpoint({ sessionId: "a", userMessageId: "a3", promptPreview: "A three" });
    await writeFile(join(workspace, "value.txt"), "four\n");
    await tracker.createCheckpoint({ sessionId: "a", userMessageId: "a4", promptPreview: "A four" });
    assert.equal((await tracker.listCheckpoints("a")).length, 3);
    assert.ok(!(await tracker.listCheckpoints("a")).some((item) => item.id === a1.id));

    const preview = await tracker.previewRewind("a", a3.id);
    const result = await tracker.rewind({ sessionId: "a", checkpointId: a3.id, expectedSequence: preview.sequence, expectedGeneration: preview.generation });
    assert.equal(result.removed, 2, "the selected checkpoint and every later owned checkpoint are removed");
    assert.equal(await readFile(join(workspace, "value.txt"), "utf8"), "three\n");
    assert.equal((await tracker.listCheckpoints("b")).length, 1, "foreign checkpoint remains available");

    const lowerLimit = await WorkspaceTracker.open(agentDir, workspace, { ...config, maxSessionCheckpoints: 1 });
    assert.equal((await lowerLimit.listCheckpoints("a")).length, 1, "the checkpoint preceding the inclusive rewind remains");
    await lowerLimit.createCheckpoint({ sessionId: "a", userMessageId: "a5", promptPreview: "A five" });
    assert.equal((await lowerLimit.listCheckpoints("a")).length, 1, "the new limit applies at the next checkpoint");
    await lowerLimit.pruneDetached("a");
    assert.equal((await lowerLimit.listCheckpoints("a")).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rewind rolls workspace back when transcript truncation fails and clears all owned tracking state on success", async () => {
  const root = await mkdtemp(join(tmpdir(), "mypi-workspace-rewind-transaction-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "value.txt"), "before\n");
  try {
    const tracker = await WorkspaceTracker.open(agentDir, workspace, DEFAULT_GLOBAL_CONFIG.tracking);
    const first = await tracker.createCheckpoint({ sessionId: "s1", userMessageId: "u1", promptPreview: "first" });
    await writeFile(join(workspace, "value.txt"), "after first\n");
    await tracker.finalizeChangeSet({ sessionId: "s1", checkpointId: first.id });
    const second = await tracker.createCheckpoint({ sessionId: "s1", userMessageId: "u2", promptPreview: "second" });
    await writeFile(join(workspace, "value.txt"), "current\n");
    const preview = await tracker.previewRewind("s1", first.id);

    await assert.rejects(
      tracker.rewind(
        { sessionId: "s1", checkpointId: first.id, expectedSequence: preview.sequence, expectedGeneration: preview.generation },
        async () => { throw new Error("fork failed"); },
      ),
      /fork failed/,
    );
    assert.equal(await readFile(join(workspace, "value.txt"), "utf8"), "current\n");
    assert.deepEqual((await tracker.listCheckpoints("s1")).map((checkpoint) => checkpoint.id), [second.id, first.id]);
    assert.equal((await tracker.listChangeSets("s1")).length, 1);

    let transcriptTruncated = false;
    const result = await tracker.rewind(
      { sessionId: "s1", checkpointId: first.id, expectedSequence: preview.sequence, expectedGeneration: preview.generation },
      async () => { transcriptTruncated = true; },
    );
    assert.equal(transcriptTruncated, true);
    assert.equal(result.removed, 2);
    assert.equal(result.clearedChangeSets, 1);
    assert.equal(await readFile(join(workspace, "value.txt"), "utf8"), "before\n");
    assert.deepEqual(await tracker.listCheckpoints("s1"), []);
    assert.deepEqual(await tracker.listChangeSets("s1"), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace estimate applies the approved warning thresholds", async () => {
  const root = await mkdtemp(join(tmpdir(), "mypi-workspace-estimate-"));
  try {
    await writeFile(join(root, "small.txt"), "small\n");
    const estimate = await estimateWorkspaceTracking(root, { ...DEFAULT_GLOBAL_CONFIG.tracking, warningFiles: 1, warningBytes: 1 });
    assert.equal(estimate.files, 1);
    assert.equal(estimate.warning, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
