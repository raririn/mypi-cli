import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  cleanupArchivedSessions,
  previewArchiveCleanup,
  runNewSessionMaintenance,
} from "../../src/product/daemon-services.ts";

type MessageInput = { role: string; content: unknown };

async function writeSession(root: string, input: { id: string; cwd: string; at: number; messages: MessageInput[] }) {
  const directory = join(root, "project");
  await mkdir(directory, { recursive: true });
  const timestamp = new Date(input.at).toISOString();
  const entries: Record<string, unknown>[] = [{ type: "session", version: 3, id: input.id, timestamp, cwd: input.cwd }];
  let parentId: string | null = null;
  input.messages.forEach((message, index) => {
    const id = `${input.id}-${index}`;
    entries.push({
      type: "message",
      id,
      parentId,
      timestamp: new Date(input.at + index).toISOString(),
      message: { ...message, timestamp: input.at + index },
    });
    parentId = id;
  });
  const path = join(directory, `${input.id}.jsonl`);
  await writeFile(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, { mode: 0o600 });
  return path;
}

test("new-session maintenance archives only obvious short text-only tests", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "mypi-session-maintenance-short-"));
  const cwd = join(agentDir, "workspace");
  const sessionsRoot = join(agentDir, "sessions");
  try {
    await mkdir(cwd);
    await writeFile(join(agentDir, "config.yaml"), "version: 1\nhistory:\n  maxActive: 100\n  maxArchived: 100\n  shortTestMaxWords: 10\n  autoArchive: true\n");
    const now = Date.now();
    const current = await writeSession(sessionsRoot, { id: "current", cwd, at: now, messages: [] });
    await writeSession(sessionsRoot, { id: "short", cwd, at: now - 10_000, messages: [
      { role: "user", content: "test please" },
      { role: "assistant", content: [{ type: "text", text: "passed" }] },
    ] });
    await writeSession(sessionsRoot, { id: "long", cwd, at: now - 9_000, messages: [
      { role: "user", content: "one two three four five six seven eight nine ten" },
      { role: "assistant", content: [{ type: "text", text: "short" }] },
    ] });
    await writeSession(sessionsRoot, { id: "tool", cwd, at: now - 8_000, messages: [
      { role: "user", content: "test" },
      { role: "assistant", content: [{ type: "text", text: "using tool" }, { type: "toolCall", id: "t", name: "read", arguments: {} }] },
    ] });
    await writeSession(sessionsRoot, { id: "image", cwd, at: now - 7_000, messages: [
      { role: "user", content: [{ type: "text", text: "test" }, { type: "image", mimeType: "image/png", data: "x" }] },
      { role: "assistant", content: [{ type: "text", text: "image" }] },
    ] });
    await writeSession(sessionsRoot, { id: "multi", cwd, at: now - 6_000, messages: [
      { role: "user", content: "test" },
      { role: "assistant", content: [{ type: "text", text: "one" }] },
      { role: "user", content: "again" },
      { role: "assistant", content: [{ type: "text", text: "two" }] },
    ] });

    const result = await runNewSessionMaintenance({ agentDir, sessionId: "current", sessionFile: current, cwd });
    assert.deepEqual(result.archivedShortTests.map((entry) => entry.id), ["short"]);
    assert.equal(result.archivedOverflow.length, 0);
    await assert.rejects(readFile(join(sessionsRoot, "project", "short.jsonl")), /ENOENT/);
    assert.match(await readFile(join(agentDir, "session-archive", "project", "short.jsonl"), "utf8"), /"id":"short"/);
    for (const id of ["current", "long", "tool", "image", "multi"]) {
      assert.match(await readFile(join(sessionsRoot, "project", `${id}.jsonl`), "utf8"), new RegExp(`"id":"${id}"`));
    }
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("active cap archives oldest histories and archive cleanup requires confirmation", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "mypi-session-maintenance-cap-"));
  const cwd = join(agentDir, "workspace");
  const sessionsRoot = join(agentDir, "sessions");
  const archiveRoot = join(agentDir, "session-archive");
  try {
    await mkdir(cwd);
    await writeFile(join(agentDir, "config.yaml"), "version: 1\nhistory:\n  maxActive: 2\n  maxArchived: 1\n  shortTestMaxWords: 1\n  autoArchive: true\n");
    const now = Date.now();
    const current = await writeSession(sessionsRoot, { id: "current", cwd, at: now, messages: [] });
    for (const [index, id] of ["oldest", "middle", "newest"].entries()) {
      await writeSession(sessionsRoot, { id, cwd, at: now - (3 - index) * 10_000, messages: [
        { role: "user", content: "meaningful history with enough words" },
        { role: "assistant", content: [{ type: "text", text: "meaningful response with enough words" }] },
      ] });
    }
    await writeSession(archiveRoot, { id: "archive-old", cwd, at: now - 50_000, messages: [{ role: "user", content: "old" }] });
    await writeSession(archiveRoot, { id: "archive-new", cwd, at: now - 1_000, messages: [{ role: "user", content: "new" }] });

    const result = await runNewSessionMaintenance({ agentDir, sessionId: "current", sessionFile: current, cwd });
    assert.deepEqual(result.archivedOverflow.map((entry) => entry.id).sort(), ["middle", "oldest"]);
    assert.equal(result.activeCount, 2);
    assert.equal(result.archivedExcess, 3);
    assert.equal(result.cleanupCommand, "/archive-cleanup");

    const preview = await previewArchiveCleanup(cwd, agentDir);
    assert.equal(preview.maxArchived, 1);
    assert.equal(preview.excess, 3);
    await assert.rejects(cleanupArchivedSessions(cwd, { agentDir, confirm: false }), /confirmation/i);
    assert.equal((await previewArchiveCleanup(cwd, agentDir)).archivedCount, 4, "preview never deletes");

    const cleanup = await cleanupArchivedSessions(cwd, { agentDir, confirm: true });
    assert.equal(cleanup.deleted.length, 3);
    assert.equal(cleanup.failures.length, 0);
    const after = await previewArchiveCleanup(cwd, agentDir);
    assert.equal(after.archivedCount, 1);
    assert.equal(after.excess, 0);
    assert.equal(after.candidates.length, 0);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});
