import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const DAEMON_SCRIPT = fileURLToPath(new URL("../scripts/mypi-daemon.mjs", import.meta.url));
const PROXY_SCRIPT = fileURLToPath(new URL("../scripts/mypi-proxy.mjs", import.meta.url));
const FAKE_ENGINE = fileURLToPath(new URL("./fixtures/fake-rpc-engine.cjs", import.meta.url));
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

async function startDaemon({ mode, idleGraceMs = 300 } = {}) {
  const daemonDir = await mkdtemp(join(tmpdir(), "mypi-daemon-test-"));
  const child = spawn(
    process.execPath,
    [DAEMON_SCRIPT, "__daemon", "--idle-grace-ms", String(idleGraceMs)],
    {
      env: {
        ...process.env,
        MYPI_DAEMON_DIR: daemonDir,
        MYPI_DAEMON_ENGINE_CMD: JSON.stringify([process.execPath, FAKE_ENGINE]),
        FAKE_ENGINE_MODE: mode ?? "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
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

function connect(socketPath) {
  const socket = net.connect(socketPath);
  const frames = [];
  let buffer = "";
  socket.on("data", (data) => {
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) frames.push(JSON.parse(line));
  });
  return {
    socket,
    frames,
    send(frame) {
      socket.write(`${JSON.stringify(frame)}\n`);
    },
    ofType(type) {
      return frames.filter((f) => f.type === type);
    },
    async connected() {
      await new Promise((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
    },
    async hello(protocol = PROTOCOL) {
      this.send({ type: "hello", protocol, client: "test" });
      await waitFor(() => this.frames.length > 0, 3_000, "handshake reply");
    },
  };
}

test("handshake: a matching protocol is acked, a mismatch is refused and closed", async () => {
  const daemon = await startDaemon();
  try {
    const good = connect(daemon.socketPath);
    await good.connected();
    await good.hello();
    assert.equal(good.ofType("hello_ack").length, 1);
    assert.equal(good.ofType("hello_ack")[0].protocol, PROTOCOL);
    good.socket.destroy();

    const bad = connect(daemon.socketPath);
    await bad.connected();
    const closed = new Promise((resolve) => bad.socket.once("close", resolve));
    await bad.hello(PROTOCOL + 99);
    assert.equal(bad.ofType("hello_error").length, 1, "mismatch is refused with a typed frame");
    assert.match(bad.ofType("hello_error")[0].reason, /protocol/i);
    await closed;
  } finally {
    await daemon.cleanup();
  }
});

test("a frame before the handshake is refused", async () => {
  const daemon = await startDaemon();
  try {
    const client = connect(daemon.socketPath);
    await client.connected();
    const closed = new Promise((resolve) => client.socket.once("close", resolve));
    client.send({ type: "list_sessions" });
    await waitFor(() => client.ofType("hello_error").length === 1, 3_000, "refusal");
    await closed;
  } finally {
    await daemon.cleanup();
  }
});

test("attach spawns a session child, list_sessions reports it, and events fan out", async () => {
  const daemon = await startDaemon();
  try {
    const first = connect(daemon.socketPath);
    const second = connect(daemon.socketPath);
    await first.connected();
    await second.connected();
    await first.hello();
    await second.hello();

    first.send({ type: "attach", sessionId: "s1" });
    await waitFor(() => first.ofType("attached").length === 1, 5_000, "attached");
    assert.match(first.ofType("attached")[0].sessionFile, /s1\.jsonl$/, "the child was started for the requested session id");

    second.send({ type: "attach", sessionId: "s1" });
    await waitFor(() => second.ofType("attached").length === 1, 5_000, "second attached");

    first.send({ type: "list_sessions" });
    await waitFor(() => first.ofType("sessions").length === 1, 3_000, "sessions listing");
    const listed = first.ofType("sessions")[0].sessions;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].sessionId, "s1");
    assert.equal(listed[0].clients, 2, "both clients are counted");

    // Colliding client ids must not cross-route.
    first.send({ id: "1", type: "get_state", sessionId: "s1" });
    second.send({ id: "1", type: "get_state", sessionId: "s1" });
    await waitFor(
      () => first.ofType("response").length === 1 && second.ofType("response").length === 1,
      5_000,
      "both responses",
    );
    assert.equal(first.ofType("response")[0].sessionId, "s1");

    // A turn started by one client streams to both.
    first.send({ id: "p1", type: "prompt", message: "hello", sessionId: "s1" });
    await waitFor(
      () => first.ofType("agent_settled").length === 1 && second.ofType("agent_settled").length === 1,
      5_000,
      "settled on both",
    );
    assert.equal(second.frames.filter((f) => f.type === "response" && f.command === "prompt").length, 0,
      "the prompt ack went only to the issuing client");

    first.socket.destroy();
    second.socket.destroy();
  } finally {
    await daemon.cleanup();
  }
});

test("two sessions are multiplexed over one connection and addressed by id", async () => {
  const daemon = await startDaemon();
  try {
    const client = connect(daemon.socketPath);
    await client.connected();
    await client.hello();

    client.send({ type: "attach", sessionId: "alpha" });
    client.send({ type: "attach", sessionId: "beta" });
    await waitFor(() => client.ofType("attached").length === 2, 6_000, "both attached");

    client.send({ id: "pa", type: "prompt", message: "for-alpha", sessionId: "alpha" });
    await waitFor(
      () => client.frames.some((f) => f.type === "message_update" && f.sessionId === "alpha"),
      5_000,
      "alpha delta",
    );
    const strayBeta = client.frames.filter((f) => f.type === "message_update" && f.sessionId === "beta");
    assert.equal(strayBeta.length, 0, "beta must not receive alpha's stream");

    client.send({ type: "list_sessions" });
    await waitFor(() => client.ofType("sessions").length === 1, 3_000, "listing");
    assert.equal(client.ofType("sessions")[0].sessions.length, 2);
    client.socket.destroy();
  } finally {
    await daemon.cleanup();
  }
});

test("ask_user fans out, the first answer wins, and late joiners learn a prompt is pending", async () => {
  const daemon = await startDaemon({ mode: "ask-user" });
  try {
    const first = connect(daemon.socketPath);
    const second = connect(daemon.socketPath);
    await first.connected();
    await second.connected();
    await first.hello();
    await second.hello();
    first.send({ type: "attach", sessionId: "s1" });
    second.send({ type: "attach", sessionId: "s1" });
    await waitFor(() => second.ofType("attached").length === 1, 5_000, "attached");

    first.send({ id: "p1", type: "prompt", message: "risky", sessionId: "s1" });
    await waitFor(
      () => first.ofType("extension_ui_request").length === 1 && second.ofType("extension_ui_request").length === 1,
      5_000,
      "prompt broadcast",
    );

    // A client attaching while the prompt is outstanding is told about it.
    const late = connect(daemon.socketPath);
    await late.connected();
    await late.hello();
    late.send({ type: "attach", sessionId: "s1" });
    await waitFor(() => late.ofType("pending_ui").length === 1, 5_000, "pending prompt replayed");

    second.send({ type: "extension_ui_response", sessionId: "s1", id: "ask-1", value: "Yes" });
    first.send({ type: "extension_ui_response", sessionId: "s1", id: "ask-1", value: "No" });
    await waitFor(() => first.ofType("__fake_ui_response_received").length >= 1, 5_000, "engine echo");
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(first.ofType("__fake_ui_response_received").length, 1, "only the first answer reached the engine");
    assert.equal(first.ofType("__fake_ui_response_received")[0].value, "Yes");

    first.socket.destroy();
    second.socket.destroy();
    late.socket.destroy();
  } finally {
    await daemon.cleanup();
  }
});

test("a session closes after its last client leaves, but an active turn defers it", async (t) => {
  const previousTurnMs = process.env.FAKE_ENGINE_TURN_MS;
  process.env.FAKE_ENGINE_TURN_MS = "600";
  const daemon = await startDaemon({ idleGraceMs: 60 });
  try {
    const client = connect(daemon.socketPath);
    await client.connected();
    await client.hello();
    client.send({ type: "attach", sessionId: "s1" });
    await waitFor(() => client.ofType("attached").length === 1, 5_000, "attached");

    client.send({ id: "p1", type: "prompt", message: "long", sessionId: "s1" });
    await waitFor(() => client.ofType("agent_start").length === 1, 5_000, "turn started");
    client.socket.destroy();

    // Well past the grace window, mid-turn: the daemon must still be serving
    // the session rather than killing the engine.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const probe = connect(daemon.socketPath);
    await probe.connected();
    await probe.hello();
    probe.send({ type: "list_sessions" });
    await waitFor(() => probe.ofType("sessions").length === 1, 3_000, "listing during turn");
    assert.equal(probe.ofType("sessions")[0].sessions.length, 1, "the in-flight session survived");
    probe.socket.destroy();

    // Once settled and unwatched, it is reaped.
    await waitFor(async () => true, 10, "tick");
    const after = connect(daemon.socketPath);
    await after.connected();
    await after.hello();
    await new Promise((resolve) => setTimeout(resolve, 900));
    after.send({ type: "list_sessions" });
    await waitFor(() => after.ofType("sessions").length === 1, 3_000, "listing after settle");
    assert.equal(after.ofType("sessions")[0].sessions.length, 0, "the idle session was reaped");
    after.socket.destroy();
    t.diagnostic("turn deferral and reap both observed");
  } finally {
    if (previousTurnMs === undefined) delete process.env.FAKE_ENGINE_TURN_MS;
    else process.env.FAKE_ENGINE_TURN_MS = previousTurnMs;
    await daemon.cleanup();
  }
});

test("release hands the session over: refused mid-turn, forced release aborts", async () => {
  const previousTurnMs = process.env.FAKE_ENGINE_TURN_MS;
  process.env.FAKE_ENGINE_TURN_MS = "600";
  const daemon = await startDaemon();
  try {
    const client = connect(daemon.socketPath);
    await client.connected();
    await client.hello();
    client.send({ type: "attach", sessionId: "s1" });
    await waitFor(() => client.ofType("attached").length === 1, 5_000, "attached");

    client.send({ id: "p1", type: "prompt", message: "long", sessionId: "s1" });
    await waitFor(() => client.ofType("agent_start").length === 1, 5_000, "turn started");

    client.send({ type: "release", sessionId: "s1" });
    await waitFor(() => client.ofType("release_denied").length === 1, 3_000, "denied mid-turn");
    assert.equal(client.ofType("release_denied")[0].turnActive, true);

    client.send({ type: "release", sessionId: "s1", force: true });
    await waitFor(() => client.ofType("released").length === 1, 6_000, "forced release");
    const settled = client.ofType("agent_settled");
    assert.equal(settled[0].outcome?.kind, "aborted", "the forced release aborted the turn");
    client.socket.destroy();
  } finally {
    if (previousTurnMs === undefined) delete process.env.FAKE_ENGINE_TURN_MS;
    else process.env.FAKE_ENGINE_TURN_MS = previousTurnMs;
    await daemon.cleanup();
  }
});

test("mypi proxy pipes the daemon protocol verbatim, and --read-only refuses mutations", async () => {
  const daemon = await startDaemon();
  try {
    const run = (extraArgs) => {
      const child = spawn(process.execPath, [PROXY_SCRIPT, "proxy", "--no-spawn", ...extraArgs], {
        env: { ...process.env, MYPI_DAEMON_DIR: daemon.daemonDir },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const frames = [];
      let buffer = "";
      child.stdout.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) frames.push(JSON.parse(line));
      });
      return { child, frames, send: (f) => child.stdin.write(`${JSON.stringify(f)}\n`) };
    };

    const open = run([]);
    open.send({ type: "hello", protocol: PROTOCOL, client: "proxy-test" });
    await waitFor(() => open.frames.some((f) => f.type === "hello_ack"), 5_000, "proxied handshake");
    open.send({ type: "attach", sessionId: "s1" });
    await waitFor(() => open.frames.some((f) => f.type === "attached"), 6_000, "proxied attach");
    open.child.kill();

    const locked = run(["--read-only"]);
    locked.send({ type: "hello", protocol: PROTOCOL, client: "proxy-ro" });
    await waitFor(() => locked.frames.some((f) => f.type === "hello_ack"), 5_000, "read-only handshake");
    locked.send({ type: "attach", sessionId: "s1" });
    await waitFor(() => locked.frames.some((f) => f.type === "attached"), 6_000, "read-only attach allowed");
    locked.send({ id: "p1", type: "prompt", message: "nope", sessionId: "s1" });
    await waitFor(
      () => locked.frames.some((f) => f.code === "PROXY_READ_ONLY"),
      3_000,
      "mutation refused locally",
    );
    locked.child.kill();
  } finally {
    await daemon.cleanup();
  }
});

test("a dead daemon's discovery files are pruned so a fresh one can bind", async () => {
  const daemon = await startDaemon();
  const sidecar = join(daemon.daemonDir, "daemon.json");
  await waitFor(() => existsSync(sidecar), 3_000, "sidecar");
  const recorded = JSON.parse(readFileSync(sidecar, "utf8"));
  assert.equal(recorded.protocol, 1);

  daemon.child.kill("SIGKILL");
  await new Promise((resolve) => setTimeout(resolve, 150));

  // Discovery must report the dead daemon as gone and prune its files.
  const previousDir = process.env.MYPI_DAEMON_DIR;
  process.env.MYPI_DAEMON_DIR = daemon.daemonDir;
  try {
    const { readLiveDaemon } = await import("../scripts/mypi-daemon-discovery.mjs");
    assert.equal(readLiveDaemon(), null, "a dead daemon is not reported as live");
    assert.equal(existsSync(sidecar), false, "the stale sidecar was pruned");
  } finally {
    if (previousDir === undefined) delete process.env.MYPI_DAEMON_DIR;
    else process.env.MYPI_DAEMON_DIR = previousDir;
    await daemon.cleanup();
  }
});
