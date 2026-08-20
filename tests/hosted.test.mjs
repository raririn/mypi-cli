// Hosted TUI runtime (FEAT-061 Phase B): the daemon-backed
// InteractiveRuntimeHost drives a session through a real daemon with a fake
// engine child, exactly as the TUI consumes it — mirror-served synchronous
// reads, RPC-backed mutations, and extension UI bridged through the TUI's
// own dialog context.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
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

async function startDaemon({ mode } = {}) {
  const daemonDir = await mkdtemp(join(tmpdir(), "mypi-hosted-test-"));
  const child = spawn(process.execPath, [DAEMON_SCRIPT, "__daemon", "--idle-grace-ms", "300"], {
    env: {
      ...process.env,
      MYPI_DAEMON_DIR: daemonDir,
      MYPI_DAEMON_ENGINE_CMD: JSON.stringify([process.execPath, FAKE_ENGINE]),
      FAKE_ENGINE_MODE: mode ?? "",
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
    assert.equal(session.state.messages.length, 0);
    assert.equal(session.sessionManager.getCwd(), daemon.daemonDir);

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

test("new_session through the hosted runtime re-keys the mirror and rebinds", async () => {
  const daemon = await startDaemon();
  try {
    const host = await createHosted(daemon, { sessionId: "s1" });
    let rebinds = 0;
    host.setRebindSession(async () => {
      rebinds += 1;
    });

    const result = await host.newSession();
    assert.equal(result.cancelled, false);
    await waitFor(() => host.session.sessionId === "fake-new-1", 5_000, "identity adopted");
    assert.ok(rebinds >= 1, "the TUI was asked to rebind");

    // Commands still route after the re-key.
    await host.session.prompt("after");
    await host.session.waitForIdle();

    await host.dispose();
  } finally {
    await daemon.cleanup();
  }
});
