import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const DAEMON_SCRIPT = fileURLToPath(new URL("../scripts/mypi-daemon.mjs", import.meta.url));
const PROXY_SCRIPT = fileURLToPath(new URL("../scripts/mypi-proxy.mjs", import.meta.url));
const ATTACH_SCRIPT = fileURLToPath(new URL("../scripts/mypi-attach.mjs", import.meta.url));
const FAKE_TUI = fileURLToPath(new URL("./fixtures/fake-tui.cjs", import.meta.url));
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

async function startDaemon({
  mode,
  idleGraceMs = 300,
  version,
  turnMs,
  failSession,
  ownershipConflict,
  signalGraceMs,
  ownerControlTimeoutMs,
  configContent,
} = {}) {
  const daemonDir = await mkdtemp(join(tmpdir(), "mypi-daemon-test-"));
  const agentDir = join(daemonDir, "agent");
  await mkdir(agentDir, { recursive: true });
  if (configContent !== undefined) await writeFile(join(agentDir, "config.yaml"), configContent, { mode: 0o600 });
  const child = spawn(
    process.execPath,
    [DAEMON_SCRIPT, "__daemon", "--idle-grace-ms", String(idleGraceMs)],
    {
      env: {
        ...process.env,
        MYPI_DAEMON_DIR: daemonDir,
        MYPI_AGENT_DIR: agentDir,
        MYPI_CODING_AGENT_DIR: agentDir,
        MYPI_DAEMON_ENGINE_CMD: JSON.stringify([process.execPath, FAKE_ENGINE]),
        MYPI_DAEMON_NO_REEXEC: "1",
        FAKE_ENGINE_MODE: mode ?? "",
        ...(version !== undefined ? { MYPI_RUNTIME_DISPLAY_VERSION: version } : {}),
        ...(turnMs !== undefined ? { FAKE_ENGINE_TURN_MS: String(turnMs) } : {}),
        ...(failSession !== undefined ? { FAKE_ENGINE_FAIL_SESSION: failSession } : {}),
        ...(ownershipConflict !== undefined
          ? { FAKE_ENGINE_OWNERSHIP_CONFLICT: JSON.stringify(ownershipConflict) }
          : {}),
        ...(signalGraceMs !== undefined ? { MYPI_DAEMON_SIGNAL_GRACE_MS: String(signalGraceMs) } : {}),
        ...(ownerControlTimeoutMs !== undefined
          ? { MYPI_DAEMON_OWNER_CONTROL_TIMEOUT_MS: String(ownerControlTimeoutMs) }
          : {}),
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
    agentDir,
    socketPath: ready.socketPath,
    async cleanup() {
      child.kill("SIGKILL");
      await rm(daemonDir, { recursive: true, force: true });
    },
  };
}

function persistedSession({ id, cwd, user = "hello", assistant = "world", name }) {
  const timestamp = new Date().toISOString();
  const entries = [
    { type: "session", version: 3, id, timestamp, cwd },
    { type: "message", id: `${id}-u`, parentId: null, timestamp, message: { role: "user", content: user, timestamp: Date.parse(timestamp) } },
    {
      type: "message",
      id: `${id}-a`,
      parentId: `${id}-u`,
      timestamp,
      message: {
        role: "assistant",
        content: [{ type: "text", text: assistant }],
        timestamp: Date.parse(timestamp) + 1,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      },
    },
    ...(name ? [{ type: "session_info", id: `${id}-n`, parentId: `${id}-a`, timestamp, name }] : []),
  ];
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
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

test("malformed global YAML falls back completely and produces a launch warning", async () => {
  const daemon = await startDaemon({ configContent: "version: 1\nhistory: [\n" });
  try {
    const client = connect(daemon.socketPath);
    await client.connected();
    await client.hello();
    await waitFor(() => client.ofType("configuration_warning").length === 1, 3_000, "configuration warning");
    assert.match(client.ofType("configuration_warning")[0].message, /defaults are active/i);
    assert.equal(client.ofType("configuration_warning")[0].code, "malformed");
    client.socket.destroy();
  } finally {
    await daemon.cleanup();
  }
});

test("daemon re-exec closes inherited spawner descriptors and outlives the starter", async () => {
  const daemonDir = await mkdtemp(join(tmpdir(), "mypi-daemon-detach-test-"));
  const agentDir = join(daemonDir, "agent");
  await mkdir(agentDir, { recursive: true });
  const starter = spawn(process.execPath, [DAEMON_SCRIPT, "__daemon", "--idle-grace-ms", "300"], {
    env: {
      ...process.env,
      MYPI_DAEMON_DIR: daemonDir,
      MYPI_AGENT_DIR: agentDir,
      MYPI_CODING_AGENT_DIR: agentDir,
      MYPI_DAEMON_ENGINE_CMD: JSON.stringify([process.execPath, FAKE_ENGINE]),
    },
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  });
  let workerPid;
  try {
    const ready = await new Promise((resolve, reject) => {
      let buffer = "";
      starter.stdout.on("data", (chunk) => {
        buffer += chunk.toString();
        const line = buffer.split("\n").find((candidate) => candidate.trim());
        if (line) resolve(JSON.parse(line));
      });
      starter.once("error", reject);
      starter.once("exit", (code) => {
        if (!buffer.trim()) reject(new Error(`daemon starter exited before ready (${code})`));
      });
    });
    workerPid = ready.pid;
    await new Promise((resolve) => starter.once("exit", resolve));
    await Promise.race([
      starter.stdio[3].destroyed ? Promise.resolve() : new Promise((resolve) => starter.stdio[3].once("close", resolve)),
      new Promise((_, reject) => setTimeout(() => reject(new Error("inherited descriptor stayed open")), 2_000)),
    ]);

    const client = connect(ready.socketPath);
    await client.connected();
    await client.hello();
    assert.equal(client.ofType("hello_ack")[0].pid, workerPid);
    client.socket.destroy();
  } finally {
    if (Number.isInteger(workerPid)) {
      try { process.kill(workerPid, "SIGKILL"); } catch {}
    }
    await rm(daemonDir, { recursive: true, force: true });
  }
});

test("daemon lists and reads persisted history, models, skills, and extensions without attaching", async () => {
  const daemon = await startDaemon();
  try {
    const cwd = join(daemon.daemonDir, "workspace");
    const sessionDir = join(daemon.agentDir, "sessions", "workspace");
    await Promise.all([mkdir(cwd), mkdir(sessionDir, { recursive: true })]);
    await writeFile(join(sessionDir, "persisted.jsonl"), persistedSession({ id: "persisted", cwd, name: "Persisted name" }));

    const client = connect(daemon.socketPath);
    await client.connected();
    await client.hello();
    const response = (command) => client.frames.find((frame) => frame.type === "response" && frame.command === command);

    client.send({ id: "list", type: "list_persisted_sessions", cwd });
    await waitFor(() => response("list_persisted_sessions"), 5_000, "persisted listing");
    assert.equal(response("list_persisted_sessions").success, true);
    assert.equal(response("list_persisted_sessions").data.sessions[0].name, "Persisted name");

    client.send({ id: "read", type: "read_session", sessionId: "persisted", limit: 2 });
    await waitFor(() => response("read_session"), 5_000, "persisted read");
    assert.equal(response("read_session").data.entries.length, 2);
    assert.equal(Array.isArray(response("read_session").data.entries), true);

    client.send({ id: "stats", type: "get_session_stats", sessionId: "persisted" });
    await waitFor(() => response("get_session_stats"), 5_000, "persisted stats");
    assert.equal(response("get_session_stats").data.lastUsage.totalTokens, 2);

    client.send({ id: "models", type: "get_available_models", cwd });
    client.send({ id: "skills", type: "list_skills", cwd });
    client.send({ id: "extensions", type: "list_extensions", cwd });
    await waitFor(
      () => response("get_available_models") && response("list_skills") && response("list_extensions"),
      15_000,
      "unattached catalogs",
    );
    assert.equal(response("get_available_models").success, true);
    assert.ok(Array.isArray(response("get_available_models").data.models));
    assert.equal(response("list_skills").success, true);
    assert.ok(Array.isArray(response("list_skills").data.skills));
    assert.equal(response("list_extensions").success, true);
    assert.ok(response("list_extensions").data.extensions.some((extension) => extension.name === "global-config"));

    client.send({ type: "list_sessions" });
    await waitFor(() => client.ofType("sessions").length === 1, 3_000, "live session listing");
    assert.equal(client.ofType("sessions")[0].sessions.length, 0, "unattached reads start no engines");
    client.socket.destroy();
  } finally {
    await daemon.cleanup();
  }
});

test("fresh daemon sessions run configured project maintenance and request archive cleanup", async () => {
  const daemon = await startDaemon({
    configContent: "version: 1\nhistory:\n  autoArchive: true\n  shortTestMaxWords: 1\n  maxActive: 1\n  maxArchived: 1\n",
  });
  try {
    const cwd = join(daemon.daemonDir, "maintenance-workspace");
    const activeDir = join(daemon.agentDir, "sessions", "workspace");
    const archiveDir = join(daemon.agentDir, "session-archive", "workspace");
    await Promise.all([mkdir(cwd), mkdir(activeDir, { recursive: true }), mkdir(archiveDir, { recursive: true })]);
    for (const id of ["active-old", "active-new"]) {
      await writeFile(join(activeDir, `${id}.jsonl`), persistedSession({
        id,
        cwd,
        user: "meaningful retained user history",
        assistant: "meaningful retained assistant history",
      }));
    }
    for (const id of ["archive-old", "archive-new"]) {
      await writeFile(join(archiveDir, `${id}.jsonl`), persistedSession({ id, cwd }));
    }

    const client = connect(daemon.socketPath);
    await client.connected();
    await client.hello();
    client.send({ id: "before-maintenance", type: "list_persisted_sessions", cwd, includeArchived: true });
    await waitFor(() => client.frames.some((frame) => frame.id === "before-maintenance"), 5_000, "maintenance fixture listing");
    assert.equal(client.frames.find((frame) => frame.id === "before-maintenance").data.total, 4);
    client.send({ type: "attach", cwd, sessionStart: { reason: "new" } });
    await waitFor(() => client.ofType("attached").length === 1, 5_000, "fresh attach");
    await waitFor(() => client.ofType("session_maintenance").length === 1 || client.ofType("session_maintenance_error").length === 1, 5_000, "session maintenance");
    assert.equal(client.ofType("session_maintenance_error").length, 0, JSON.stringify(client.ofType("session_maintenance_error")));
    const maintenance = client.ofType("session_maintenance")[0];
    assert.equal(maintenance.archivedOverflow, 2, JSON.stringify(maintenance));
    assert.equal(maintenance.activeCount, 0, "fake engine session file is outside the persisted fixture store");
    assert.equal(maintenance.archivedCount, 4);
    assert.equal(maintenance.archivedExcess, 3);
    assert.equal(maintenance.command, "/archive-cleanup");
    assert.equal(client.ofType("persisted_changed").filter((frame) => frame.kind === "archived").length, 2);
    client.socket.destroy();
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
    first.send({
      id: "p1",
      type: "prompt",
      message: "hello",
      sessionId: "s1",
      structuredOutput: {
        schema: {
          type: "object",
          properties: { echo: { type: "string" } },
          required: ["echo"],
          additionalProperties: false,
        },
      },
    });
    await waitFor(
      () => first.ofType("agent_settled").length === 1 && second.ofType("agent_settled").length === 1,
      5_000,
      "settled on both",
    );
    assert.equal(second.frames.filter((f) => f.type === "response" && f.command === "prompt").length, 0,
      "the prompt ack went only to the issuing client");
    assert.deepEqual(first.ofType("structured_result")[0].result.value, { echo: "hello" });
    assert.equal(first.ofType("structured_result")[0].result.requestId, "p1");
    assert.equal(first.ofType("structured_result")[0].sessionId, "s1");
    assert.deepEqual(second.ofType("structured_result")[0].result.value, { echo: "hello" },
      "structured settlement fans out to every attached client");
    assert.equal(second.ofType("structured_result")[0].result.requestId, undefined,
      "only the issuing surface receives its restored correlation id");

    first.socket.destroy();
    second.socket.destroy();
  } finally {
    await daemon.cleanup();
  }
});

test("daemon routes stable per-item queue updates, edits, and removal", async () => {
  const daemon = await startDaemon({ turnMs: 500 });
  try {
    const client = connect(daemon.socketPath);
    await client.connected();
    await client.hello();
    client.send({ type: "attach", sessionId: "queue-session" });
    await waitFor(() => client.ofType("attached").length === 1, 5_000, "queue session attach");

    client.send({ id: "turn", type: "prompt", message: "keep running", sessionId: "queue-session" });
    await waitFor(() => client.ofType("agent_start").length === 1, 5_000, "active queue turn");
    client.send({ id: "steer", type: "steer", message: "first queued", sessionId: "queue-session" });
    client.send({ id: "follow", type: "follow_up", message: "second queued", sessionId: "queue-session" });
    await waitFor(() => client.frames.filter((frame) => frame.type === "response" && ["steer", "follow_up"].includes(frame.command)).length === 2, 5_000, "queue ids");
    const steerId = client.frames.find((frame) => frame.id === "steer")?.data.queueId;
    const followId = client.frames.find((frame) => frame.id === "follow")?.data.queueId;
    assert.equal(typeof steerId, "string");
    assert.equal(typeof followId, "string");
    await waitFor(() => client.ofType("queue_update").some((frame) => frame.steeringItems?.some((item) => item.id === steerId)), 3_000, "stable queue update");

    client.send({ id: "update", type: "update_queued", queueId: steerId, message: "edited queued", sessionId: "queue-session" });
    client.send({ id: "remove", type: "remove_queued", queueId: followId, sessionId: "queue-session" });
    await waitFor(() => client.frames.some((frame) => frame.id === "update") && client.frames.some((frame) => frame.id === "remove"), 5_000, "queue mutations");
    assert.equal(client.frames.find((frame) => frame.id === "update").data.message, "edited queued");
    assert.equal(client.frames.find((frame) => frame.id === "remove").data.id, followId);
    await waitFor(() => client.ofType("queue_update").some((frame) => frame.steeringItems?.[0]?.message === "edited queued" && frame.followUpItems?.length === 0), 3_000, "mutated queue update");
    client.socket.destroy();
  } finally {
    await daemon.cleanup();
  }
});

test("unattached stats for a live session use persisted read authority instead of routing commands", async () => {
  const daemon = await startDaemon();
  try {
    const cwd = join(daemon.daemonDir, "stats-workspace");
    const sessionDir = join(daemon.agentDir, "sessions", "workspace");
    await Promise.all([mkdir(cwd), mkdir(sessionDir, { recursive: true })]);
    await writeFile(join(sessionDir, "live-stats.jsonl"), persistedSession({ id: "live-stats", cwd }));
    const owner = connect(daemon.socketPath);
    const observer = connect(daemon.socketPath);
    await Promise.all([owner.connected(), observer.connected()]);
    await Promise.all([owner.hello(), observer.hello()]);
    owner.send({ type: "attach", sessionId: "live-stats", cwd });
    await waitFor(() => owner.ofType("attached").length === 1, 5_000, "live stats owner");

    observer.send({ id: "stats-observer", type: "get_session_stats", sessionId: "live-stats" });
    await waitFor(() => observer.frames.some((frame) => frame.id === "stats-observer"), 5_000, "unattached persisted stats");
    const response = observer.frames.find((frame) => frame.id === "stats-observer");
    assert.equal(response.success, true);
    assert.equal(response.data.sessionId, "live-stats");
    assert.equal(response.data.lastUsage.totalTokens, 2);
    owner.socket.destroy();
    observer.socket.destroy();
  } finally {
    await daemon.cleanup();
  }
});

test("an external writer produces a typed conflict and authenticated handoff routing", async () => {
  const ownerDir = await mkdtemp(join(tmpdir(), "mypi-external-owner-test-"));
  const sessionFile = join(ownerDir, "blocked.jsonl");
  const socketPath = join(ownerDir, "owner.sock");
  const ownerId = "test-external-owner";
  const token = "test-owner-token";
  const owner = {
    version: 2,
    pid: process.pid,
    processStartTime: Math.round(performance.timeOrigin),
    hostname: (await import("node:os")).hostname(),
    startedAt: new Date().toISOString(),
    surface: "pi-cli",
    ownerId,
    control: { protocol: 1, socketPath, token },
  };
  await writeFile(sessionFile, "{}\n");
  await writeFile(`${sessionFile}.lease`, `${JSON.stringify(owner)}\n`);

  const requests = [];
  const ownerServer = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline));
      requests.push(request);
      if (request.force) {
        void rm(`${sessionFile}.lease`, { force: true }).then(() => {
          socket.end(`${JSON.stringify({ type: "handoff_result", status: "accepted" })}\n`);
        });
      } else if (requests.length === 1) {
        socket.end(`${JSON.stringify({ type: "handoff_result", status: "busy", message: "active turn" })}\n`);
      }
    });
  });
  await new Promise((resolve, reject) => {
    ownerServer.once("error", reject);
    ownerServer.listen(socketPath, resolve);
  });

  const daemon = await startDaemon({
    failSession: "blocked",
    ownershipConflict: { sessionFile, owner },
    ownerControlTimeoutMs: 100,
  });
  try {
    const client = connect(daemon.socketPath);
    await client.connected();
    await client.hello();
    client.send({ type: "attach", sessionId: "blocked" });
    await waitFor(() => client.ofType("ownership_conflict").length === 1, 5_000, "typed conflict");
    const conflict = client.ofType("ownership_conflict")[0];
    assert.equal(conflict.owner.pid, process.pid);
    assert.equal(conflict.owner.surface, "pi-cli");
    assert.equal(conflict.owner.cooperativeHandoffAvailable, true);
    assert.equal("control" in conflict.owner, false, "the control capability is not exposed to clients");

    client.send({
      id: "h1",
      type: "request_handoff",
      targetSessionId: "blocked",
      expectedOwnerId: ownerId,
    });
    await waitFor(
      () => client.ofType("response").some((frame) => frame.id === "h1"),
      5_000,
      "busy handoff response",
    );
    assert.equal(client.ofType("response").find((frame) => frame.id === "h1").data.status, "busy");

    client.send({
      id: "h-timeout",
      type: "request_handoff",
      targetSessionId: "blocked",
      expectedOwnerId: ownerId,
    });
    await waitFor(
      () => client.ofType("response").some((frame) => frame.id === "h-timeout"),
      5_000,
      "handoff timeout response",
    );
    assert.equal(
      client.ofType("response").find((frame) => frame.id === "h-timeout").data.status,
      "unavailable",
    );

    client.send({
      id: "h2",
      type: "request_handoff",
      targetSessionId: "blocked",
      expectedOwnerId: ownerId,
      force: true,
    });
    await waitFor(
      () => client.ofType("response").some((frame) => frame.id === "h2"),
      5_000,
      "forced cooperative release",
    );
    assert.equal(client.ofType("response").find((frame) => frame.id === "h2").data.status, "released");
    assert.deepEqual(requests.map((request) => request.force), [false, false, true]);
    client.socket.destroy();
  } finally {
    ownerServer.close();
    await daemon.cleanup();
    await rm(ownerDir, { recursive: true, force: true });
  }
});

