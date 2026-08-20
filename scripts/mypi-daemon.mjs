// MyPi session daemon (FEAT-061, docs/25-unified-session-authority.md).
//
// One daemon per profile owns every live session. Surfaces (CloudCLI, the
// future GUI, `mypi attach`, and eventually the TUI) connect to a single
// socket, `$MYPI_AGENT_DIR/daemon.sock`, and address sessions by id. Each
// session is served by its own `mypi --mode rpc` child, because Pi's RPC
// mode is single-session per process; the daemon is a frame router and a
// child supervisor, never a writer itself, so the per-session writer lease
// invariant is unchanged.
//
// Chosen over one socket per session because remote management needs a
// single endpoint: `ssh host mypi proxy` gives a GUI one pipe over which it
// can list, attach, and drive every session, instead of having to know a
// session id before it can connect (see docs/25 for the tradeoff table).
//
// Wire protocol (JSONL, one JSON object per line):
//
//   client -> daemon
//     {type:"hello", protocol:N, client:"name"}       required first frame
//     {type:"list_sessions"}
//     {type:"attach", sessionId?, cwd?, model?}       subscribe (spawns child)
//       Omitting sessionId creates a fresh engine session; the daemon keys
//       it under the native session id once the child reports it, and the
//       `attached` frame carries that id for the client to adopt.
//     {type:"detach", sessionId}
//     {type:"release", sessionId, force?}             native takeover support
//     {..any RPC command.., sessionId, id?}           routed to the child
//     {type:"extension_ui_response", sessionId, id, ...}
//
//   daemon -> client
//     {type:"hello_ack", protocol, daemonVersion, pid}
//     {type:"hello_error", reason, protocol}          then close
//     {type:"sessions", sessions:[{sessionId, cwd, sessionFile, clients, busy}]}
//     {type:"attached", sessionId, sessionFile, cwd, clients}
//       Re-broadcast whenever the child's identity changes (new_session,
//       switch_session, fork, clone) so every surface tracks the live target.
//     {type:"released"|"release_denied", sessionId, ...}
//     {type:"session_exit", sessionId, code, signal, lastErrorNotify}
//     {type:"extension_ui_resolved", sessionId, id}   another client answered
//     {..engine event/response.., sessionId}          fan-out / routed reply
//
// Version handshake is deliberately conservative: the protocol number is
// exact-match, and a mismatch is refused with a typed frame naming both
// sides rather than being negotiated down. Surfaces are shipped together
// with the daemon, so a mismatch means a stale process, and failing loudly
// beats silently degrading.

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import {
  MYPI_DAEMON_PROTOCOL,
  acquireStartupLock,
  daemonDir,
  daemonSidecarPath,
  daemonSocketPath,
  readLiveDaemon,
} from "./mypi-daemon-discovery.mjs";

const DEFAULT_IDLE_GRACE_MS = 5 * 60_000;
const ENGINE_CLOSE_GRACE_MS = 2_000;
const STATE_TIMEOUT_MS = 15_000;

const RESPONDABLE_UI_METHODS = new Set(["mypiAskUser", "select", "confirm", "input", "editor"]);
// Engine commands that replace the child's session in place. A successful
// response triggers a state re-query so the daemon's identity stays truthful.
const IDENTITY_CHANGING_COMMANDS = new Set(["new_session", "switch_session", "fork", "clone"]);

/* ------------------------------------------------------------------ */
/*  Daemon                                                             */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  let idleGraceMs = DEFAULT_IDLE_GRACE_MS;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--idle-grace-ms") {
      idleGraceMs = Number(argv[index + 1]);
      if (!Number.isFinite(idleGraceMs) || idleGraceMs < 0) throw new Error("Invalid --idle-grace-ms");
      index += 1;
    }
  }
  return { idleGraceMs };
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

const { idleGraceMs } = parseArgs(process.argv.slice(3));

/** @type {Map<string, {child: import('node:child_process').ChildProcess, sessionId: string, sessionFile: string|null, cwd: string, clients: Set<object>, pending: Map<string, {client: object, originalId: string|undefined}>, outstandingUi: Set<string>, turnActive: boolean, exited: boolean, graceTimer: NodeJS.Timeout|null, counter: number, lastErrorNotify: string|null, pendingRelease: object|null}>} */
const sessions = new Map();
/** @type {Set<object>} connections that completed the handshake */
const clients = new Set();

