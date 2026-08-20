import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test, { describe } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import lockfile from "@bybrave/proper-lockfile2";
import archiveManageExtension from "../../../src/product/archive-manage.ts";

const ARCHIVE_TOOLS = [
  "session_archive_stats",
  "list_session_archives",
  "inspect_session_archive",
  "archive_session",
  "archive_sessions_older_than",
  "archive_sessions_with_max_user_messages",
  "restore_archived_session",
  "delete_archived_session",
  "delete_archived_sessions_older_than",
];
const HOUR_MS = 60 * 60 * 1000;

function createHarness() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  let activeTools = ["read", "bash"];
  const sentMessages: string[] = [];
  const statuses: Array<string | undefined> = [];
  let runtimeReady = false;
  const requireRuntime = () => {
    if (!runtimeReady) throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading.");
  };
  const api = {
    registerTool(tool: any) { tools.set(tool.name, tool); activeTools.push(tool.name); },
    registerCommand(name: string, command: any) { commands.set(name, command); },
    on(name: string, handler: (event: any, ctx: any) => any) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    getActiveTools() { requireRuntime(); return [...activeTools]; },
    setActiveTools(names: string[]) { requireRuntime(); activeTools = [...names]; },
    getAllTools() { requireRuntime(); return [...tools.values()]; },
    sendUserMessage(message: string) { requireRuntime(); sentMessages.push(message); },
  };
  const makeContext = (sessionManager: any) => ({
    sessionManager,
    isIdle: () => true,
    ui: {
      setStatus: (_key: string, value: string | undefined) => statuses.push(value),
      notify: () => undefined,
      editor: async () => undefined,
    },
  });
  const emit = async (name: string, event: any, ctx: any) => {
    let result;
    for (const handler of handlers.get(name) ?? []) result = await handler(event, ctx);
    return result;
  };
  return {
    api,
    tools,
    commands,
    makeContext,
    emit,
    finishLoading: () => { runtimeReady = true; },
    sentMessages,
    statuses,
    getActiveTools: () => activeTools,
  };
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

function setTestAgentDir(agentDir: string): () => void {
  const previousPublic = process.env.MYPI_AGENT_DIR;
  const previousInternal = process.env.MYPI_CODING_AGENT_DIR;
  process.env.MYPI_AGENT_DIR = agentDir;
  process.env.MYPI_CODING_AGENT_DIR = agentDir;
  return () => {
    if (previousPublic === undefined) delete process.env.MYPI_AGENT_DIR;
    else process.env.MYPI_AGENT_DIR = previousPublic;
    if (previousInternal === undefined) delete process.env.MYPI_CODING_AGENT_DIR;
    else process.env.MYPI_CODING_AGENT_DIR = previousInternal;
  };
}

function createPersistedSession(workspace: string, userText: string, timestamp: number) {
  const session = createTestSession(workspace);
  appendTurn(session, userText, timestamp);
  return session;
}

function createSessionWithTurns(workspace: string, label: string, count: number, timestamp = Date.now()) {
  const session = createTestSession(workspace);
  for (let index = 0; index < count; index++) appendTurn(session, `${label} ${index + 1}`, timestamp + index * 2);
  return session;
}

function createTestSession(workspace: string) {
  const agentDir = process.env.MYPI_AGENT_DIR;
  assert.ok(agentDir, "archive fixtures require an isolated MYPI_AGENT_DIR");
  return SessionManager.create(workspace, join(agentDir, "sessions", "archive-manager-fixtures"));
}

function appendTurn(session: ReturnType<typeof SessionManager.create>, userText: string, timestamp: number): string {
  session.appendMessage({ role: "user", content: userText, timestamp });
  return session.appendMessage(assistantMessage(`${userText} response`, timestamp + 1));
}

