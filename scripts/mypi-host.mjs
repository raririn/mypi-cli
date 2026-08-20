// MyPi session host (FEAT-060, docs/24-session-host-architecture.md).
//
// DEPRECATED by the session daemon (FEAT-061, docs/25): one socket per
// session made remote management require the session id before a client
// could connect. Kept so CloudCLI builds released before the daemon keep
// working; new surfaces use `mypi __daemon` and `mypi attach`. Remove this
// command, its test lane, and its discovery directory once no supported
// CloudCLI spawns `__host`.
//
// Wraps the unmodified `--mode rpc` engine and serves its JSONL RPC protocol
// on a unix socket so several surfaces (CloudCLI, `mypi attach`, later the
// TUI) can attach to one live session. The host is a frame router, not a
// semantic layer: commands get per-client id rewriting, events fan out to all
// clients, and the first extension_ui_response for a prompt wins. Ownership
// and lease semantics are untouched — the engine child is the session's
// single writer, exactly as in plain RPC mode.
//
// Invoked as `mypi __host [engine args...]` by the launcher. Host-specific
// flags (all optional) are consumed before the engine args:
//   --host-grace-ms <ms>   linger after the last client disconnects (30000)
// Environment (test seams):
//   MYPI_HOST_ENGINE_CMD   JSON array argv for the engine (default: the
//                          launcher with --mode rpc)
//   MYPI_HOST_DIR          hosts directory (default: $MYPI_AGENT_DIR/hosts)
//
// Stdout contract: exactly one `{"type":"host_ready","socketPath":...}` line
// once the socket is listening; nothing else. The spawner may exit at any
// point afterwards — the host survives it.

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const DEFAULT_GRACE_MS = 30_000;
const ENGINE_CLOSE_GRACE_MS = 2_000;
const STATE_TIMEOUT_MS = 15_000;
const HOST_STATE_ID = "__host_state";

// UI request methods that expect an extension_ui_response.
const RESPONDABLE_UI_METHODS = new Set(["mypiAskUser", "select", "confirm", "input", "editor"]);

function agentDir() {
  const configured = process.env.MYPI_AGENT_DIR || process.env.MYPI_CODING_AGENT_DIR;
  return resolve(configured || join(homedir(), ".mypi", "agent"));
}

function hostsDir() {
  return process.env.MYPI_HOST_DIR ? resolve(process.env.MYPI_HOST_DIR) : join(agentDir(), "hosts");
}

function parseArgs(argv) {
  const engineArgs = [];
  let graceMs = DEFAULT_GRACE_MS;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--host-grace-ms") {
      graceMs = Number(argv[index + 1]);
      if (!Number.isFinite(graceMs) || graceMs < 0) throw new Error("Invalid --host-grace-ms value");
      index += 1;
      continue;
    }
    engineArgs.push(argv[index]);
  }
  return { engineArgs, graceMs };
}

function engineCommand(engineArgs) {
  if (process.env.MYPI_HOST_ENGINE_CMD) {
    const base = JSON.parse(process.env.MYPI_HOST_ENGINE_CMD);
    if (!Array.isArray(base) || base.length === 0) throw new Error("MYPI_HOST_ENGINE_CMD must be a JSON argv array");
    return [...base, ...engineArgs];
  }
  // process.argv[1] is the mypi launcher when running as `mypi __host`.
  return [process.execPath, process.argv[1], "--mode", "rpc", ...engineArgs];
}

function attachLineReader(stream, onLine) {
  let buffer = "";
  stream.on("data", (data) => {
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.replace(/\r$/, "");
      if (trimmed.trim()) onLine(trimmed);
    }
  });
}

// argv: [node, <mypi launcher>, "__host", ...host/engine args]
const { engineArgs, graceMs } = parseArgs(process.argv.slice(3));

const dir = hostsDir();
mkdirSync(dir, { recursive: true, mode: 0o700 });

const hostId = randomUUID().slice(0, 8);
const socketPath = join(dir, `host-${process.pid}-${hostId}.sock`);
rmSync(socketPath, { force: true });

/** @type {Map<string, {client: import('node:net').Socket, originalId: string | undefined}>} */
const pendingCommands = new Map();
/** @type {Set<import('node:net').Socket>} */
const clients = new Set();
/** @type {Set<string>} outstanding respondable extension_ui_request ids */
const outstandingUi = new Set();

let commandCounter = 0;
let turnActive = false;
let engineExited = false;
let shuttingDown = false;
let sidecarPath = null;
let sessionInfo = null; // { sessionId, sessionFile, cwd }
let graceTimer = null;
let stateTimer = null;

const [engineExecutable, ...engineArgv] = engineCommand(engineArgs);
const engine = spawn(engineExecutable, engineArgv, {
  cwd: process.cwd(),
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env },
});

let lastErrorNotify = null;

function sendToEngine(frame) {
  if (engineExited || !engine.stdin.writable) return;
  engine.stdin.write(`${JSON.stringify(frame)}\n`);
}

function sendToClient(client, frame) {
  if (client.destroyed) return;
  client.write(`${JSON.stringify(frame)}\n`);
}