let server = null;
let shuttingDown = false;

function sendToClient(client, frame) {
  if (client.socket.destroyed) return;
  client.socket.write(`${JSON.stringify(frame)}\n`);
}

function broadcast(session, frame) {
  for (const client of session.clients) sendToClient(client, frame);
}

function writeSidecar(socketPath) {
  writeFileSync(daemonSidecarPath(), `${JSON.stringify({
    pid: process.pid,
    protocol: MYPI_DAEMON_PROTOCOL,
    socketPath,
    startedAt: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 });
}

function removeOwnFiles() {
  const sidecarPath = daemonSidecarPath();
  try {
    const current = JSON.parse(readFileSync(sidecarPath, "utf8"));
    if (current?.pid === process.pid) rmSync(sidecarPath, { force: true });
  } catch {
    // Already replaced or unreadable; leave it for pid-liveness pruning.
  }
  rmSync(daemonSocketPath(), { force: true });
}

function engineCommand(session) {
  if (process.env.MYPI_DAEMON_ENGINE_CMD) {
    const base = JSON.parse(process.env.MYPI_DAEMON_ENGINE_CMD);
    return [...base, ...(session.sessionId ? ["--session", session.sessionId] : []), ...(session.model ? ["--model", session.model] : [])];
  }
  return [
    process.execPath,
    process.argv[1],
    "--mode",
    "rpc",
    ...(session.sessionId ? ["--session", session.sessionId] : []),
    ...(session.model ? ["--model", session.model] : []),
  ];
}

let newSessionCounter = 0;

function startSession({ sessionId, cwd, model }) {
  const session = {
    sessionId: sessionId || null,
    // Fresh sessions have no id until the engine reports one; they are keyed
    // under a private placeholder and re-keyed on the first state report.
    key: sessionId || `__new_${(newSessionCounter += 1)}`,
    cwd: cwd || process.cwd(),
    model: model || null,
    sessionFile: null,
    child: null,
    clients: new Set(),
    pending: new Map(),
    outstandingUi: new Map(),
    turnActive: false,
    exited: false,
    graceTimer: null,
    counter: 0,
    lastErrorNotify: null,
    pendingRelease: null,
    ready: false,
  };
  const [executable, ...args] = engineCommand(session);
  session.child = spawn(executable, args, {
    cwd: session.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  attachLineReader(session.child.stdout, (line) => handleEngineFrame(session, line));
  attachLineReader(session.child.stderr, (text) => broadcast(session, { type: "session_stderr", sessionId: session.sessionId ?? session.key, text }));

  session.child.on("exit", (code, signal) => {
    session.exited = true;
    broadcast(session, {
      type: "session_exit",
      sessionId: session.sessionId ?? session.key,
      code,
      signal,
      lastErrorNotify: session.lastErrorNotify,
    });
    for (const client of session.clients) client.sessions.delete(session.key);
    sessions.delete(session.key);
  });
  session.child.on("error", () => {
    session.exited = true;
    broadcast(session, { type: "session_exit", sessionId: session.sessionId ?? session.key, code: null, signal: null, lastErrorNotify: "engine spawn failed" });
    sessions.delete(session.key);
  });

  sessions.set(session.key, session);
  // Learn the native session id / file; the response never reaches clients.
  sendToEngine(session, { id: "__daemon_state", type: "get_state" });
  const timer = setTimeout(() => {
    if (!session.ready && !session.exited) session.child.kill("SIGTERM");
  }, STATE_TIMEOUT_MS);
  timer.unref?.();
  return session;
}

function sendToEngine(session, frame) {
  if (session.exited || !session.child.stdin.writable) return;
  session.child.stdin.write(`${JSON.stringify(frame)}\n`);
}

function handleEngineFrame(session, line) {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    broadcast(session, { type: "session_raw", sessionId: session.sessionId ?? session.key, line });
    return;
  }

  if (frame?.type === "response" && typeof frame.id === "string") {
    if (frame.id === "__daemon_state") {
      if (frame.success && frame.data) {
        session.ready = true;
        const nativeSessionId = frame.data.sessionId ?? session.sessionId;
        if (typeof nativeSessionId === "string" && nativeSessionId && nativeSessionId !== session.key) {
          rekeySession(session, nativeSessionId);
        }
        session.nativeSessionId = nativeSessionId;
        session.sessionFile = frame.data.sessionFile ?? null;
        if (typeof frame.data.cwd === "string" && frame.data.cwd) session.cwd = frame.data.cwd;
        broadcast(session, {
          type: "attached",
          sessionId: session.sessionId ?? session.key,
          nativeSessionId: session.nativeSessionId,
          sessionFile: session.sessionFile,
          cwd: session.cwd,
          clients: session.clients.size,
        });
      }
      return;
    }
    if (frame.id === "__daemon_release_abort") return;
    const pending = session.pending.get(frame.id);
    if (pending) {
      session.pending.delete(frame.id);
      const restored = { ...frame, sessionId: session.sessionId ?? session.key };
      if (pending.originalId === undefined) delete restored.id;
      else restored.id = pending.originalId;
      sendToClient(pending.client, restored);
      // These commands replace the child's session in place; re-learn the
      // identity and tell every surface where the child now points.
      if (frame.success && IDENTITY_CHANGING_COMMANDS.has(pending.commandType)) {
        sendToEngine(session, { id: "__daemon_state", type: "get_state" });
      }
      return;
    }
    broadcast(session, { ...frame, sessionId: session.sessionId ?? session.key });
    return;
  }

  if (frame?.type === "extension_ui_request") {
    if (frame.method === "notify" && frame.notifyType === "error" && typeof frame.message === "string") {
      session.lastErrorNotify = frame.message;
    }
    if (RESPONDABLE_UI_METHODS.has(frame.method) && typeof frame.id === "string") {
      // Kept whole so a client attaching later sees the real prompt, not just
      // the knowledge that one exists.
      session.outstandingUi.set(frame.id, { ...frame, sessionId: session.sessionId ?? session.key });
    }
    if (frame.method === "dismiss" && typeof frame.targetId === "string") session.outstandingUi.delete(frame.targetId);
    broadcast(session, { ...frame, sessionId: session.sessionId ?? session.key });
    return;
  }

  if (frame?.type === "agent_start") session.turnActive = true;
  if (frame?.type === "agent_settled") {
    session.turnActive = false;
    broadcast(session, { ...frame, sessionId: session.sessionId ?? session.key });
    if (session.pendingRelease) {
      completeRelease(session);
      return;
    }
    if (session.clients.size === 0) scheduleSessionGrace(session);
    return;
  }

  // Events that echo a command id (bash_execution_update) carry the daemon's
  // routed id; the requester must see its own id back to correlate output.
  if (typeof frame?.id === "string" && session.pending.has(frame.id)) {
    const pending = session.pending.get(frame.id);
    for (const client of session.clients) {
      if (client === pending.client) {
        const restored = { ...frame, sessionId: session.sessionId ?? session.key };
        if (pending.originalId === undefined) delete restored.id;
        else restored.id = pending.originalId;
        sendToClient(client, restored);
      } else {
        sendToClient(client, { ...frame, sessionId: session.sessionId ?? session.key });
      }
    }
    return;
  }

  broadcast(session, { ...frame, sessionId: session.sessionId ?? session.key });
}

/**
 * Move a session to a new key when the child's native identity is learned or
 * changes (fresh attach, new_session, switch_session, fork, clone). Attached
 * clients keep following the same child; only the address changes.
 */
function rekeySession(session, nativeSessionId) {
  const previousKey = session.key;
  if (previousKey === nativeSessionId) return;
  if (sessions.get(previousKey) === session) sessions.delete(previousKey);
  sessions.set(nativeSessionId, session);
  session.key = nativeSessionId;
  session.sessionId = nativeSessionId;
  for (const client of session.clients) {
    client.sessions.delete(previousKey);
    client.sessions.add(nativeSessionId);
  }
}

function scheduleSessionGrace(session) {
  if (session.graceTimer) clearTimeout(session.graceTimer);
  session.graceTimer = setTimeout(() => {
    session.graceTimer = null;
    if (session.clients.size > 0 || session.exited) return;
    if (session.turnActive) {
      // A turn in flight keeps the session loaded even with nobody watching,
      // matching the "sessions outlive their clients" contract.
      scheduleSessionGrace(session);
      return;
    }
    closeSession(session);
  }, idleGraceMs);
  session.graceTimer.unref?.();
}

function closeSession(session) {
  if (session.exited) return;
  try {
    session.child.stdin.end();
  } catch {
    session.child.kill("SIGTERM");
  }
  const killTimer = setTimeout(() => session.child.kill("SIGTERM"), ENGINE_CLOSE_GRACE_MS);
  killTimer.unref?.();
}

function completeRelease(session) {
  const requester = session.pendingRelease?.client;
  session.pendingRelease = null;
  if (requester) {
    sendToClient(requester, {
      type: "released",
      sessionId: session.sessionId ?? session.key,
      sessionFile: session.sessionFile,
    });
  }
  broadcast(session, { type: "session_released", sessionId: session.sessionId ?? session.key });
  closeSession(session);
}

function handleRelease(client, session, frame) {
  if (session.pendingRelease) {
    sendToClient(client, { type: "release_denied", sessionId: session.sessionId ?? session.key, reason: "Another release is already in progress." });
    return;
  }
  if (session.turnActive && frame.force !== true) {
    sendToClient(client, {
      type: "release_denied",
      sessionId: session.sessionId ?? session.key,
      reason: "A turn is in progress. Retry with force to abort it, or wait for it to settle.",
      turnActive: true,
    });
    return;
  }
  session.pendingRelease = { client };
  if (session.turnActive) {
    sendToEngine(session, { id: "__daemon_release_abort", type: "abort" });
    const fallback = setTimeout(() => {
      if (session.pendingRelease) completeRelease(session);
    }, 10_000);
    fallback.unref?.();
    return;
  }
  completeRelease(session);
}

function detachClientFromSession(client, session) {
  if (!session.clients.delete(client)) return;
  client.sessions.delete(session.key);
  for (const [id, pending] of session.pending) {
    if (pending.client === client) session.pending.delete(id);
  }
  if (session.clients.size === 0) scheduleSessionGrace(session);
}

function handleClientFrame(client, frame) {
  if (!client.helloDone) {
    if (frame?.type !== "hello") {
      sendToClient(client, { type: "hello_error", reason: "The first frame must be a hello.", protocol: MYPI_DAEMON_PROTOCOL });
      client.socket.end();
      return;
    }
    if (frame.protocol !== MYPI_DAEMON_PROTOCOL) {
      sendToClient(client, {
        type: "hello_error",
        reason: `This daemon speaks protocol ${MYPI_DAEMON_PROTOCOL}; the client speaks ${frame.protocol}. Restart the older side.`,
        protocol: MYPI_DAEMON_PROTOCOL,
        clientProtocol: frame.protocol ?? null,
      });
      client.socket.end();
      return;
    }
    client.helloDone = true;
    client.name = typeof frame.client === "string" ? frame.client.slice(0, 64) : "unknown";
    clients.add(client);
    sendToClient(client, {
      type: "hello_ack",
      protocol: MYPI_DAEMON_PROTOCOL,
      pid: process.pid,
      daemonVersion: process.env.MYPI_RUNTIME_DISPLAY_VERSION ?? null,
    });
    return;
  }

  if (frame?.type === "list_sessions") {
    sendToClient(client, {
      type: "sessions",
      sessions: [...sessions.values()].map((session) => ({
        sessionId: session.sessionId ?? session.key,
        nativeSessionId: session.nativeSessionId ?? null,
        sessionFile: session.sessionFile,
        cwd: session.cwd,
        clients: session.clients.size,
        busy: session.turnActive,
      })),
    });
    return;
  }

  if (frame?.type === "attach") {
    const sessionId = String(frame.sessionId ?? "");
    // No sessionId creates a fresh engine session; the daemon re-keys it and
    // broadcasts `attached` once the child reports its native id.
    let session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session) session = startSession({ sessionId, cwd: frame.cwd, model: frame.model });
    if (session.graceTimer) {
      clearTimeout(session.graceTimer);
      session.graceTimer = null;
    }
    session.clients.add(client);
    client.sessions.add(session.key);
    if (session.ready) {
      sendToClient(client, {
        type: "attached",
        sessionId: session.sessionId ?? session.key,
        nativeSessionId: session.nativeSessionId ?? null,
        sessionFile: session.sessionFile,
        cwd: session.cwd,
        clients: session.clients.size,
      });
      // Late joiners receive the prompts still waiting for an answer, in
      // full, so they can render and answer them like any other client.
      for (const pendingFrame of session.outstandingUi.values()) {
        sendToClient(client, pendingFrame);
      }
    }
    return;
  }

  const sessionId = String(frame?.sessionId ?? "");
  const session = sessions.get(sessionId);
  if (!session) {
    sendToClient(client, {
      type: "error",
      sessionId,
      ...(typeof frame?.id === "string" ? { id: frame.id } : {}),
      error: `No live session "${sessionId}"; attach first.`,
    });
    return;
  }

  if (frame.type === "detach") {
    detachClientFromSession(client, session);
    sendToClient(client, { type: "detached", sessionId });
    return;
  }

  if (frame.type === "release") {
    handleRelease(client, session, frame);
    return;
  }

  if (frame.type === "extension_ui_response") {
    if (typeof frame.id !== "string" || !session.outstandingUi.has(frame.id)) return;
    session.outstandingUi.delete(frame.id);
    const { sessionId: _ignored, ...engineFrame } = frame;
    sendToEngine(session, engineFrame);
    // First answer wins; every other surface is told to drop its dialog.
    for (const other of session.clients) {
      if (other !== client) {
        sendToClient(other, { type: "extension_ui_resolved", sessionId: session.sessionId ?? session.key, id: frame.id });
      }
    }
    return;
  }

  if (typeof frame.type === "string") {
    if (frame.type === "prompt" || frame.type === "steer" || frame.type === "follow_up") session.turnActive = true;
    session.counter += 1;
    const routedId = `__dc_${session.counter}`;
    session.pending.set(routedId, {
      client,
      originalId: typeof frame.id === "string" ? frame.id : undefined,
      commandType: frame.type,
    });
    const { sessionId: _ignored, ...engineFrame } = frame;
    sendToEngine(session, { ...engineFrame, id: routedId });
  }
}

function acceptConnection(socket) {
  const client = { socket, helloDone: false, sessions: new Set(), name: "unknown" };
  socket.setNoDelay(true);
  attachLineReader(socket, (line) => {
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      sendToClient(client, { type: "error", error: "Malformed JSON frame" });
      return;
    }
    handleClientFrame(client, frame);
  });
  const drop = () => {
    clients.delete(client);
    for (const sessionId of [...client.sessions]) {
      const session = sessions.get(sessionId);
      if (session) detachClientFromSession(client, session);
    }
  };
  socket.on("close", drop);
  socket.on("error", drop);
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  // Children must not outlive the daemon: an orphaned engine would keep a
  // writer lease with nobody able to reach it.
  for (const session of sessions.values()) {
    try {
      session.child.kill("SIGTERM");
    } catch {
      // Already gone.
    }
  }
  removeOwnFiles();
  process.exit(0);
}

mkdirSync(daemonDir(), { recursive: true, mode: 0o700 });
const socketPath = daemonSocketPath();
const lock = acquireStartupLock();
if (!lock.acquired && readLiveDaemon()) {
  process.stdout.write(`${JSON.stringify({ type: "daemon_ready", socketPath, reused: true })}\n`);
  process.exit(0);
}
rmSync(socketPath, { force: true });

server = net.createServer(acceptConnection);
server.listen(socketPath, () => {
  writeSidecar(socketPath);
  lock.release();
  try {
    process.stdout.write(`${JSON.stringify({ type: "daemon_ready", socketPath, pid: process.pid, protocol: MYPI_DAEMON_PROTOCOL })}\n`);
  } catch {
    // The spawner may already be gone; the sidecar is the real contract.
  }
});
server.on("error", (error) => {
  lock.release();
  process.stderr.write(`MyPi daemon failed to listen: ${error.message}\n`);
  process.exit(1);
});

process.stdout.on("error", () => {});
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