describe("archive manager", { concurrency: false }, () => {
test("archive tools are active only for an /archive-manage agent turn", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-archive-extension-scope-"));
  const restoreAgentDir = setTestAgentDir(agentDir);
  try {
    const current = createTestSession(join(agentDir, "workspace"));
    const harness = createHarness();
    archiveManageExtension(harness.api as any);
    const context = harness.makeContext(current);

    assert.deepEqual(harness.getActiveTools(), ["read", "bash", ...ARCHIVE_TOOLS]);
    harness.finishLoading();
    await harness.emit("session_start", { reason: "startup" }, context);
    assert.deepEqual(harness.getActiveTools(), ["read", "bash"]);
    const blocked = await harness.emit("tool_call", { toolName: "archive_sessions_older_than" }, context);
    assert.equal(blocked.block, true);

    await harness.commands.get("archive-manage").handler("show archives", context);
    assert.deepEqual(harness.getActiveTools(), ["read", "bash", ...ARCHIVE_TOOLS]);
    assert.deepEqual(harness.sentMessages, ["show archives"]);

    await harness.emit("agent_end", {}, context);
    assert.deepEqual(harness.getActiveTools(), ["read", "bash"]);
  } finally {
    restoreAgentDir();
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("archive discovery ignores a conflicting stock-Pi peer profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "mypi-archive-extension-isolation-"));
  const mypiAgentDir = join(root, "mypi-agent");
  const stockAgentDir = join(root, "stock-agent");
  const restoreAgentDir = setTestAgentDir(mypiAgentDir);
  const previousStockAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = stockAgentDir;
  try {
    const mypiSession = SessionManager.create(
      join(root, "mypi-workspace"),
      join(mypiAgentDir, "sessions", "mypi-fixture"),
    );
    appendTurn(mypiSession, "mypi-only", Date.now());
    const stockSession = SessionManager.create(
      join(root, "stock-workspace"),
      join(stockAgentDir, "sessions", "stock-fixture"),
    );
    appendTurn(stockSession, "stock-only", Date.now());

    const harness = createHarness();
    archiveManageExtension(harness.api as any);
    harness.finishLoading();
    const context = harness.makeContext(mypiSession);
    await harness.commands.get("archive-manage").handler("manage", context);
    const result = await harness.tools.get("list_session_archives").execute(
      "list",
      { state: "active", include_preview: true },
      undefined,
      undefined,
      context,
    );
    assert.match(result.content[0].text, /mypi-only/);
    assert.doesNotMatch(result.content[0].text, /stock-only/);
  } finally {
    if (previousStockAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousStockAgentDir;
    restoreAgentDir();
    await rm(root, { recursive: true, force: true });
  }
});

test("session listings are compact, filtered, paginated, and preview-free by default", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-archive-extension-list-"));
  const restoreAgentDir = setTestAgentDir(agentDir);
  try {
    const workspace = join(agentDir, "workspace");
    const now = Date.now();
    const current = createPersistedSession(workspace, "current", now);
    const longPrompt = `long-preview-start ${"token-heavy-content ".repeat(500)} long-preview-end`;
    const older = createPersistedSession(workspace, longPrompt, now - 48 * HOUR_MS);
    createPersistedSession(workspace, "second old session", now - 36 * HOUR_MS);

    const harness = createHarness();
    archiveManageExtension(harness.api as any);
    harness.finishLoading();
    const context = harness.makeContext(current);
    await harness.commands.get("archive-manage").handler("manage", context);

    const listTool = harness.tools.get("list_session_archives");
    const firstPage = await listTool.execute(
      "list",
      { state: "active", older_than_hours: 24, limit: 1 },
      undefined,
      undefined,
      context,
    );
    assert.match(firstPage.content[0].text, /Matched 2 stored sessions \(unarchived 2, archived 0\); showing 1-1\. Use offset=1 for more\./);
    assert.equal(firstPage.content[0].text.includes("long-preview-start"), false);
    const firstMetadata = JSON.parse(firstPage.content[0].text.split("\n")[1]);
    assert.equal(firstMetadata.storageState, "unarchived");
    assert.equal(firstMetadata.userMessageCount, 1);
    assert.equal(firstMetadata.writerState, "unlocked");
    assert.equal(firstPage.content[0].text.includes("long-preview-end"), false);
    assert.equal(firstPage.content[0].text.split("\n").length, 2);

    const previewPage = await listTool.execute(
      "list-preview",
      { state: "active", older_than_hours: 24, limit: 2, include_preview: true },
      undefined,
      undefined,
      context,
    );
    assert.match(previewPage.content[0].text, /long-preview-start/);
    assert.equal(previewPage.content[0].text.includes("long-preview-end"), false);
    assert.ok(previewPage.content[0].text.length < 1_500);

    const inspection = await harness.tools.get("inspect_session_archive").execute(
      "inspect",
      { session_id: older.getSessionId(), state: "active" },
      undefined,
      undefined,
      context,
    );
    const metadata = JSON.parse(inspection.content[0].text);
    assert.equal(metadata.sessionId, older.getSessionId());
    assert.equal(metadata.storageState, "unarchived");
    assert.equal(metadata.userMessageCount, 1);
    assert.equal(metadata.writerState, "unlocked");
    assert.match(metadata.preview, /^long-preview-start/);
    assert.ok(metadata.preview.length <= 1_000);
  } finally {
    restoreAgentDir();
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("bulk age tools archive safely and permanently delete only matching archives", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-archive-extension-bulk-"));
  const restoreAgentDir = setTestAgentDir(agentDir);
  try {
    const workspace = join(agentDir, "workspace");
    const now = Date.now();
    const current = createPersistedSession(workspace, "old current", now - 72 * HOUR_MS);
    const oldTarget = createPersistedSession(workspace, "old target", now - 48 * HOUR_MS);
    const leasedTarget = createPersistedSession(workspace, "leased target", now - 36 * HOUR_MS);
    const recentTarget = createPersistedSession(workspace, "recent target", now - HOUR_MS);
    const oldTargetFile = oldTarget.getSessionFile()!;
    const leasedTargetFile = leasedTarget.getSessionFile()!;
    const recentTargetFile = recentTarget.getSessionFile()!;
    await writeFile(`${leasedTargetFile}.lease`, "test lease");

    const harness = createHarness();
    archiveManageExtension(harness.api as any);
    harness.finishLoading();
    const context = harness.makeContext(current);
    await harness.commands.get("archive-manage").handler("archive old sessions", context);

    const stats = await harness.tools.get("session_archive_stats").execute(
      "stats",
      { older_than_hours: 24 },
      undefined,
      undefined,
      context,
    );
    assert.match(stats.content[0].text, /Unarchived stored: 4 total; 3 older than 24h/);
    assert.match(stats.content[0].text, /Writer-protected unarchived now: 1 .*unknown 1/);

    const archived = await harness.tools.get("archive_sessions_older_than").execute(
      "bulk-archive",
      { older_than_hours: 24 },
      undefined,
      undefined,
      context,
    );
    assert.match(archived.content[0].text, /Archived 1\/3 matching sessions older than 24h/);
    assert.match(archived.content[0].text, /current session/);
    assert.match(archived.content[0].text, /active writer lease/);
    assert.equal(await exists(oldTargetFile), false);
    assert.equal(await exists(current.getSessionFile()!), true);
    assert.equal(await exists(leasedTargetFile), true);
    assert.equal(await exists(recentTargetFile), true);

    const archivedList = await harness.tools.get("list_session_archives").execute(
      "list-archived",
      { state: "archived" },
      undefined,
      undefined,
      context,
    );
    assert.match(archivedList.content[0].text, new RegExp(oldTarget.getSessionId()));

    await assert.rejects(
      harness.tools.get("delete_archived_sessions_older_than").execute(
        "bulk-delete-unconfirmed",
        { older_than_hours: 24, confirm: false },
        undefined,
        undefined,
        context,
      ),
      /confirm=true/,
    );
    const deleted = await harness.tools.get("delete_archived_sessions_older_than").execute(
      "bulk-delete",
      { older_than_hours: 24, confirm: true },
      undefined,
      undefined,
      context,
    );
    assert.match(deleted.content[0].text, /Permanently deleted 1\/1 matching sessions older than 24h/);

    const emptyArchivedList = await harness.tools.get("list_session_archives").execute(
      "list-archived-again",
      { state: "archived" },
      undefined,
      undefined,
      context,
    );
    assert.equal(emptyArchivedList.content[0].text, "No matching sessions found.");
  } finally {
    restoreAgentDir();
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("bulk user-message threshold uses the current branch and preserves current or writer-owned sessions", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-archive-extension-user-count-"));
  const restoreAgentDir = setTestAgentDir(agentDir);
  try {
    const workspace = join(agentDir, "workspace");
    const current = createSessionWithTurns(workspace, "current", 1);
    const threeTurns = createSessionWithTurns(workspace, "three", 3);
    const tooMany = createSessionWithTurns(workspace, "four", 4);

    const branched = createTestSession(workspace);
    const branchPoint = appendTurn(branched, "kept root", Date.now());
    appendTurn(branched, "abandoned 2", Date.now() + 2);
    appendTurn(branched, "abandoned 3", Date.now() + 4);
    branched.branch(branchPoint);
    appendTurn(branched, "selected alternate", Date.now() + 6);
    assert.equal(branched.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "user").length, 4);
    assert.equal(branched.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "user").length, 2);

    const atomic = createSessionWithTurns(workspace, "atomic", 2);
    const legacy = createSessionWithTurns(workspace, "legacy", 2);
    const stale = createSessionWithTurns(workspace, "stale", 2);
    await writeFile(`${legacy.getSessionFile()!}.lease`, JSON.stringify({
      pid: process.pid,
      hostname: hostname(),
      startedAt: new Date().toISOString(),
      surface: "pi-cli",
    }));
    await writeFile(`${stale.getSessionFile()!}.lease`, JSON.stringify({
      pid: 2_147_483_647,
      hostname: hostname(),
      startedAt: new Date(0).toISOString(),
      surface: "pi-cli",
    }));
    const releaseAtomic = await lockfile.lock(atomic.getSessionFile()!, {
      realpath: false,
      lockfilePath: `${atomic.getSessionFile()!}.lock`,
      stale: 30_000,
      update: 10_000,
    });

    try {
      const harness = createHarness();
      archiveManageExtension(harness.api as any);
      harness.finishLoading();
      const context = harness.makeContext(current);
      await harness.commands.get("archive-manage").handler("archive short sessions", context);

      const stats = await harness.tools.get("session_archive_stats").execute("stats", {}, undefined, undefined, context);
      assert.match(stats.content[0].text, /Unarchived stored: 7/);
      assert.match(stats.content[0].text, /Writer-protected unarchived now: 2 \(atomic locks 1; live\/foreign legacy leases 1; unknown 0\)/);

      const result = await harness.tools.get("archive_sessions_with_max_user_messages").execute(
        "archive-short",
        { max_user_messages: 3 },
        undefined,
        undefined,
        context,
      );
      assert.match(result.content[0].text, /Archived 3\/6 matching unarchived sessions with at most 3 user messages \(scanned 7\)/);
      assert.match(result.content[0].text, /Skipped\/failed 3/);
      assert.match(result.content[0].text, /current session/);
      assert.match(result.content[0].text, /active atomic writer lock/);
      assert.match(result.content[0].text, /owner PID is live or unverifiable/);

      assert.equal(await exists(threeTurns.getSessionFile()!), false);
      assert.equal(await exists(branched.getSessionFile()!), false);
      assert.equal(await exists(stale.getSessionFile()!), false);
      assert.equal(await exists(tooMany.getSessionFile()!), true);
      assert.equal(await exists(current.getSessionFile()!), true);
      assert.equal(await exists(atomic.getSessionFile()!), true);
      assert.equal(await exists(legacy.getSessionFile()!), true);
    } finally {
      await releaseAtomic().catch(() => undefined);
    }
  } finally {
    restoreAgentDir();
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("archive removes a proven stale same-host writer lease", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-archive-extension-stale-lease-"));
  const restoreAgentDir = setTestAgentDir(agentDir);
  try {
    const workspace = join(agentDir, "workspace");
    const current = createPersistedSession(workspace, "current", Date.now());
    const target = createPersistedSession(workspace, "stale lease target", Date.now());
    const targetFile = target.getSessionFile()!;
    const leaseFile = `${targetFile}.lease`;
    await writeFile(leaseFile, JSON.stringify({
      pid: 2_147_483_647,
      hostname: hostname(),
      startedAt: new Date().toISOString(),
      surface: "mypi-gui",
    }));

    const harness = createHarness();
    archiveManageExtension(harness.api as any);
    harness.finishLoading();
    const context = harness.makeContext(current);
    await harness.commands.get("archive-manage").handler("manage", context);

    const result = await harness.tools.get("archive_session").execute(
      "archive-stale-lease",
      { session_id: target.getSessionId() },
      undefined,
      undefined,
      context,
    );
    assert.match(result.content[0].text, /Archived unarchived session/);
    assert.equal(await exists(targetFile), false);
    assert.equal(await exists(leaseFile), false);
  } finally {
    restoreAgentDir();
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("archive fails closed for live same-host and foreign-host leases", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-archive-extension-live-lease-"));
  const restoreAgentDir = setTestAgentDir(agentDir);
  try {
    const workspace = join(agentDir, "workspace");
    const current = createPersistedSession(workspace, "current", Date.now());
    const liveTarget = createPersistedSession(workspace, "live lease target", Date.now());
    const foreignTarget = createPersistedSession(workspace, "foreign lease target", Date.now());
    const liveTargetFile = liveTarget.getSessionFile()!;
    const foreignTargetFile = foreignTarget.getSessionFile()!;
    await writeFile(`${liveTargetFile}.lease`, JSON.stringify({
      pid: process.pid,
      hostname: hostname(),
      startedAt: new Date().toISOString(),
      surface: "mypi-gui",
    }));
    await writeFile(`${foreignTargetFile}.lease`, JSON.stringify({
      pid: 2_147_483_647,
      hostname: `foreign-${hostname()}`,
      startedAt: new Date(0).toISOString(),
      surface: "mypi-gui",
    }));

    const harness = createHarness();
    archiveManageExtension(harness.api as any);
    harness.finishLoading();
    const context = harness.makeContext(current);
    await harness.commands.get("archive-manage").handler("manage", context);
    const archiveTool = harness.tools.get("archive_session");

    await assert.rejects(
      archiveTool.execute("archive-live", { session_id: liveTarget.getSessionId() }, undefined, undefined, context),
      /owner PID is live or unverifiable/,
    );
    await assert.rejects(
      archiveTool.execute("archive-foreign", { session_id: foreignTarget.getSessionId() }, undefined, undefined, context),
      /another host/,
    );
    assert.equal(await exists(liveTargetFile), true);
    assert.equal(await exists(`${liveTargetFile}.lease`), true);
    assert.equal(await exists(foreignTargetFile), true);
    assert.equal(await exists(`${foreignTargetFile}.lease`), true);
  } finally {
    restoreAgentDir();
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("archive is excluded by the authoritative atomic writer lock", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-archive-extension-atomic-lock-"));
  const restoreAgentDir = setTestAgentDir(agentDir);
  try {
    const workspace = join(agentDir, "workspace");
    const current = createPersistedSession(workspace, "current", Date.now());
    const target = createPersistedSession(workspace, "locked target", Date.now());
    const targetFile = target.getSessionFile()!;
    const release = await lockfile.lock(targetFile, {
      realpath: false,
      lockfilePath: `${targetFile}.lock`,
      stale: 30_000,
      update: 10_000,
    });

    const harness = createHarness();
    archiveManageExtension(harness.api as any);
    harness.finishLoading();
    const context = harness.makeContext(current);
    await harness.commands.get("archive-manage").handler("manage", context);
    const archiveTool = harness.tools.get("archive_session");

    await assert.rejects(
      archiveTool.execute("archive-locked", { session_id: target.getSessionId() }, undefined, undefined, context),
      /active atomic writer lock/,
    );
    assert.equal(await exists(targetFile), true);
    await release();

    const result = await archiveTool.execute(
      "archive-after-release",
      { session_id: target.getSessionId() },
      undefined,
      undefined,
      context,
    );
    assert.match(result.content[0].text, /Archived unarchived session/);
    assert.equal(await exists(targetFile), false);
  } finally {
    restoreAgentDir();
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("single-session tools move, restore, and permanently delete JSONL history with Goal plan artifacts", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-archive-extension-files-"));
  const restoreAgentDir = setTestAgentDir(agentDir);
  try {
    const workspace = join(agentDir, "workspace");
    const current = createPersistedSession(workspace, "current", Date.now());
		const target = createPersistedSession(workspace, "archive me", Date.now());
		const targetFile = target.getSessionFile()!;
		const childRoot = join(agentDir, "subagents", "by-parent", target.getSessionId());
		await mkdir(join(childRoot, "children", "manual-child"), { recursive: true, mode: 0o700 });
		await writeFile(join(childRoot, "manifest.json"), "{}\n", { mode: 0o600 });
    target.appendCustomEntry("mypi-goal", {
      schemaVersion: 3,
      workflow: "goal",
      goalId: "archived-goal",
      revision: 2,
      objective: "prove plan co-lifecycle",
      status: "paused",
      pauseReason: "plan-ready",
      plan: { items: [{ id: "I001", task: "archive with history", acceptance: ["same JSONL"], verify: ["restore and delete"], checked: false, evidence: [] }] },
    });

    const harness = createHarness();
    archiveManageExtension(harness.api as any);
    harness.finishLoading();
    const context = harness.makeContext(current);
    await harness.commands.get("archive-manage").handler("manage", context);

    const archiveTool = harness.tools.get("archive_session");
    const archiveResult = await archiveTool.execute("archive", { session_id: target.getSessionId() }, undefined, undefined, context);
    assert.match(archiveResult.content[0].text, /Archived unarchived session/);
    assert.equal(await exists(targetFile), false);
    const archivedFile = archiveResult.details.to;
    assert.match(await readFile(archivedFile, "utf8"), /"customType":"mypi-goal"/);
    assert.match(await readFile(archivedFile, "utf8"), /"goalId":"archived-goal"/);
	assert.equal(await exists(childRoot), true, "archive retains inspectable child history with its parent identity");

    const listResult = await harness.tools.get("list_session_archives").execute("list", { state: "archived" }, undefined, undefined, context);
    assert.match(listResult.content[0].text, new RegExp(target.getSessionId()));

    await harness.tools.get("restore_archived_session").execute("restore", { session_id: target.getSessionId() }, undefined, undefined, context);
    assert.equal(await exists(targetFile), true);
    assert.match(await readFile(targetFile, "utf8"), /"goalId":"archived-goal"/);

    await archiveTool.execute("archive-again", { session_id: target.getSessionId() }, undefined, undefined, context);
    await harness.tools.get("delete_archived_session").execute(
      "delete",
      { session_id: target.getSessionId(), confirm: true },
      undefined,
      undefined,
      context,
    );
    assert.equal(await exists(targetFile), false);
    assert.equal(await exists(archivedFile), false);
	assert.equal(await exists(childRoot), false, "permanent parent deletion removes its child subtree");
    const finalList = await harness.tools.get("list_session_archives").execute("final-list", { state: "archived" }, undefined, undefined, context);
    assert.equal(finalList.content[0].text, "No matching sessions found.");
  } finally {
    restoreAgentDir();
    await rm(agentDir, { recursive: true, force: true });
  }
});
});

function assistantMessage(text: string, timestamp = Date.now()) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp,
  };
}