function broadcast(frame) {
  const line = `${JSON.stringify(frame)}\n`;
  for (const client of clients) {
    if (!client.destroyed) client.write(line);
  }
}

function writeSidecar() {
  if (!sessionInfo?.sessionId) return;
  sidecarPath = join(dir, `${sessionInfo.sessionId}.host.json`);
  const payload = {
    pid: process.pid,
    socketPath,
    sessionId: sessionInfo.sessionId,
    sessionFile: sessionInfo.sessionFile ?? null,
    cwd: process.cwd(),
    startedAt: new Date().toISOString(),
  };
  writeFileSync(sidecarPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
}

function removeOwnFiles() {
  rmSync(socketPath, { force: true });
  if (!sidecarPath) return;
  // Remove the sidecar only when it is still ours: a racing winner host may
  // have overwritten it, and its discovery entry must survive our exit.
  try {
    const current = JSON.parse(readFileSync(sidecarPath, "utf8"));
    if (current?.pid === process.pid) rmSync(sidecarPath, { force: true });
  } catch {
    // Unreadable sidecar: leave it for pid-liveness pruning by the next reader.
  }
}

function scheduleGraceCheck() {
  if (graceTimer) clearTimeout(graceTimer);
  graceTimer = setTimeout(() => {
    graceTimer = null;
    maybeShutdown();
  }, graceMs);
  graceTimer.unref?.();
}

function maybeShutdown() {
  if (shuttingDown || engineExited) return;
  if (clients.size > 0) return;
  if (turnActive) {
    // An in-flight turn settles first (a CloudCLI restart mid-turn must not
    // kill the turn); re-check on settlement and keep a fallback heartbeat.
    scheduleGraceCheck();
    return;
  }
  void shutdown();
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (!engineExited) {
    await new Promise((resolveWait) => {
      const killTimer = setTimeout(() => engine.kill("SIGTERM"), ENGINE_CLOSE_GRACE_MS);
      killTimer.unref?.();
      engine.once("exit", () => {
        clearTimeout(killTimer);
        resolveWait();
      });
      try {
        engine.stdin.end();
      } catch {
        engine.kill("SIGTERM");
      }
    });
  }
  removeOwnFiles();
  process.exit(0);
}

function handleEngineFrame(line) {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    // The launcher can print bootstrap noise before the engine takes stdout.
    broadcast({ type: "host_engine_raw", line });
    return;
  }

  if (frame?.type === "response" && typeof frame.id === "string") {
    if (frame.id === "__host_release_abort" || frame.id === "__host_subagent_detached") {
      // Internal abort issued for a forced release; settlement completes it.
      return;
    }
    if (frame.id === HOST_STATE_ID) {
      if (stateTimer) clearTimeout(stateTimer);
      if (frame.success && frame.data) {
        sessionInfo = {
          sessionId: frame.data.sessionId,
          sessionFile: frame.data.sessionFile ?? null,
          cwd: process.cwd(),
        };
        writeSidecar();
        broadcast(helloFrame());
      }
      return;
    }
    const pending = pendingCommands.get(frame.id);
    if (pending) {
      pendingCommands.delete(frame.id);
      const restored = { ...frame };
      if (pending.originalId === undefined) delete restored.id;
      else restored.id = pending.originalId;
      sendToClient(pending.client, restored);
      return;
    }
    // Unattributable response (should not happen): let everyone see it.
    broadcast(frame);
    return;
  }

  if (frame?.type === "extension_ui_request") {
    if (frame.method === "notify" && frame.notifyType === "error" && typeof frame.message === "string") {
      lastErrorNotify = frame.message;
    }
    if (RESPONDABLE_UI_METHODS.has(frame.method) && typeof frame.id === "string") {
      outstandingUi.add(frame.id);
    }
    if (frame.method === "dismiss" && typeof frame.targetId === "string") {
      outstandingUi.delete(frame.targetId);
    }
    broadcast(frame);
    return;
  }

  if (frame?.type === "agent_start") turnActive = true;
  if (frame?.type === "agent_settled") {
    turnActive = false;
    if (pendingRelease) {
      broadcast(frame);
      completeRelease();
      return;
    }
    if (clients.size === 0) {
      sendToEngine({ id: "__host_subagent_detached", type: "notify_parent_detached" });
      scheduleGraceCheck();
    }
  }
  if (frame?.type === "agent_end" && frame.willRetry !== true) turnActive = false;

  broadcast(frame);
}

/**
 * Native takeover (FEAT-060 Phase 2b): a client asks this host to shut down
 * cleanly so another surface (the full TUI) can own the session natively.
 * Ownership only ever moves via clean shutdown of the owning runtime — the
 * lease is never transferred. A mid-turn release is refused unless the
 * requester passes force, in which case the turn is aborted and the release
 * completes on settlement.
 */
let pendingRelease = null; // { client }

