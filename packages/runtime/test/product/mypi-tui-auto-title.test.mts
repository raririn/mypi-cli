import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import chatExtension from "../../src/product/mypi-chat.ts";
import { normalizeTitle, registerTuiAutoTitle, type TuiTitleGenerator } from "../../src/product/mypi-tui-auto-title.ts";

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

function createHarness(manager: SessionManager, generator?: TuiTitleGenerator) {
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const tools = new Map<string, any>();
  const api = {
    on(name: string, handler: (event: any, ctx: any) => any) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand() {},
    getSessionName() { return manager.getSessionName(); },
    setSessionName(name: string) { manager.appendSessionInfo(name); },
  };
  const context = {
    mode: "tui",
    sessionManager: manager,
    model: undefined,
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test", headers: {}, env: {} }),
    },
  };
  const emit = async (name: string, event: any, ctx = context) => {
    for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
  };
  if (generator) registerTuiAutoTitle(api as any, { generateTitle: generator });
  return { api, context, handlers, tools, emit };
}

async function flushAsyncWork(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function withAgentDir(run: (agentDir: string) => Promise<void>): Promise<void> {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-tui-auto-title-"));
  const previousPublic = process.env.MYPI_AGENT_DIR;
  const previousInternal = process.env.MYPI_CODING_AGENT_DIR;
  // The engine resolves its profile from the internal MYPI_CODING_AGENT_DIR
  // (the mypi launcher derives it from the public MYPI_AGENT_DIR). Set both so
  // SessionManager.create writes transcripts under this fixture instead of the
  // developer's real ~/.mypi/agent, where they surface as ghost sessions.
  process.env.MYPI_AGENT_DIR = agentDir;
  process.env.MYPI_CODING_AGENT_DIR = agentDir;
  try {
    await run(agentDir);
  } finally {
    if (previousPublic === undefined) delete process.env.MYPI_AGENT_DIR;
    else process.env.MYPI_AGENT_DIR = previousPublic;
    if (previousInternal === undefined) delete process.env.MYPI_CODING_AGENT_DIR;
    else process.env.MYPI_CODING_AGENT_DIR = previousInternal;
    await rm(agentDir, { recursive: true, force: true });
  }
}

test("first interactive TUI prompt persists a durable session_info name without blocking the turn", async () => {
  await withAgentDir(async (agentDir) => {
    const manager = SessionManager.create(join(agentDir, "workspace"));
    let resolveTitle!: (title: string | null) => void;
    const title = new Promise<string | null>((resolve) => { resolveTitle = resolve; });
    const harness = createHarness(manager, async () => title);

    await harness.emit("session_start", { reason: "startup" });
    await harness.emit("input", { source: "interactive", text: "Diagnose durable TUI names" });

    manager.appendMessage({ role: "user", content: "Diagnose durable TUI names", timestamp: Date.now() });
    manager.appendMessage(assistantMessage("Working"));
    assert.equal(manager.getSessionName(), undefined, "title generation remains background work");

    resolveTitle("Durable TUI names");
    await flushAsyncWork();
    assert.equal(manager.getSessionName(), "Durable TUI names");

    const sessionFile = manager.getSessionFile()!;
    assert.match(await readFile(sessionFile, "utf8"), /"type":"session_info"/);
    assert.equal(SessionManager.open(sessionFile).getSessionName(), "Durable TUI names");
  });
});

test("resuming an unnamed TUI session backfills from its first textual user message", async () => {
  await withAgentDir(async (agentDir) => {
    const manager = SessionManager.create(join(agentDir, "workspace"));
    manager.appendMessage({ role: "user", content: [{ type: "text", text: "Backfill this session" }], timestamp: Date.now() });
    manager.appendMessage(assistantMessage("Existing response"));
    const prompts: string[] = [];
    const harness = createHarness(manager, async (prompt) => { prompts.push(prompt); return "Backfilled session"; });

    await harness.emit("session_start", { reason: "startup" });
    await flushAsyncWork();
    assert.deepEqual(prompts, ["Backfill this session"]);
    assert.equal(manager.getSessionName(), "Backfilled session");
  });
});

test("manual or existing names win over delayed generation and later inputs never retrigger", async () => {
  await withAgentDir(async (agentDir) => {
    const manager = SessionManager.create(join(agentDir, "workspace"));
    let calls = 0;
    let resolveTitle!: (title: string | null) => void;
    const pendingTitle = new Promise<string | null>((resolve) => { resolveTitle = resolve; });
    const harness = createHarness(manager, async () => { calls += 1; return pendingTitle; });

    await harness.emit("session_start", { reason: "startup" });
    await harness.emit("input", { source: "interactive", text: "First prompt" });
    manager.appendMessage({ role: "user", content: "First prompt", timestamp: Date.now() });
    manager.appendMessage(assistantMessage("Response"));
    manager.appendSessionInfo("Manual name");
    await harness.emit("session_info_changed", { name: "Manual name" });
    resolveTitle("Generated name");
    await flushAsyncWork();

    await harness.emit("input", { source: "interactive", text: "Second prompt" });
    assert.equal(calls, 1);
    assert.equal(manager.getSessionName(), "Manual name");
  });
});

test("non-TUI modes, extension input, and missing model authentication do not name a session", async () => {
  await withAgentDir(async (agentDir) => {
    const manager = SessionManager.create(join(agentDir, "workspace"));
    let calls = 0;
    const harness = createHarness(manager, async () => { calls += 1; return "Should not apply"; });
    const rpcContext = { ...harness.context, mode: "rpc" };
    await harness.emit("session_start", { reason: "startup" }, rpcContext);
    await harness.emit("input", { source: "interactive", text: "RPC prompt" }, rpcContext);
    await harness.emit("input", { source: "extension", text: "Injected prompt" });
    await flushAsyncWork();
    assert.equal(calls, 0);
    assert.equal(manager.getSessionName(), undefined);

    manager.appendMessage({ role: "user", content: "No selected model", timestamp: Date.now() });
    manager.appendMessage(assistantMessage("Response"));
    const defaultHarness = createHarness(manager);
    registerTuiAutoTitle(defaultHarness.api as any);
    await defaultHarness.emit("session_start", { reason: "startup" });
    await flushAsyncWork();
    assert.equal(manager.getSessionName(), undefined);
  });
});

test("restricted Chat composes the shared TUI auto-title lifecycle", async () => {
  await withAgentDir(async (agentDir) => {
    const manager = SessionManager.create(join(agentDir, "chat"));
    const harness = createHarness(manager);
    chatExtension(harness.api as any);
    assert.ok((harness.handlers.get("session_start")?.length ?? 0) >= 1);
    assert.ok((harness.handlers.get("input")?.length ?? 0) >= 1);
    assert.ok(harness.tools.has("read_canvas"));
  });
});

test("title normalization is compact and removes model formatting", () => {
  assert.equal(normalizeTitle('Title: "Fix durable names."'), "Fix durable names");
  assert.equal(normalizeTitle("   "), null);
  assert.equal(normalizeTitle("A title that is intentionally much too long to fit in the sidebar"), "A title that is intentionally muc...");
});
