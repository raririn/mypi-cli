import assert from "node:assert/strict";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  getPersistedSessionStats,
  listPersistedSessions,
  readPersistedSession,
} from "../../src/product/daemon-services.ts";

function sessionLines(input: {
  id: string;
  cwd: string;
  user?: string;
  assistant?: string;
  name?: string;
  timestamp?: string;
}) {
  const timestamp = input.timestamp ?? new Date().toISOString();
  const header = { type: "session", version: 3, id: input.id, timestamp, cwd: input.cwd };
  const entries: Record<string, unknown>[] = [header];
  let parentId: string | null = null;
  if (input.user !== undefined) {
    entries.push({ type: "message", id: `${input.id}-u`, parentId, timestamp, message: { role: "user", content: input.user, timestamp: Date.parse(timestamp) } });
    parentId = `${input.id}-u`;
  }
  if (input.assistant !== undefined) {
    entries.push({
      type: "message",
      id: `${input.id}-a`,
      parentId,
      timestamp,
      message: {
        role: "assistant",
        content: [{ type: "text", text: input.assistant }],
        timestamp: Date.parse(timestamp) + 1,
        usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      },
    });
    parentId = `${input.id}-a`;
  }
  if (input.name !== undefined) entries.push({ type: "session_info", id: `${input.id}-n`, parentId, timestamp, name: input.name });
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

test("daemon persisted-session reads are flat, bounded, cursor-aware, and include archives", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "mypi-daemon-services-"));
  const cwd = join(agentDir, "project");
  const activeDir = join(agentDir, "sessions", "project");
  const archiveDir = join(agentDir, "session-archive", "project");
  try {
    await Promise.all([mkdir(cwd), mkdir(activeDir, { recursive: true }), mkdir(archiveDir, { recursive: true })]);
    await writeFile(join(activeDir, "active.jsonl"), sessionLines({ id: "active", cwd, user: "hello", assistant: "world", name: "Named" }));
    await writeFile(join(archiveDir, "archived.jsonl"), sessionLines({ id: "archived", cwd, user: "old", assistant: "reply" }));

    const activeOnly = await listPersistedSessions({ agentDir, cwd });
    assert.equal(activeOnly.total, 1);
    assert.equal(activeOnly.sessions[0]?.id, "active");
    assert.equal(activeOnly.sessions[0]?.name, "Named");
    assert.equal(activeOnly.sessions[0]?.lastUsage?.totalTokens, 5);

    const all = await listPersistedSessions({ agentDir, cwd, includeArchived: true, limit: 1 });
    assert.equal(all.total, 2);
    assert.equal(all.sessions.length, 1);
    assert.equal(all.hasMore, true);

    const first = await readPersistedSession({ agentDir, id: "active", limit: 2, maxBytes: 1024 });
    assert.equal(first.entries.length, 2);
    assert.equal(first.hasMore, true);
    assert.equal(typeof first.nextCursor, "string");
    const second = await readPersistedSession({ agentDir, id: "active", since: first.nextCursor, limit: 20 });
    assert.ok(second.entries.length >= 1);
    assert.equal(Array.isArray(second.entries), true);

    const stats = await getPersistedSessionStats({ agentDir, id: "active" });
    assert.equal((stats.lastUsage as { totalTokens: number }).totalTokens, 5);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("daemon persisted-session discovery rejects symlink and cross-root paths", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "mypi-daemon-services-safe-"));
  const cwd = join(agentDir, "project");
  const activeDir = join(agentDir, "sessions", "project");
  const outside = join(agentDir, "outside.jsonl");
  try {
    await Promise.all([mkdir(cwd), mkdir(activeDir, { recursive: true })]);
    await writeFile(outside, sessionLines({ id: "outside", cwd, user: "secret", assistant: "hidden" }));
    await symlink(outside, join(activeDir, "link.jsonl"));
    const listed = await listPersistedSessions({ agentDir, includeArchived: true });
    assert.equal(listed.total, 0);
    await assert.rejects(readPersistedSession({ agentDir, sessionFile: outside }), /not found/i);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});