test("Rob uses verified SIGTERM and requires a separate request before SIGKILL", async () => {
  const ownerDir = await mkdtemp(join(tmpdir(), "mypi-signal-owner-test-"));
  const sessionFile = join(ownerDir, "blocked.jsonl");
  const child = spawn(process.execPath, ["-e", `
    process.on('SIGTERM', () => {});
    process.stdout.write(JSON.stringify({ pid: process.pid, processStartTime: Math.round(performance.timeOrigin) }) + '\\n');
    setInterval(() => {}, 1000);
  `], { stdio: ["ignore", "pipe", "ignore"] });
  const childExit = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  const identity = await new Promise((resolve, reject) => {
    let buffer = "";
    child.once("error", reject);
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline >= 0) resolve(JSON.parse(buffer.slice(0, newline)));
    });
  });
  const owner = {
    version: 2,
    pid: identity.pid,
    processStartTime: identity.processStartTime,
    hostname: (await import("node:os")).hostname(),
    startedAt: new Date().toISOString(),
    surface: "pi-cli",
    ownerId: "signal-owner-id",
  };
  await writeFile(sessionFile, "{}\n");
  await writeFile(`${sessionFile}.lease`, `${JSON.stringify(owner)}\n`);

  const daemon = await startDaemon({
    failSession: "blocked",
    ownershipConflict: { sessionFile, owner },
    signalGraceMs: 300,
  });
  try {
    const client = connect(daemon.socketPath);
    await client.connected();
    await client.hello();
    client.send({ type: "attach", sessionId: "blocked" });
    await waitFor(() => client.ofType("ownership_conflict").length === 1, 5_000, "signal conflict");

    client.send({
      id: "term",
      type: "request_handoff",
      targetSessionId: "blocked",
      expectedOwnerId: owner.ownerId,
      force: true,
    });
    await waitFor(
      () => client.ofType("response").some((frame) => frame.id === "term"),
      5_000,
      "SIGTERM result",
    );
    const termResult = client.ofType("response").find((frame) => frame.id === "term").data;
    assert.equal(termResult.status, "needs-sigkill");
    assert.equal(typeof termResult.confirmationToken, "string");
    assert.doesNotThrow(() => process.kill(owner.pid, 0), "the SIGTERM-resistant owner remains alive");

    client.send({
      id: "kill-without-confirmation",
      type: "request_handoff",
      targetSessionId: "blocked",
      expectedOwnerId: owner.ownerId,
      force: true,
      hard: true,
    });
    await waitFor(
      () => client.ofType("response").some((frame) => frame.id === "kill-without-confirmation"),
      5_000,
      "unconfirmed SIGKILL refusal",
    );
    assert.equal(
      client.ofType("response").find((frame) => frame.id === "kill-without-confirmation").data.status,
      "confirmation-required",
    );
    assert.doesNotThrow(() => process.kill(owner.pid, 0), "an unconfirmed SIGKILL was not sent");

    client.send({
      id: "kill",
      type: "request_handoff",
      targetSessionId: "blocked",
      expectedOwnerId: owner.ownerId,
      force: true,
      hard: true,
      confirmationToken: termResult.confirmationToken,
    });
    await waitFor(
      () => client.ofType("response").some((frame) => frame.id === "kill"),
      5_000,
      "SIGKILL result",
    );
    assert.equal(client.ofType("response").find((frame) => frame.id === "kill").data.status, "released");
    assert.equal((await childExit).signal, "SIGKILL");
    client.socket.destroy();
  } finally {
    try { child.kill("SIGKILL"); } catch {}
    await daemon.cleanup();
    await rm(ownerDir, { recursive: true, force: true });
  }
});