function completeRelease() {
  const requester = pendingRelease?.client;
  pendingRelease = null;
  if (requester && !requester.destroyed) {
    sendToClient(requester, { type: "host_release_ok", sessionId: sessionInfo?.sessionId ?? null, sessionFile: sessionInfo?.sessionFile ?? null });
  }
  broadcast({ type: "host_released", sessionId: sessionInfo?.sessionId ?? null });
  void shutdown();
}

function handleReleaseRequest(client, frame) {
  if (shuttingDown || engineExited) {
    sendToClient(client, { type: "host_release_ok", sessionId: sessionInfo?.sessionId ?? null, sessionFile: sessionInfo?.sessionFile ?? null });
    return;
  }
  if (pendingRelease) {
    sendToClient(client, { type: "host_release_denied", reason: "Another release is already in progress." });
    return;
  }
  if (turnActive && frame.force !== true) {
    sendToClient(client, {
      type: "host_release_denied",
      reason: "A turn is in progress. Retry with force to abort it, or wait for it to settle.",
      turnActive: true,
    });
    return;
  }
  pendingRelease = { client };
  if (turnActive) {
    // Forced: abort the in-flight turn; completeRelease fires on settlement
    // (see the agent_settled handler), with a fallback timer in case the
    // engine never settles.
    sendToEngine({ id: "__host_release_abort", type: "abort" });
    const fallback = setTimeout(() => {
      if (pendingRelease) completeRelease();
    }, 10_000);
    fallback.unref?.();
    return;
  }
  completeRelease();
}

function helloFrame() {
  return {
    type: "host_hello",
    hostPid: process.pid,
    sessionId: sessionInfo?.sessionId ?? null,
    sessionFile: sessionInfo?.sessionFile ?? null,
    cwd: process.cwd(),
    clients: clients.size,
  };
}

function handleClientFrame(client, line) {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    sendToClient(client, { type: "host_error", error: "Malformed JSON frame" });
    return;
  }

  if (frame?.type === "host_release") {
    handleReleaseRequest(client, frame);
    return;
  }

  if (frame?.type === "extension_ui_response") {
    if (typeof frame.id !== "string" || !outstandingUi.has(frame.id)) return; // answered already or unknown
    outstandingUi.delete(frame.id);
    sendToEngine(frame);
    return;
  }

  if (frame && typeof frame.type === "string") {
    if (frame.type === "prompt" || frame.type === "steer" || frame.type === "follow_up") {
      turnActive = true; // optimistic; agent_start/agent_settled are authoritative
    }
    commandCounter += 1;
    const hostCommandId = `__hc_${commandCounter}`;
    pendingCommands.set(hostCommandId, { client, originalId: typeof frame.id === "string" ? frame.id : undefined });
    sendToEngine({ ...frame, id: hostCommandId });
    return;
  }

  sendToClient(client, { type: "host_error", error: "Frame has no type" });
}

attachLineReader(engine.stdout, handleEngineFrame);
attachLineReader(engine.stderr, (text) => broadcast({ type: "host_engine_stderr", text }));

engine.on("exit", (code, signal) => {
  engineExited = true;
  broadcast({ type: "host_engine_exit", code, signal, lastErrorNotify });
  for (const client of clients) client.end();
  removeOwnFiles();
  // Give the broadcast writes a moment to flush before exiting.
  setTimeout(() => process.exit(code ? 1 : 0), 50);
});

engine.on("error", () => {
  engineExited = true;
  broadcast({ type: "host_engine_exit", code: null, signal: null, lastErrorNotify: "engine spawn failed" });
  removeOwnFiles();
  process.exit(1);
});

const server = net.createServer((client) => {
  if (shuttingDown || engineExited) {
    client.end();
    return;
  }
  clients.add(client);
  if (graceTimer) {
    clearTimeout(graceTimer);
    graceTimer = null;
  }
  if (sessionInfo) sendToClient(client, helloFrame());
  attachLineReader(client, (line) => handleClientFrame(client, line));
  const drop = () => {
    if (!clients.delete(client)) return;
    // Orphan this client's unanswered commands; their responses are dropped.
    for (const [id, pending] of pendingCommands) {
      if (pending.client === client) pendingCommands.delete(id);
    }
    if (clients.size === 0) {
      sendToEngine({ id: "__host_subagent_detached", type: "notify_parent_detached" });
      scheduleGraceCheck();
    }
  };
  client.on("close", drop);
  client.on("error", drop);
});

server.listen(socketPath, () => {
  try {
    process.stdout.write(`${JSON.stringify({ type: "host_ready", socketPath, pid: process.pid })}\n`);
  } catch {
    // Spawner may already be gone; the socket is the real contract.
  }
  // Learn the native session id for discovery; the response is intercepted in
  // handleEngineFrame and never reaches clients.
  sendToEngine({ id: HOST_STATE_ID, type: "get_state" });
  stateTimer = setTimeout(() => {
    // Engine never answered get_state: it is wedged or refused the session.
    if (!engineExited) engine.kill("SIGTERM");
  }, STATE_TIMEOUT_MS);
  stateTimer.unref?.();
  // Nobody may ever connect (spawner died); make sure we do not linger.
  scheduleGraceCheck();
});

process.stdout.on("error", () => {});
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
