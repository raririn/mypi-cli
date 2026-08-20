import assert from "node:assert/strict";
import { mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  clearDaemonServiceCache,
  getPersistedSessionStats,
  listDaemonExtensions,
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

    await writeFile(join(activeDir, "large.jsonl"), sessionLines({ id: "large", cwd, user: "x".repeat(2_000), assistant: "reply" }));
    const headerPage = await readPersistedSession({ agentDir, id: "large", limit: 1, maxBytes: 1024 });
    assert.equal(headerPage.entries.length, 1);
    assert.equal(headerPage.nextCursor, "large", "the session header ID is a valid continuation cursor");
    await assert.rejects(readPersistedSession({ agentDir, id: "large", since: "large", limit: 1, maxBytes: 1024 }), /too small/i);
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
    await symlink(outside, join(activeDir, "000-link.jsonl"));
    await writeFile(join(activeDir, "zzz-valid.jsonl"), sessionLines({ id: "valid", cwd, user: "safe", assistant: "visible" }));
    const listed = await listPersistedSessions({ agentDir, includeArchived: true });
    assert.equal(listed.total, 1, "a rejected symlink does not suppress safe sibling histories");
    assert.equal(listed.sessions[0]?.id, "valid");
    await assert.rejects(readPersistedSession({ agentDir, sessionFile: outside }), /not found/i);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("unattached resource inventory executes project extensions only after persisted trust", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "mypi-daemon-inventory-trust-"));
  const cwd = join(agentDir, "project");
  const extensionDir = join(cwd, ".mypi", "extensions");
  const sentinel = join(agentDir, "project-extension-loaded.txt");
  try {
    await mkdir(extensionDir, { recursive: true });
    await writeFile(join(extensionDir, "qa-project.ts"), `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(sentinel)}, "loaded\\n");
export default function qaProject(pi) {
  pi.registerCommand("qa-project", { description: "QA project extension", handler: async () => {} });
}
`);

    clearDaemonServiceCache();
    const untrusted = await listDaemonExtensions(cwd, agentDir);
    assert.equal(untrusted.some((extension) => extension.name.includes("qa-project")), false);
    await assert.rejects(realpath(sentinel), /ENOENT/);

    const canonicalCwd = await realpath(cwd);
    await writeFile(join(agentDir, "trust.json"), `${JSON.stringify({ [canonicalCwd]: true }, null, 2)}\n`, { mode: 0o600 });
    clearDaemonServiceCache();
    const trusted = await listDaemonExtensions(cwd, agentDir);
    assert.equal(trusted.some((extension) => extension.name.includes("qa-project")), true);
    assert.equal(await readFile(sentinel, "utf8"), "loaded\n");
  } finally {
    clearDaemonServiceCache();
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("persisted stats lookup is not truncated by the listing page limit", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "mypi-daemon-stats-scale-"));
  const cwd = join(agentDir, "project");
  const activeDir = join(agentDir, "sessions", "project");
  try {
    await Promise.all([mkdir(cwd), mkdir(activeDir, { recursive: true })]);
    const oldTimestamp = new Date(1_700_000_000_000).toISOString();
    await writeFile(join(activeDir, "target.jsonl"), sessionLines({ id: "target-beyond-page", cwd, user: "old", assistant: "target", timestamp: oldTimestamp }));
    for (let offset = 0; offset < 1_000; offset += 100) {
      await Promise.all(Array.from({ length: 100 }, (_, index) => {
        const id = `newer-${offset + index}`;
        return writeFile(join(activeDir, `${id}.jsonl`), sessionLines({ id, cwd, user: "new", assistant: "history" }));
      }));
    }
    const page = await listPersistedSessions({ agentDir, limit: 1_000 });
    assert.equal(page.total, 1_001);
    assert.equal(page.sessions.some((session) => session.id === "target-beyond-page"), false);
    const stats = await getPersistedSessionStats({ agentDir, id: "target-beyond-page" });
    assert.equal(stats.sessionId, "target-beyond-page");
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});