test("Rob refuses a reused PID whose process start time does not match", async () => {
  const ownerDir = await mkdtemp(join(tmpdir(), "mypi-pid-reuse-test-"));
  const sessionFile = join(ownerDir, "blocked.jsonl");
  const child = spawn(process.execPath, ["-e", `
    process.stdout.write(JSON.stringify({ pid: process.pid, processStartTime: Math.round(performance.timeOrigin) }) + '\\n');
    setInterval(() => {}, 1000);
  `], { stdio: ["ignore", "pipe", "ignore"] });
  const identity = await new Promise((resolve, reject) => {
    let buffer = "";
    child.once("error", reject);
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline >= 0) resolve(JSON.parse(buffer.slice(0, newline)));
    });
  });
  const owner = {
    version: 2,
    pid: identity.pid,
    processStartTime: identity.processStartTime - 60_000,
    hostname: (await import("node:os")).hostname(),
    startedAt: new Date().toISOString(),
    surface: "pi-cli",
    ownerId: "reused-pid-owner-id",
  };
  await writeFile(sessionFile, "{}\n");
  await writeFile(`${sessionFile}.lease`, `${JSON.stringify(owner)}\n`);

  const daemon = await startDaemon({ failSession: "blocked", ownershipConflict: { sessionFile, owner } });
  try {
    const client = connect(daemon.socketPath);
    await client.connected();
    await client.hello();
    client.send({ type: "attach", sessionId: "blocked" });
    await waitFor(() => client.ofType("ownership_conflict").length === 1, 5_000, "PID-reuse conflict");
    client.send({
      id: "rob",
      type: "request_handoff",
      targetSessionId: "blocked",
      expectedOwnerId: owner.ownerId,
      force: true,
    });
    await waitFor(
      () => client.ofType("response").some((frame) => frame.id === "rob"),
      5_000,
      "PID-reuse refusal",
    );
    assert.equal(client.ofType("response").find((frame) => frame.id === "rob").data.status, "unverifiable");
    assert.doesNotThrow(() => process.kill(owner.pid, 0), "the unrelated live process was not signaled");
    client.socket.destroy();
  } finally {
    child.kill("SIGKILL");
    await daemon.cleanup();
    await rm(ownerDir, { recursive: true, force: true });
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
    await waitFor(() => late.ofType("extension_ui_request").length === 1, 5_000, "pending prompt replayed");
    assert.equal(late.ofType("extension_ui_request")[0].question, "Proceed?",
      "the late joiner receives the whole prompt, not just its id");

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
  const previousDetachMarker = process.env.FAKE_ENGINE_DETACH_MARKER;
  const detachMarker = join(tmpdir(), `mypi-subagent-detach-${process.pid}-${Date.now()}`);
  process.env.FAKE_ENGINE_TURN_MS = "600";
  process.env.FAKE_ENGINE_DETACH_MARKER = detachMarker;
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
    await waitFor(() => existsSync(detachMarker), 3_000, "last-client detach reached engine");

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
    if (previousDetachMarker === undefined) delete process.env.FAKE_ENGINE_DETACH_MARKER;
    else process.env.FAKE_ENGINE_DETACH_MARKER = previousDetachMarker;
    await rm(detachMarker, { force: true });
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

function spawnAttach(daemonDir, attachArgs = []) {
  const child = spawn(process.execPath, [ATTACH_SCRIPT, "attach", ...attachArgs], {
    env: {
      ...process.env,
      MYPI_DAEMON_DIR: daemonDir,
      MYPI_DAEMON_ENGINE_CMD: JSON.stringify([process.execPath, FAKE_ENGINE]),
      MYPI_ATTACH_TAKE_EXEC: JSON.stringify([process.execPath, FAKE_TUI]),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (d) => { stdout += d.toString(); });
  child.stderr.on("data", (d) => { stdout += d.toString(); });
  return {
    child,
    get stdout() { return stdout; },
    write(line) { child.stdin.write(`${line}\n`); },
    exited: new Promise((resolve) => child.once("exit", resolve)),
  };
}

test("mypi attach drives a session through the daemon and detaches cleanly", async () => {
  const daemon = await startDaemon({ idleGraceMs: 5_000 });
  try {
    const attach = spawnAttach(daemon.daemonDir, ["s1"]);
    await waitFor(() => attach.stdout.includes("Attached to session s1"), 8_000, "attach banner");

    attach.write("hello daemon");
    await waitFor(() => attach.stdout.includes("echo:hello daemon"), 8_000, "streamed echo");
    await waitFor(() => attach.stdout.includes("[turn success]"), 8_000, "settled");

    attach.write("/detach");
    assert.equal(await attach.exited, 0);

    // Detaching must leave the session running for other surfaces.
    const probe = connect(daemon.socketPath);
    await probe.connected();
    await probe.hello();
    probe.send({ type: "list_sessions" });
    await waitFor(() => probe.ofType("sessions").length === 1, 3_000, "listing");
    assert.equal(probe.ofType("sessions")[0].sessions.length, 1, "the session outlived the client");
    probe.socket.destroy();
  } finally {
    await daemon.cleanup();
  }
});

test("two mypi attach CLIs co-drive one daemon child without takeover", async () => {
  const daemon = await startDaemon({ idleGraceMs: 5_000 });
  try {
    const first = spawnAttach(daemon.daemonDir, ["s1"]);
    const second = spawnAttach(daemon.daemonDir, ["s1"]);
    await waitFor(
      () => first.stdout.includes("Attached to session s1") && second.stdout.includes("Attached to session s1"),
      8_000,
      "both CLI attachments",
    );

    first.write("from first cli");
    await waitFor(
      () => first.stdout.includes("echo:from first cli") && second.stdout.includes("echo:from first cli"),
      8_000,
      "shared CLI stream",
    );
    assert.doesNotMatch(`${first.stdout}\n${second.stdout}`, /owned by|Rob session|writer lock/i,
      "ordinary CLI/CLI attachment never enters lease negotiation");

    first.write("/detach");
    second.write("/detach");
    assert.equal(await first.exited, 0);
    assert.equal(await second.exited, 0);
  } finally {
    await daemon.cleanup();
  }
});

test("mypi attach --take releases the session and opens it natively", async () => {
  const daemon = await startDaemon({ idleGraceMs: 5_000 });
  try {
    const seed = connect(daemon.socketPath);
    await seed.connected();
    await seed.hello();
    seed.send({ type: "attach", sessionId: "s1" });
    await waitFor(() => seed.ofType("attached").length === 1, 6_000, "seeded session");

    const attach = spawnAttach(daemon.daemonDir, ["--take", "s1"]);
    const code = await attach.exited;
    assert.equal(code, 0, `takeover exited cleanly. output: ${attach.stdout}`);
    assert.match(attach.stdout, /Session released\. Opening it in the TUI/);
    assert.match(attach.stdout, /FAKE_TUI --session .*s1\.jsonl/);
    await waitFor(() => seed.ofType("session_released").length === 1, 5_000, "other clients told");
    seed.socket.destroy();
  } finally {
    await daemon.cleanup();
  }
});

test("attach without a sessionId creates a fresh session keyed by its native id", async () => {
  const daemon = await startDaemon();
  try {
    const client = connect(daemon.socketPath);
    await client.connected();
    await client.hello();

    client.send({ type: "attach", cwd: daemon.daemonDir });
    await waitFor(() => client.ofType("attached").length === 1, 5_000, "attached");
    const attached = client.ofType("attached")[0];
    assert.equal(attached.sessionId, "fake-session-1", "the attached frame carries the engine's native id");
    assert.equal(attached.nativeSessionId, "fake-session-1");

    // The adopted id routes commands to the fresh child.
    client.send({ id: "s", type: "get_state", sessionId: attached.sessionId });
    await waitFor(() => client.ofType("response").length === 1, 5_000, "routed response");
    assert.equal(client.ofType("response")[0].data.sessionId, "fake-session-1");

    client.send({ type: "list_sessions" });
    await waitFor(() => client.ofType("sessions").length === 1, 3_000, "session list");
    assert.deepEqual(
      client.ofType("sessions")[0].sessions.map((s) => s.sessionId),
      ["fake-session-1"],
      "the fresh session is listed under its native id, not a placeholder",
    );
    client.socket.destroy();
  } finally {
    await daemon.cleanup();
  }
});

test("the first prompt answer wins and other surfaces are told it resolved", async () => {
  const daemon = await startDaemon({ mode: "ask-user" });
  try {
    const first = connect(daemon.socketPath);
    const second = connect(daemon.socketPath);
    await Promise.all([first.connected(), second.connected()]);
    await Promise.all([first.hello(), second.hello()]);
    first.send({ type: "attach", sessionId: "s1" });
    second.send({ type: "attach", sessionId: "s1" });
    await waitFor(() => second.ofType("attached").length === 1, 5_000, "attached");

    first.send({ id: "p1", type: "prompt", message: "go", sessionId: "s1" });
    await waitFor(
      () => first.ofType("extension_ui_request").length === 1 && second.ofType("extension_ui_request").length === 1,
      5_000,
      "prompt fan-out",
    );

    second.send({ type: "extension_ui_response", id: "ask-1", value: "Yes", sessionId: "s1" });
    await waitFor(() => first.ofType("extension_ui_resolved").length === 1, 5_000, "resolved notice");
    assert.equal(first.ofType("extension_ui_resolved")[0].id, "ask-1");
    assert.equal(
      second.ofType("extension_ui_resolved").length,
      0,
      "the answering client does not get a resolution notice for its own answer",
    );

    // A late answer for the same prompt is dropped, not forwarded twice.
    first.send({ type: "extension_ui_response", id: "ask-1", value: "No", sessionId: "s1" });
    await waitFor(() => first.ofType("__fake_ui_response_received").length === 1, 5_000, "engine received one answer");
    assert.equal(first.ofType("__fake_ui_response_received")[0].value, "Yes");
    first.socket.destroy();
    second.socket.destroy();
  } finally {
    await daemon.cleanup();
  }
});

test("a legacy identity-changing command cannot move clients sharing a child", async () => {
  const daemon = await startDaemon();
  try {
    const client = connect(daemon.socketPath);
    const watcher = connect(daemon.socketPath);
    await Promise.all([client.connected(), watcher.connected()]);
    await Promise.all([client.hello(), watcher.hello()]);
    client.send({ type: "attach", sessionId: "s1" });
    watcher.send({ type: "attach", sessionId: "s1" });
    await waitFor(() => watcher.ofType("attached").length === 1, 5_000, "attached");

    client.send({ id: "n1", type: "new_session", sessionId: "s1" });
    await waitFor(() => client.ofType("error").length === 1, 5_000, "shared identity change refused");
    assert.equal(client.ofType("error")[0].code, "shared_session_identity_change_refused");
    assert.match(client.ofType("error")[0].error, /only the requester moves/);
    assert.equal(watcher.ofType("attached").length, 1, "the watcher was never rebound");

    client.send({ id: "s2", type: "get_state", sessionId: "s1" });
    await waitFor(() => client.ofType("response").length === 1, 5_000, "source still routes");
    assert.equal(client.ofType("response")[0].data.sessionId, "s1");
    client.socket.destroy();
    watcher.socket.destroy();
  } finally {
    await daemon.cleanup();
  }
});

test("a daemon client can prepare and attach a requester-local target while its source stays live", async () => {
  const daemon = await startDaemon();
  try {
    const client = connect(daemon.socketPath);
    const watcher = connect(daemon.socketPath);
    await Promise.all([client.connected(), watcher.connected()]);
    await Promise.all([client.hello(), watcher.hello()]);
    client.send({ type: "attach", sessionId: "source", cwd: daemon.daemonDir });
    watcher.send({ type: "attach", sessionId: "source", cwd: daemon.daemonDir });
    await waitFor(() => watcher.ofType("attached").length === 1, 5_000, "source attached");

    client.send({
      id: "prepare",
      type: "prepare_surface_session",
      sourceSessionId: "source",
      operation: "new",
    });
    await waitFor(
      () => client.ofType("response").some((frame) => frame.id === "prepare"),
      5_000,
      "prepared target",
    );
    const prepared = client.ofType("response").find((frame) => frame.id === "prepare");
    assert.equal(prepared.command, "prepare_surface_session");
    assert.equal(prepared.data.cancelled, false);
    assert.notEqual(prepared.data.target.sessionId, "source");
    assert.equal(watcher.ofType("attached").length, 1, "preparation did not move the watcher");

    client.send({
      type: "attach",
      sessionId: prepared.data.target.sessionId,
      cwd: prepared.data.target.cwd,
      sessionStart: { reason: "new" },
    });
    await waitFor(
      () => client.ofType("attached").some((frame) => frame.sessionId === prepared.data.target.sessionId),
      5_000,
      "target attached",
    );
    await waitFor(
      () => client.ofType("__fake_session_start").some((frame) => frame.sessionId === prepared.data.target.sessionId),
      5_000,
      "target lifecycle metadata",
    );
    assert.deepEqual(
      client.ofType("__fake_session_start").find((frame) => frame.sessionId === prepared.data.target.sessionId).value,
      { reason: "new" },
    );
    client.send({ type: "detach", sessionId: "source" });
    client.send({ id: "target-state", type: "get_state", sessionId: prepared.data.target.sessionId });
    await waitFor(
      () => client.ofType("response").some((frame) => frame.id === "target-state"),
      5_000,
      "target routes",
    );
    assert.equal(watcher.ofType("attached")[0].sessionId, "source");

    client.socket.destroy();
    watcher.socket.destroy();
  } finally {
    await daemon.cleanup();
  }
});

test("daemon_status reports the running version, session count, and active turns", async () => {
  const daemon = await startDaemon({ version: "9.9.9 (pi-core 0.0.0)" });
  try {
    const client = connect(daemon.socketPath);
    await client.connected();
    await client.hello();
    // Sidecar records the running version for connect-free discovery.
    const sidecar = JSON.parse(readFileSync(join(daemon.daemonDir, "daemon.json"), "utf8"));
    assert.equal(sidecar.runtimeVersion, "9.9.9 (pi-core 0.0.0)");

    client.send({ type: "daemon_status" });
    await waitFor(() => client.ofType("daemon_status").length === 1, 3_000, "status reply");
    const status = client.ofType("daemon_status")[0];
    assert.equal(status.runtimeVersion, "9.9.9 (pi-core 0.0.0)");
    assert.equal(status.sessions, 0);
    assert.equal(status.activeTurns, 0);
    assert.equal(status.draining, false);
    client.socket.destroy();
  } finally {
    await daemon.cleanup();
  }
});

test("restart drains an idle daemon and exits", async () => {
  const daemon = await startDaemon();
  try {
    const exited = new Promise((resolve) => daemon.child.once("exit", resolve));
    const client = connect(daemon.socketPath);
    await client.connected();
    await client.hello();
    client.send({ type: "restart" });
    await waitFor(() => client.ofType("restart_ack").length === 1, 3_000, "restart ack");
    assert.equal(client.ofType("restart_ack")[0].activeTurns, 0);
    await exited;
    assert.equal(existsSync(join(daemon.daemonDir, "daemon.json")), false, "sidecar removed on exit");
  } finally {
    await daemon.cleanup();
  }
});

test("restart waits for an active turn, refuses new attaches while draining, then exits", async () => {
  const daemon = await startDaemon({ turnMs: 800 });
  try {
    const driver = connect(daemon.socketPath);
    await driver.connected();
    await driver.hello();
    driver.send({ type: "attach", cwd: daemon.daemonDir });
    await waitFor(() => driver.ofType("attached").length === 1, 5_000, "attached");
    const sessionId = driver.ofType("attached")[0].sessionId;

    // Start a turn, then request a restart while it is still running.
    driver.send({ type: "prompt", message: "hi", sessionId });
    await waitFor(() => driver.frames.some((f) => f.type === "agent_start"), 3_000, "turn started");

    const exited = new Promise((resolve) => daemon.child.once("exit", resolve));
    const ctl = connect(daemon.socketPath);
    await ctl.connected();
    await ctl.hello();
    ctl.send({ type: "restart" });
    await waitFor(() => ctl.ofType("restart_ack").length === 1, 3_000, "restart ack");
    assert.equal(ctl.ofType("restart_ack")[0].activeTurns, 1, "sees the in-flight turn");
    // Attached surfaces are told a restart is underway.
    await waitFor(() => driver.ofType("daemon_restarting").length === 1, 3_000, "restart broadcast");

    // A new attach mid-drain is refused rather than spawning more work.
    const late = connect(daemon.socketPath);
    await late.connected();
    await late.hello();
    late.send({ type: "attach", cwd: daemon.daemonDir });
    await waitFor(() => late.ofType("daemon_draining").length === 1, 3_000, "attach refused");
    late.socket.destroy();

    // The daemon stays up until the turn settles, then exits.
    assert.equal(daemon.child.exitCode, null, "still running during the turn");
    await waitFor(() => driver.frames.some((f) => f.type === "agent_settled"), 3_000, "turn settled");
    await exited;
    driver.socket.destroy();
    ctl.socket.destroy();
  } finally {
    await daemon.cleanup();
  }
});

test("chat sessions list with profile and attach through the sealed chat recipe", async () => {
  const daemon = await startDaemon();
  try {
    const cwd = join(daemon.daemonDir, "workspace");
    const sessionDir = join(daemon.agentDir, "sessions", "workspace");
    const chatAssets = join(daemon.agentDir, "chat-sessions", "assets", "chat-asset-1");
    const chatHistory = join(daemon.agentDir, "chat-sessions", "history");
    await Promise.all([
      mkdir(cwd, { recursive: true }),
      mkdir(sessionDir, { recursive: true }),
      mkdir(chatAssets, { recursive: true }),
      mkdir(chatHistory, { recursive: true }),
    ]);
    await writeFile(join(sessionDir, "coding.jsonl"), persistedSession({ id: "coding-1", cwd }));
    await writeFile(
      join(chatHistory, "chat.jsonl"),
      persistedSession({ id: "chat-1", cwd: chatAssets, name: "A chat" }),
    );

    const client = connect(daemon.socketPath);
    await client.connected();
    await client.hello();
    const response = (id) => client.frames.find((frame) => frame.type === "response" && frame.id === id);

    // Listing carries the profile marker for both roots.
    client.send({ id: "all", type: "list_persisted_sessions" });
    await waitFor(() => response("all"), 5_000, "combined listing");
    const all = response("all").data.sessions;
    assert.equal(all.find((s) => s.id === "chat-1")?.profile, "chat");
    assert.equal(all.find((s) => s.id === "coding-1")?.profile, "coding");

    // Profile filter narrows to chats only.
    client.send({ id: "chats", type: "list_persisted_sessions", profile: "chat" });
    await waitFor(() => response("chats"), 5_000, "chat-only listing");
    assert.deepEqual(response("chats").data.sessions.map((s) => s.id), ["chat-1"]);

    // read_session serves the chat transcript from the chat root.
    client.send({ id: "read", type: "read_session", sessionId: "chat-1", limit: 2 });
    await waitFor(() => response("read"), 5_000, "chat read");
    assert.equal(response("read").success, true);
    assert.equal(response("read").data.entries.length, 2);

    // A fresh chat attach spawns the sealed recipe: asset cwd + canvas.md.
    client.send({ type: "attach", profile: "chat" });
    await waitFor(() => client.ofType("attached").length === 1, 10_000, "chat attached");
    const attached = client.ofType("attached")[0];
    assert.equal(attached.profile, "chat");
    assert.ok(attached.cwd.includes(join("chat-sessions", "assets")), `chat cwd is an asset dir: ${attached.cwd}`);
    assert.ok(existsSync(join(attached.cwd, "canvas.md")), "fresh chat owns a canvas.md");
    client.socket.destroy();
  } finally {
    await daemon.cleanup();
  }
});

test("set_project_trust writes and clears trust decisions", async () => {
  const daemon = await startDaemon();
  try {
    const cwd = join(daemon.daemonDir, "trusted-workspace");
    await mkdir(cwd, { recursive: true });
    const client = connect(daemon.socketPath);
    await client.connected();
    await client.hello();
    const response = (id) => client.frames.find((frame) => frame.type === "response" && frame.id === id);

    client.send({ id: "t1", type: "set_project_trust", cwd, trusted: false });
    await waitFor(() => response("t1"), 5_000, "untrust write");
    assert.equal(response("t1").success, true);
    const trustPath = join(daemon.agentDir, "trust.json");
    assert.ok(readFileSync(trustPath, "utf8").includes("trusted-workspace"), "decision persisted");

    client.send({ id: "t2", type: "set_project_trust", cwd, trusted: null });
    await waitFor(() => response("t2"), 5_000, "trust removal");
    assert.equal(response("t2").success, true);
    assert.ok(!readFileSync(trustPath, "utf8").includes("trusted-workspace"), "decision removed");
    client.socket.destroy();
  } finally {
    await daemon.cleanup();
  }
});
