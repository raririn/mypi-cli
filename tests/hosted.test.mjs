// Hosted TUI runtime (FEAT-061 Phase B): the daemon-backed
// InteractiveRuntimeHost drives a session through a real daemon with a fake
// engine child, exactly as the TUI consumes it — mirror-served synchronous
// reads, RPC-backed mutations, and extension UI bridged through the TUI's
// own dialog context.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const DAEMON_SCRIPT = fileURLToPath(new URL("../scripts/mypi-daemon.mjs", import.meta.url));
const FAKE_ENGINE = fileURLToPath(new URL("./fixtures/fake-rpc-engine.cjs", import.meta.url));
const HOSTED_DIST = new URL(
  "../node_modules/@earendil-works/pi-coding-agent/dist/core/hosted/hosted-runtime-host.js",
  import.meta.url,
).href;
const PROTOCOL = 1;

function waitFor(predicate, timeoutMs = 5_000, label = "condition") {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (predicate()) return resolve(undefined);
      if (Date.now() > deadline) return reject(new Error(`Timed out waiting for ${label}`));
      setTimeout(tick, 15);
    };
    tick();
  });
}

async function startDaemon({ mode, failSession, ownershipConflict } = {}) {
  const daemonDir = await mkdtemp(join(tmpdir(), "mypi-hosted-test-"));
  const child = spawn(process.execPath, [DAEMON_SCRIPT, "__daemon", "--idle-grace-ms", "300"], {
    env: {
      ...process.env,
      MYPI_DAEMON_DIR: daemonDir,
      MYPI_DAEMON_ENGINE_CMD: JSON.stringify([process.execPath, FAKE_ENGINE]),
      FAKE_ENGINE_MODE: mode ?? "",
      FAKE_ENGINE_FAIL_SESSION: failSession ?? "",
      ...(ownershipConflict !== undefined
        ? { FAKE_ENGINE_OWNERSHIP_CONFLICT: JSON.stringify(ownershipConflict) }
        : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr += d.toString();
  });
  const ready = await new Promise((resolve, reject) => {
    let buffer = "";
    const onExit = () => reject(new Error(`daemon exited before ready: ${stderr}`));
    child.once("exit", onExit);
    child.stdout.on("data", (data) => {
      buffer += data.toString();
      const line = buffer.split("\n").find((l) => l.trim());
      if (!line) return;
      child.off("exit", onExit);
      resolve(JSON.parse(line));
    });
  });
  return {
    child,
    daemonDir,
    socketPath: ready.socketPath,
    async cleanup() {
      child.kill("SIGKILL");
      await rm(daemonDir, { recursive: true, force: true });
    },
  };
}

async function writeSessionFile(root, sessionId, entries = []) {
  const sessionDir = join(root, "persisted-sessions");
  await mkdir(sessionDir, { recursive: true });
  const sessionPath = join(sessionDir, `${sessionId}.jsonl`);
  const header = {
    type: "session",
    version: 3,
    id: sessionId,
    timestamp: new Date().toISOString(),
    cwd: root,
  };
  await writeFile(sessionPath, `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  return sessionPath;
}

async function readSessionEntries(root, sessionId) {
  const sessionDir = join(root, "persisted-sessions");
  for (const name of await readdir(sessionDir)) {
    if (!name.endsWith(".jsonl")) continue;
    const value = await readFile(join(sessionDir, name), "utf8");
    const entries = value.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    if (entries[0]?.id === sessionId) return entries;
  }
  throw new Error(`Session ${sessionId} was not materialized in ${sessionDir}`);
}

/** Minimal stand-ins for the local services the hosted session hands out. */
function fakeServices(cwd) {
  return {
    cwd,
    agentDir: cwd,
    diagnostics: [],
    modelRuntime: { getError: () => undefined },
    settingsManager: {},
    resourceLoader: {
      getPrompts: () => ({ prompts: [] }),
      reload: async () => {},
    },
  };
}

async function createHosted(daemon, { sessionId } = {}) {
  process.env.MYPI_TUI_HOSTED = "1";
  process.env.MYPI_DAEMON_SOCKET = daemon.socketPath;
  process.env.MYPI_DAEMON_PROTOCOL = String(PROTOCOL);
  const { createHostedRuntime } = await import(HOSTED_DIST);
  return createHostedRuntime({
    services: fakeServices(daemon.daemonDir),
    sessionId,
    cwd: daemon.daemonDir,
  });
}

test("a hosted runtime attaches, mirrors state, and drives a turn through the daemon", async () => {
  const daemon = await startDaemon();
  try {
    const host = await createHosted(daemon, { sessionId: "s1" });
    const session = host.session;

    // The mirror serves the TUI's synchronous reads.
    assert.equal(session.sessionId, "s1");
    assert.equal(session.isStreaming, false);
    assert.equal(session.isIdle, true);
    assert.equal(session.model.id, "fake-model");
    assert.equal(session.thinkingLevel, "medium");
    assert.equal(session.safetyPolicyEnabled, true);
    assert.equal(session.safetyMode, "full");
    assert.equal(session.pendingSafetyMode, undefined);
    assert.equal(session.state.messages.length, 0);
    assert.equal(await realpath(session.sessionManager.getCwd()), await realpath(daemon.daemonDir));

    // Commands arrive from the engine for autocomplete.
    await session.bindExtensions({ uiContext: undefined });
    assert.equal(session.extensionRunner.getCommand("plan")?.description, "Fake plan command");

    // A prompt streams events through the same subscribe path as embedded.
    const events = [];
    session.subscribe((event) => events.push(event));
    await session.prompt("hello");
    await waitFor(() => events.some((e) => e.type === "agent_settled"), 5_000, "settled");
    assert.ok(events.some((e) => e.type === "agent_start"));
    assert.ok(
      events.some(
        (e) => e.type === "message_update" && e.assistantMessageEvent?.delta === "echo:hello",
      ),
      "the streamed delta reached the TUI's event listener",
    );
    await session.waitForIdle();
    assert.equal(session.isStreaming, false);

    // Synchronous mutators round-trip: the fake echoes thinking_level_changed.
    session.setThinkingLevel("high");
    assert.equal(session.thinkingLevel, "high", "optimistic mirror update");
    await waitFor(
      () => events.some((e) => e.type === "thinking_level_changed" && e.level === "high"),
      5_000,
      "thinking level event",
    );

    assert.equal(session.cycleSafetyMode(), "safe");
    assert.equal(session.safetyMode, "full", "effective mode remains frozen");
    assert.equal(session.pendingSafetyMode, "safe", "pending mode updates optimistically");
    await waitFor(
      () => events.some((e) => e.type === "safety_mode_changed" && e.pending === "safe"),
      5_000,
      "safety mode event",
    );

    await host.dispose();
  } finally {
    await daemon.cleanup();
  }
});

test("engine ask-user prompts render through the TUI dialog context and answer back", async () => {
  const daemon = await startDaemon({ mode: "ask-user" });
  try {
    const host = await createHosted(daemon, { sessionId: "s1" });
    const session = host.session;

    const seen = [];
    let answer;
    await session.bindExtensions({
      uiContext: {
        select: async (title, options, opts) => {
          seen.push({ title, options, mypiAskUser: opts?.mypiAskUser });
          return answer;
        },
        notify: () => {},
        setStatus: () => {},
        setWidget: () => {},
        setTitle: () => {},
        setEditorText: () => {},
        confirm: async () => false,
        input: async () => undefined,
        editor: async () => undefined,
      },
    });

    const events = [];
    session.subscribe((event) => events.push(event));
    answer = "1. Yes (Recommended) — Continue";
    await session.prompt("go");
    await waitFor(() => seen.length === 1, 5_000, "select rendered");

    // The bridge reconstructed the exact embedded ask_user choices.
    assert.equal(seen[0].title, "Proceed?");
    assert.deepEqual(seen[0].options, [
      "1. Yes (Recommended) — Continue",
      "2. No — Stop",
      "4. Other — Type any response",
    ]);
    assert.equal(seen[0].mypiAskUser.recommendedOption, 1);

    // The answer reached the engine as extension_ui_response.
    await waitFor(
      () => events.some((e) => e.type === "__fake_ui_response_received" && e.value === answer),
      5_000,
      "engine received the answer",
    );

    await host.dispose();
  } finally {
    await daemon.cleanup();
  }
});

test("hosted /new moves only the requester to a distinct daemon child", async () => {
  const daemon = await startDaemon();
  try {
    const host = await createHosted(daemon, { sessionId: "s1" });
    const sourceWatcher = await createHosted(daemon, { sessionId: "s1" });
    let rebinds = 0;
    host.setRebindSession(async () => {
      rebinds += 1;
    });

    const result = await host.newSession({ parentSession: "/tmp/daemon-parent.jsonl" });
    assert.equal(result.cancelled, false);
    assert.notEqual(host.session.sessionId, "s1", "the requester adopted a newly prepared target");
    assert.equal(sourceWatcher.session.sessionId, "s1", "the co-attached source client did not move");
    assert.equal(rebinds, 1, "the requesting TUI rebound once");
    const targetEntries = await readSessionEntries(daemon.daemonDir, host.session.sessionId);
    assert.equal(targetEntries[0].id, host.session.sessionId, "the target was materialized before attach");
    assert.equal(targetEntries[0].parentSession, "/tmp/daemon-parent.jsonl");

    // Commands route through the new child while the old child remains live.
    await host.session.prompt("after");
    await host.session.waitForIdle();
    await sourceWatcher.session.prompt("still source");
    await sourceWatcher.session.waitForIdle();

    await Promise.all([host.dispose(), sourceWatcher.dispose()]);
  } finally {
    await daemon.cleanup();
  }
});

test("hosted new-session preparation preserves parent and setup callback semantics", async () => {
  const daemon = await startDaemon();
  try {
    const moving = await createHosted(daemon, { sessionId: "setup-source" });
    const sourceWatcher = await createHosted(daemon, { sessionId: "setup-source" });
    const result = await moving.newSession({
      parentSession: "/tmp/explicit-parent.jsonl",
      setup: async (manager) => {
        manager.appendSessionInfo("prepared target");
      },
    });

    assert.equal(result.cancelled, false);
    assert.equal(sourceWatcher.session.sessionId, "setup-source");
    const entries = await readSessionEntries(daemon.daemonDir, moving.session.sessionId);
    assert.equal(entries[0].parentSession, "/tmp/explicit-parent.jsonl");
    assert.equal(entries.find((entry) => entry.type === "session_info")?.name, "prepared target");

    await Promise.all([moving.dispose(), sourceWatcher.dispose()]);
  } finally {
    await daemon.cleanup();
  }
});

test("hosted /fork and /clone derive separate targets without moving source clients", async () => {
  const daemon = await startDaemon();
  try {
    const timestamp = new Date().toISOString();
    const sourcePath = await writeSessionFile(daemon.daemonDir, "source", [
      { type: "message", id: "u1", parentId: null, timestamp, message: { role: "user", content: "first" } },
      {
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp,
        message: { role: "assistant", content: [{ type: "text", text: "reply" }] },
      },
      { type: "message", id: "u2", parentId: "a1", timestamp, message: { role: "user", content: "retry me" } },
    ]);
    const forking = await createHosted(daemon, { sessionId: "source" });
    const cloning = await createHosted(daemon, { sessionId: "source" });
    const sourceWatcher = await createHosted(daemon, { sessionId: "source" });

    const forkResult = await forking.fork("u2");
    assert.equal(forkResult.cancelled, false);
    assert.equal(forkResult.selectedText, "retry me");
    assert.notEqual(forking.session.sessionId, "source");
    assert.equal(sourceWatcher.session.sessionId, "source");
    const forkEntries = await readSessionEntries(daemon.daemonDir, forking.session.sessionId);
    assert.deepEqual(
      forkEntries.filter((entry) => entry.type === "message").map((entry) => entry.id),
      ["u1", "a1"],
      "fork-before excludes the selected user message",
    );
    assert.equal(await realpath(forkEntries[0].parentSession), await realpath(sourcePath));

    const cloneResult = await cloning.fork("u2", { position: "at" });
    assert.equal(cloneResult.cancelled, false);
    assert.notEqual(cloning.session.sessionId, "source");
    assert.notEqual(cloning.session.sessionId, forking.session.sessionId);
    assert.equal(sourceWatcher.session.sessionId, "source");
    const cloneEntries = await readSessionEntries(daemon.daemonDir, cloning.session.sessionId);
    assert.deepEqual(
      cloneEntries.filter((entry) => entry.type === "message").map((entry) => entry.id),
      ["u1", "a1", "u2"],
      "clone-at includes the active leaf",
    );

    await Promise.all([forking.dispose(), cloning.dispose(), sourceWatcher.dispose()]);
  } finally {
    await daemon.cleanup();
  }
});

test("hosted resume moves only the requesting surface to an existing daemon child", async () => {
  const daemon = await startDaemon();
  try {
    const targetPath = await writeSessionFile(daemon.daemonDir, "target");
    const moving = await createHosted(daemon, { sessionId: "source" });
    const sourceWatcher = await createHosted(daemon, { sessionId: "source" });
    const targetWatcher = await createHosted(daemon, { sessionId: "target" });

    let rebinds = 0;
    moving.setRebindSession(async () => {
      rebinds += 1;
    });
    const result = await moving.switchSession(targetPath);

    assert.equal(result.cancelled, false);
    assert.equal(moving.session.sessionId, "target", "the requester adopted the target child");
    assert.equal(sourceWatcher.session.sessionId, "source", "another source client did not move");
    assert.equal(targetWatcher.session.sessionId, "target", "the existing target client stayed attached");
    assert.equal(rebinds, 1, "the requesting TUI rebound once");

    await Promise.all([moving.dispose(), sourceWatcher.dispose(), targetWatcher.dispose()]);
  } finally {
    await daemon.cleanup();
  }
});

test("hosted resume keeps the source attached when the target engine refuses startup", async () => {
  const daemon = await startDaemon({ failSession: "blocked" });
  try {
    const targetPath = await writeSessionFile(daemon.daemonDir, "blocked");
    const moving = await createHosted(daemon, { sessionId: "source" });
    await assert.rejects(moving.switchSession(targetPath), /fake ownership conflict for blocked/);
    assert.equal(moving.session.sessionId, "source", "failed target attach preserved the source");

    await moving.session.prompt("still here");
    await moving.session.waitForIdle();
    assert.equal(moving.session.sessionId, "source");
    await moving.dispose();
  } finally {
    await daemon.cleanup();
  }
});

test("hosted resume exposes a typed external-owner conflict without leaving the source", async () => {
  const owner = {
    version: 2,
    pid: 43210,
    processStartTime: 1_700_000_000_000,
    hostname: "test-host",
    startedAt: "2026-08-15T00:00:00.000Z",
    surface: "pi-cli",
    ownerId: "external-owner-id",
  };
  const daemon = await startDaemon({
    failSession: "blocked",
    ownershipConflict: { sessionFile: "/tmp/external-blocked.jsonl", owner },
  });
  try {
    const targetPath = await writeSessionFile(daemon.daemonDir, "blocked");
    const moving = await createHosted(daemon, { sessionId: "source" });
    let conflict;
    try {
      await moving.switchSession(targetPath);
      assert.fail("external ownership should refuse target attach");
    } catch (error) {
      conflict = error;
    }
    assert.equal(conflict?.name, "HostedOwnershipConflictError");
    assert.equal(conflict?.conflict.owner.pid, 43210);
    assert.equal(conflict?.conflict.owner.surface, "pi-cli");
    assert.equal(conflict?.conflict.owner.cooperativeHandoffAvailable, false);
    assert.equal(moving.session.sessionId, "source", "the requester stayed on its source session");

    const result = await conflict.requestHandoff(false);
    assert.equal(result.status, "owner-changed", "a vanished/unmatched lease is never negotiated from stale evidence");
    await moving.dispose();
  } finally {
    await daemon.cleanup();
  }
});

test("/exit shuts down the hosted TUI surface and leaves the session running", async () => {
  const daemon = await startDaemon();
  try {
    const host = await createHosted(daemon, { sessionId: "s1" });
    let shutdowns = 0;
    await host.session.bindExtensions({
      uiContext: undefined,
      shutdownHandler: () => {
        shutdowns += 1;
      },
    });

    const events = [];
    host.session.subscribe((event) => events.push(event));
    await host.session.prompt("/exit");
    assert.equal(shutdowns, 1, "/exit invokes the TUI's own graceful shutdown");
    // Nothing crossed the wire: the engine never started a turn.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(!events.some((e) => e.type === "agent_start"), "no prompt reached the engine");

    // The surface leaves; the session stays live in the daemon.
    await host.dispose();
    const probe = await import("node:net").then(({ default: net }) => {
      const socket = net.connect(daemon.socketPath);
      const frames = [];
      let buffer = "";
      socket.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) frames.push(JSON.parse(line));
      });
      return new Promise((resolve, reject) => {
        socket.on("connect", () => {
          socket.write(`${JSON.stringify({ type: "hello", protocol: PROTOCOL, client: "probe" })}\n`);
          socket.write(`${JSON.stringify({ type: "list_sessions" })}\n`);
        });
        socket.on("error", reject);
        const timer = setInterval(() => {
          const sessions = frames.find((f) => f.type === "sessions");
          if (sessions) {
            clearInterval(timer);
            socket.destroy();
            resolve(sessions.sessions);
          }
        }, 25);
      });
    });
    assert.deepEqual(probe.map((s) => s.sessionId), ["s1"], "the session outlives the exiting surface");
  } finally {
    await daemon.cleanup();
  }
});

test("a late-joining hosted TUI renders prompts parked before it bound its dialogs", async () => {
  const daemon = await startDaemon({ mode: "ask-user" });
  const net = (await import("node:net")).default;
  try {
    // Another surface starts a turn that parks on an ask_user prompt.
    const other = net.connect(daemon.socketPath);
    const otherFrames = [];
    let otherBuf = "";
    other.on("data", (data) => {
      otherBuf += data.toString();
      const lines = otherBuf.split("\n");
      otherBuf = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) otherFrames.push(JSON.parse(line));
    });
    await new Promise((resolve) => other.on("connect", resolve));
    other.write(`${JSON.stringify({ type: "hello", protocol: PROTOCOL, client: "gui" })}\n`);
    other.write(`${JSON.stringify({ type: "attach", sessionId: "s1" })}\n`);
    await waitFor(() => otherFrames.some((f) => f.type === "attached"), 5_000, "gui attached");
    other.write(`${JSON.stringify({ id: "p1", type: "prompt", message: "go", sessionId: "s1" })}\n`);
    await waitFor(
      () => otherFrames.some((f) => f.type === "extension_ui_request" && f.method === "mypiAskUser"),
      5_000,
      "prompt parked",
    );

    // The TUI joins late: the daemon replays the prompt right after attach,
    // well before the TUI binds its dialog context.
    const host = await createHosted(daemon, { sessionId: "s1" });
    const seen = [];
    await host.session.bindExtensions({
      uiContext: {
        select: async (title, options) => {
          seen.push({ title, options });
          return options[0];
        },
        notify: () => {},
        setStatus: () => {},
        setWidget: () => {},
        setTitle: () => {},
        setEditorText: () => {},
        confirm: async () => false,
        input: async () => undefined,
        editor: async () => undefined,
      },
    });
    await waitFor(() => seen.length === 1, 5_000, "queued prompt rendered on bind");
    assert.equal(seen[0].title, "Proceed?");

    other.destroy();
    await host.dispose();
  } finally {
    await daemon.cleanup();
  }
});
