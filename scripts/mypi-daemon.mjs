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
//     {type:"hello", protocol:N, client:"name", pid?, processStartTime?}
//                                                        required first frame
//     {type:"list_sessions"}
//     {type:"list_persisted_sessions", cwd?, includeArchived?, offset?, limit?}
//     {type:"read_session", sessionId?|sessionFile?, since?, limit?, maxBytes?}
//     {type:"get_available_models", cwd?}             no engine required
//     {type:"list_skills"|"list_extensions", cwd?}   no engine required
//     {type:"get_session_stats", sessionId|sessionFile} no engine required
//     {type:"daemon_status"}                           version/pid/turn counts
//     {type:"restart", force?}                         graceful drain + exit
//     {type:"attach", sessionId?, cwd?, model?, sessionStart?}
//                                                       subscribe (spawns child)
//       Omitting sessionId creates a fresh engine session; the daemon keys
//       it under the native session id once the child reports it, and the
//       `attached` frame carries that id for the client to adopt.
//     {type:"detach", sessionId}
//     {type:"release", sessionId, force?}             native takeover support
//     {type:"request_handoff", targetSessionId,
//       expectedOwnerId, force?, hard?, confirmationToken?}
//                                                       exceptional external owner
//     {type:"prepare_surface_session", sourceSessionId,
//       operation:"new"|"fork", parentSession?, entryId?, position?, id?}
//                                                       requester-local target
//     {..any RPC command.., sessionId, id?}           routed to the child
//       Includes remove_queued/update_queued for stable queue item IDs.
//     {type:"extension_ui_response", sessionId, id, ...}
//
//   daemon -> client
//     {type:"hello_ack", protocol, daemonVersion, pid}
//     {type:"hello_error", reason, protocol}          then close
//     {type:"daemon_status", runtimeVersion, pid, draining, sessions, activeTurns, ...}
//     {type:"restart_ack", draining, force, activeSessions, activeTurns}
//     {type:"daemon_restarting", force}               broadcast when a drain starts
//     {type:"daemon_draining", reason}                new attach refused mid-drain
//     {type:"sessions", sessions:[{sessionId, cwd, sessionFile, clients, busy}]}
//     {type:"response", command:"list_persisted_sessions"|"read_session"|...}
//     {type:"configuration_warning", code, message, path}
//     {type:"persisted_changed", sessionId, sessionFile, cwd, kind}
//     {type:"session_maintenance", ..., archivedExcess, command?}
//     {type:"attached", sessionId, sessionFile, cwd, clients}
//       Re-broadcast if a legacy sole-client command changes child identity.
//       Modern navigation/create/derive attaches the requester to another child.
//     {type:"released"|"release_denied", sessionId, ...}
//     {type:"ownership_conflict", sessionId, sessionFile, owner}
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
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { hostname } from "node:os";
import { resolve } from "node:path";
import {
  MYPI_DAEMON_PROTOCOL,
  acquireStartupLock,
  daemonDir,
  daemonSidecarPath,
  daemonSocketPath,
  readLiveDaemon,
} from "./mypi-daemon-discovery.mjs";
import {
  getDaemonAvailableModels,
  getAgentDir,
  getPersistedSessionStats,
  listDaemonExtensions,
  listDaemonSkills,
  listPersistedSessions,
  loadGlobalConfig,
  readPersistedSession,
  runNewSessionMaintenance,
} from "@earendil-works/pi-coding-agent";

const DEFAULT_IDLE_GRACE_MS = 5 * 60_000;
const ENGINE_CLOSE_GRACE_MS = 2_000;
const STATE_TIMEOUT_MS = 15_000;
const EXTERNAL_OWNER_TTL_MS = 60_000;
const SESSION_LOCK_STALE_MS = 30_000;
const configuredOwnerControlTimeoutMs = Number(process.env.MYPI_DAEMON_OWNER_CONTROL_TIMEOUT_MS || 30_000);
const OWNER_CONTROL_TIMEOUT_MS = Number.isFinite(configuredOwnerControlTimeoutMs) && configuredOwnerControlTimeoutMs >= 0
  ? configuredOwnerControlTimeoutMs
  : 30_000;
const OWNER_RELEASE_TIMEOUT_MS = 35_000;
const configuredSignalGraceMs = Number(process.env.MYPI_DAEMON_SIGNAL_GRACE_MS || 10_000);
const SIGNAL_EXIT_GRACE_MS = Number.isFinite(configuredSignalGraceMs) && configuredSignalGraceMs >= 0
  ? configuredSignalGraceMs
  : 10_000;
const OWNERSHIP_CONFLICT_PREFIX = "@@MYPI_OWNERSHIP_CONFLICT@@";

const RESPONDABLE_UI_METHODS = new Set(["mypiAskUser", "select", "confirm", "input", "editor"]);
// Legacy engine commands that replace a child in place. They remain safe for
// a sole attached surface, but are refused when a child is shared: modern
// clients prepare and attach a distinct target child instead.
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

async function startDetachedWorker() {
  const live = readLiveDaemon();
  if (live) {
    process.stdout.write(`${JSON.stringify({ type: "daemon_ready", socketPath: live.socketPath, pid: live.pid, protocol: live.protocol, reused: true })}\n`);
    return;
  }
  const child = spawn(process.execPath, process.argv.slice(1), {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, MYPI_DAEMON_WORKER: "1" },
  });
  let exitCode;
  child.once("exit", (code) => { exitCode = code; });
  const deadline = Date.now() + 15_000;
  while (Date.now() <= deadline) {
    const started = readLiveDaemon();
    if (started) {
      child.unref();
      process.stdout.write(`${JSON.stringify({
        type: "daemon_ready",
        socketPath: started.socketPath,
        pid: started.pid,
        protocol: started.protocol,
      })}\n`);
      return;
    }
    if (exitCode !== undefined) throw new Error(`MyPi daemon worker exited during startup (code ${exitCode})`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  try { child.kill("SIGTERM"); } catch {}
  throw new Error("Timed out waiting for detached MyPi daemon worker");
}

// Re-exec one worker with an explicit stdio table. This is the portable
// close-fds boundary: inherited GUI/browser pipes, files, and sockets stay in
// the short-lived starter, while the long-lived daemon owns only descriptors
// opened by the worker. Tests may opt out to retain a direct child handle.
if (process.env.MYPI_DAEMON_WORKER !== "1" && process.env.MYPI_DAEMON_NO_REEXEC !== "1") {
  try {
    await startDetachedWorker();
    process.exit(0);
  } catch (error) {
    process.stderr.write(`MyPi daemon failed to detach: ${boundedError(error)}\n`);
    process.exit(1);
  }
}

const { idleGraceMs } = parseArgs(process.argv.slice(3));

/** @type {Map<string, {child: import('node:child_process').ChildProcess, sessionId: string, sessionFile: string|null, cwd: string, clients: Set<object>, pending: Map<string, {client: object, originalId: string|undefined, commandType?: string, structuredOutput?: boolean}>, structuredCorrelations: Map<string, {client: object, originalId: string|undefined}>, outstandingUi: Set<string>, turnActive: boolean, exited: boolean, graceTimer: NodeJS.Timeout|null, counter: number, lastErrorNotify: string|null, pendingRelease: object|null}>} */
const sessions = new Map();
/** @type {Map<string, {sessionId: string, sessionFile: string, owner: object, observedAt: number}>} */
const externalOwners = new Map();
/** @type {Set<object>} connections that completed the handshake */
const clients = new Set();
const daemonAgentDir = getAgentDir();
const globalConfigResult = loadGlobalConfig(resolve(daemonAgentDir, "config.yaml"));

let server = null;
let shuttingDown = false;
// A graceful restart (post-update) drains in place: stop accepting new
// sessions, let in-flight turns settle, then exit so the next launch spawns a
// fresh daemon on the updated code. See `mypi daemon restart`.
let draining = false;
const daemonStartedAt = new Date().toISOString();

function sendToClient(client, frame) {
  if (client.socket.destroyed) return;
  client.socket.write(`${JSON.stringify(frame)}\n`);
}

function broadcast(session, frame) {
  for (const client of session.clients) sendToClient(client, frame);
}

function broadcastAll(frame) {
  for (const client of clients) sendToClient(client, frame);
}

function sendDaemonResponse(client, request, command, task) {
  void Promise.resolve(task).then(
    (data) => sendToClient(client, {
      type: "response",
      command,
      success: true,
      ...(typeof request.id === "string" ? { id: request.id } : {}),
      data,
    }),
    (error) => sendToClient(client, {
      type: "response",
      command,
      success: false,
      ...(typeof request.id === "string" ? { id: request.id } : {}),
      error: boundedError(error),
    }),
  );
}

function boundedError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, " ").slice(0, 1_000) || "Daemon request failed";
}

function persistedChanged(session, kind) {
  if (!session.sessionFile) return;
  broadcastAll({
    type: "persisted_changed",
    sessionId: session.sessionId ?? session.key,
    sessionFile: session.sessionFile,
    cwd: session.cwd,
    kind,
  });
}

function publicOwnershipConflict(record) {
  const owner = record.owner;
  return {
    type: "ownership_conflict",
    protocol: 1,
    sessionId: record.sessionId,
    sessionFile: record.sessionFile,
    owner: {
      pid: Number.isInteger(owner.pid) ? owner.pid : 0,
      hostname: typeof owner.hostname === "string" ? owner.hostname : "unknown",
      startedAt: typeof owner.startedAt === "string" ? owner.startedAt : "unknown",
      surface: typeof owner.surface === "string" ? owner.surface : "unknown",
      ownerId: typeof owner.ownerId === "string" ? owner.ownerId : null,
      processStartTime: typeof owner.processStartTime === "number" ? owner.processStartTime : null,
      cooperativeHandoffAvailable: owner.control?.protocol === 1,
    },
  };
}

function handleOwnershipConflictLine(session, text) {
  if (!text.startsWith(OWNERSHIP_CONFLICT_PREFIX)) return false;
  let value;
  try {
    value = JSON.parse(text.slice(OWNERSHIP_CONFLICT_PREFIX.length));
  } catch {
    return true;
  }
  if (
    value?.protocol !== 1 ||
    typeof value.sessionFile !== "string" ||
    !value.owner ||
    typeof value.owner !== "object" ||
    !Number.isInteger(value.owner.pid) ||
    typeof value.owner.hostname !== "string" ||
    typeof value.owner.startedAt !== "string" ||
    typeof value.owner.surface !== "string"
  ) return true;

  const sessionId = session.sessionId ?? session.key;
  const record = {
    sessionId,
    sessionFile: value.sessionFile,
    owner: value.owner,
    observedAt: Date.now(),
  };
  session.ownershipConflict = record;
  externalOwners.set(sessionId, record);
  broadcast(session, publicOwnershipConflict(record));
  return true;
}

function currentExternalOwner(sessionId) {
  const record = externalOwners.get(sessionId);
  if (!record) return undefined;
  if (Date.now() - record.observedAt > EXTERNAL_OWNER_TTL_MS) {
    externalOwners.delete(sessionId);
    return undefined;
  }
  return record;
}

function writeSidecar(socketPath) {
  writeFileSync(daemonSidecarPath(), `${JSON.stringify({
    pid: process.pid,
    protocol: MYPI_DAEMON_PROTOCOL,
    // The product version this daemon is running, so discovery and
    // `mypi daemon status` can spot a post-update skew without connecting.
    runtimeVersion: process.env.MYPI_RUNTIME_DISPLAY_VERSION ?? null,
    socketPath,
    startedAt: daemonStartedAt,
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

function normalizeSessionStart(value) {
  if (!value || typeof value !== "object") return null;
  if (value.reason !== "new" && value.reason !== "fork") return null;
  return {
    reason: value.reason,
    ...(typeof value.previousSessionFile === "string" ? { previousSessionFile: value.previousSessionFile } : {}),
  };
}

function startSession({ sessionId, cwd, model, sessionStart }) {
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
    structuredCorrelations: new Map(),
    abandonedEngineRequestIds: new Set(),
    outstandingUi: new Map(),
    turnActive: false,
    exited: false,
    graceTimer: null,
    counter: 0,
    lastErrorNotify: null,
    pendingRelease: null,
    preparingSurfaceTarget: false,
    ready: false,
    fresh: !sessionId || sessionStart?.reason === "new",
    persistedAnnounced: false,
    maintenanceStarted: false,
  };
  const [executable, ...args] = engineCommand(session);
  session.child = spawn(executable, args, {
    cwd: session.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      MYPI_DAEMON_ENGINE: "1",
      ...(sessionStart ? { MYPI_DAEMON_SESSION_START: JSON.stringify(sessionStart) } : {}),
    },
  });

  attachLineReader(session.child.stdout, (line) => handleEngineFrame(session, line));
  attachLineReader(session.child.stderr, (text) => {
    if (handleOwnershipConflictLine(session, text)) return;
    broadcast(session, { type: "session_stderr", sessionId: session.sessionId ?? session.key, text });
  });

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
        if (!session.persistedAnnounced && session.sessionFile) {
          session.persistedAnnounced = true;
          persistedChanged(session, session.fresh ? "created" : "attached");
        }
        if (session.fresh && !session.maintenanceStarted && session.sessionFile && typeof nativeSessionId === "string") {
          session.maintenanceStarted = true;
          void runNewSessionMaintenance({
            sessionId: nativeSessionId,
            sessionFile: session.sessionFile,
            cwd: session.cwd,
            agentDir: daemonAgentDir,
          }).then(
            (result) => {
              for (const moved of [...result.archivedShortTests, ...result.archivedOverflow]) {
                broadcastAll({
                  type: "persisted_changed",
                  sessionId: moved.id,
                  sessionFile: moved.to,
                  previousSessionFile: moved.from,
                  cwd: session.cwd,
                  kind: "archived",
                });
              }
              broadcastAll({
                type: "session_maintenance",
                sessionId: nativeSessionId,
                cwd: session.cwd,
                archivedShortTests: result.archivedShortTests.length,
                archivedOverflow: result.archivedOverflow.length,
                activeCount: result.activeCount,
                archivedCount: result.archivedCount,
                archivedExcess: result.archivedExcess,
                ...(result.cleanupCommand ? { command: result.cleanupCommand } : {}),
                ...(result.skipped.length ? { skipped: result.skipped } : {}),
              });
            },
            (error) => broadcast(session, {
              type: "session_maintenance_error",
              sessionId: nativeSessionId,
              message: boundedError(error),
            }),
          );
        }
      }
      return;
    }
    if (frame.id === "__daemon_release_abort") return;
    if (session.abandonedEngineRequestIds.delete(frame.id)) return;
    const pending = session.pending.get(frame.id);
    if (pending) {
      session.pending.delete(frame.id);
      if (frame.success && pending.commandType === "prompt" && pending.structuredOutput) {
        session.structuredCorrelations.set(frame.id, pending);
      }
      const finishedSurfacePreparation = pending.surfacePreparation === true;
      if (finishedSurfacePreparation) session.preparingSurfaceTarget = false;
      const restored = {
        ...frame,
        ...(pending.responseCommand ? { command: pending.responseCommand } : {}),
        sessionId: session.sessionId ?? session.key,
      };
      if (pending.originalId === undefined) delete restored.id;
      else restored.id = pending.originalId;
      sendToClient(pending.client, restored);
      if (frame.success && pending.commandType === "set_session_name") persistedChanged(session, "renamed");
      if (finishedSurfacePreparation && draining) maybeFinishDrain();
      // A legacy sole-client command may still replace the child in place;
      // re-learn its identity so that one client retains a truthful address.
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

  if (frame?.type === "structured_result" || frame?.type === "structured_result_error") {
    const engineRequestId = frame.type === "structured_result" ? frame.result?.requestId : frame.error?.requestId;
    const pending =
      typeof engineRequestId === "string" ? session.structuredCorrelations.get(engineRequestId) : undefined;
    if (pending) {
      session.structuredCorrelations.delete(engineRequestId);
      for (const client of session.clients) {
        const restored = { ...frame, sessionId: session.sessionId ?? session.key };
        const target = frame.type === "structured_result" ? { ...frame.result } : { ...frame.error };
        if (client === pending.client && pending.originalId !== undefined) target.requestId = pending.originalId;
        else delete target.requestId;
        if (frame.type === "structured_result") restored.result = target;
        else restored.error = target;
        sendToClient(client, restored);
      }
      return;
    }
  }

  if (frame?.type === "agent_start") session.turnActive = true;
  if (frame?.type === "agent_settled") {
    session.turnActive = false;
    broadcast(session, { ...frame, sessionId: session.sessionId ?? session.key });
    session.structuredCorrelations.clear();
    persistedChanged(session, "updated");
    // A drain in progress exits as soon as the last turn settles.
    if (draining) maybeFinishDrain();
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
 * Move a session to a new key when a fresh child's native identity is learned
 * or a permitted legacy sole-client command changes it. Attached clients keep
 * following that child; shared children never enter the latter path.
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

function activeTurnCount() {
  let count = 0;
  for (const session of sessions.values()) {
    if (session.turnActive || session.preparingSurfaceTarget) count += 1;
  }
  return count;
}

/**
 * Begin (or re-report) a graceful restart drain. New attaches are refused so
 * the daemon can reach zero active turns and exit; `force` skips the wait and
 * aborts in-flight turns immediately. The next `mypi` launch spawns a fresh
 * daemon on the updated code; persisted sessions re-attach losslessly.
 */
function beginDrain(requester, force) {
  if (!draining) {
    draining = true;
    for (const client of clients) sendToClient(client, { type: "daemon_restarting", force: Boolean(force) });
  }
  if (requester) {
    sendToClient(requester, {
      type: "restart_ack",
      draining: true,
      force: Boolean(force),
      activeSessions: sessions.size,
      activeTurns: activeTurnCount(),
    });
  }
  if (force) {
    void shutdown();
    return;
  }
  maybeFinishDrain();
}

function maybeFinishDrain() {
  if (!draining || shuttingDown) return;
  // Any in-flight turn keeps the daemon alive; its agent_settled re-checks.
  if (activeTurnCount() > 0) return;
  void shutdown();
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
  let cancelledSurfacePreparation = false;
  for (const [id, pending] of session.pending) {
    if (pending.client === client) {
      if (pending.surfacePreparation) {
        session.preparingSurfaceTarget = false;
        cancelledSurfacePreparation = true;
        session.abandonedEngineRequestIds.add(id);
      }
      session.pending.delete(id);
    }
  }
  if (cancelledSurfacePreparation && draining) maybeFinishDrain();
  if (session.clients.size === 0) scheduleSessionGrace(session);
}

function readLease(sessionFile) {
  try {
    const value = JSON.parse(readFileSync(`${sessionFile}.lease`, "utf8"));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function leaseMatches(record, lease = readLease(record.sessionFile)) {
  const owner = record.owner;
  return Boolean(
    lease &&
    typeof owner.ownerId === "string" &&
    owner.ownerId &&
    lease.ownerId === owner.ownerId &&
    lease.pid === owner.pid &&
    lease.hostname === owner.hostname &&
    lease.processStartTime === owner.processStartTime,
  );
}

function observedLeaseMatches(record, lease = readLease(record.sessionFile)) {
  const owner = record.owner;
  if (!lease) return false;
  if (lease.pid !== owner.pid || lease.hostname !== owner.hostname || lease.startedAt !== owner.startedAt) return false;
  if (typeof owner.ownerId === "string" && owner.ownerId && lease.ownerId !== owner.ownerId) return false;
  if (typeof owner.processStartTime === "number" && lease.processStartTime !== owner.processStartTime) return false;
  return true;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function processStartTime(pid) {
  return new Promise((resolve) => {
    execFile("ps", ["-o", "lstart=", "-p", String(pid)], { timeout: 3_000 }, (error, stdout) => {
      if (error) {
        resolve(undefined);
        return;
      }
      const parsed = Date.parse(stdout.trim());
      resolve(Number.isFinite(parsed) ? parsed : undefined);
    });
  });
}

async function verifySignalTarget(record) {
  const owner = record.owner;
  const current = readLease(record.sessionFile);
  if (!leaseMatches(record, current)) {
    return { ok: false, status: "owner-changed", message: "The session owner changed; no process was signaled." };
  }
  if (
    owner.hostname !== hostname() ||
    !Number.isInteger(owner.pid) ||
    owner.pid <= 0 ||
    typeof owner.ownerId !== "string" ||
    !owner.ownerId ||
    typeof owner.processStartTime !== "number" ||
    !Number.isFinite(owner.processStartTime)
  ) {
    return {
      ok: false,
      status: "unverifiable",
      message: "MyPi cannot prove the external owner's same-host process identity. Manage the reported PID manually.",
    };
  }
  const actualStart = await processStartTime(owner.pid);
  if (actualStart === undefined || Math.abs(actualStart - owner.processStartTime) > 2_500) {
    return {
      ok: false,
      status: "unverifiable",
      message: "The reported PID no longer matches the recorded process start time. No process was signaled.",
    };
  }
  return { ok: true };
}

function requestOwnerControl(record, client, force) {
  const control = record.owner.control;
  if (
    control?.protocol !== 1 ||
    typeof control.socketPath !== "string" ||
    typeof control.token !== "string" ||
    typeof record.owner.ownerId !== "string"
  ) {
    return Promise.resolve({
      status: "unavailable",
      message: "The owner does not expose cooperative handoff control.",
    });
  }

  return new Promise((resolve) => {
    const socket = net.connect(control.socketPath);
    let buffer = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish({
      status: "unavailable",
      message: "The owner did not answer the handoff request in time.",
    }), OWNER_CONTROL_TIMEOUT_MS);
    timer.unref?.();
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({
        type: "handoff_request",
        protocol: 1,
        token: control.token,
        ownerId: record.owner.ownerId,
        sessionFile: record.sessionFile,
        requesterPid: client.pid ?? process.pid,
        ...(typeof client.processStartTime === "number"
          ? { requesterProcessStartTime: client.processStartTime }
          : {}),
        force,
      })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 16_384) {
        finish({ status: "error", message: "The owner returned an oversized handoff response." });
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        const statuses = new Set(["accepted", "busy", "declined", "error"]);
        if (response?.type !== "handoff_result" || !statuses.has(response.status)) {
          finish({ status: "error", message: "The owner returned an invalid handoff response." });
          return;
        }
        finish({
          status: response.status,
          ...(typeof response.message === "string" ? { message: response.message } : {}),
        });
      } catch {
        finish({ status: "error", message: "The owner returned a malformed handoff response." });
      }
    });
    socket.on("error", (error) => finish({
      status: "unavailable",
      message: `The owner control endpoint could not be reached (${error.message}).`,
    }));
    socket.on("close", () => finish({
      status: "unavailable",
      message: "The owner closed its control endpoint without answering.",
    }));
  });
}

async function waitForOwnershipRelease(record, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const lease = readLease(record.sessionFile);
    if (!lease) return { status: "released" };
    if (!leaseMatches(record, lease)) {
      return { status: "owner-changed", message: "The session owner changed while handoff was in progress." };
    }
    if (!pidAlive(record.owner.pid)) {
      const lockPath = `${record.sessionFile}.lock`;
      if (!existsSync(lockPath)) return { status: "released" };
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > SESSION_LOCK_STALE_MS) return { status: "released" };
      } catch {
        return { status: "released" };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { status: "timeout", message: "The owner did not release the writer lock in time." };
}

async function negotiateExternalOwnership(client, frame) {
  const sessionId = String(frame.targetSessionId ?? "");
  const record = currentExternalOwner(sessionId);
  if (!record) {
    return { status: "owner-changed", message: "The recorded external owner is no longer current. Resume again to refresh it." };
  }
  const expectedOwnerId = typeof frame.expectedOwnerId === "string" ? frame.expectedOwnerId : null;
  const currentOwnerId = typeof record.owner.ownerId === "string" ? record.owner.ownerId : null;
  if (expectedOwnerId !== currentOwnerId || !observedLeaseMatches(record)) {
    return { status: "owner-changed", message: "The session owner changed; no handoff or signal was attempted." };
  }

  const force = frame.force === true;
  const hard = frame.hard === true;
  if (!currentOwnerId) {
    return force
      ? {
          status: "unverifiable",
          message: "This legacy owner has no owner token. MyPi will not signal it; manage the reported PID manually.",
        }
      : {
          status: "unavailable",
          message: "This legacy owner does not support authenticated handoff. Manage the reported PID manually.",
        };
  }
  if (hard) {
    const authorization = record.sigkillAuthorizations?.get(frame.confirmationToken);
    const requesterMatches = authorization
      && authorization.expiresAt > Date.now()
      && authorization.requesterPid === (client.pid ?? process.pid)
      && authorization.requesterProcessStartTime === client.processStartTime;
    if (!requesterMatches) {
      return {
        status: "confirmation-required",
        message: "SIGKILL was not authorized by a prior SIGTERM result and separate confirmation.",
      };
    }
    record.sigkillAuthorizations.delete(frame.confirmationToken);
  }
  const cooperative = await requestOwnerControl(record, client, force);
  if (!force) {
    if (cooperative.status !== "accepted") return cooperative;
    const released = await waitForOwnershipRelease(record, 15_000);
    if (released.status === "released") externalOwners.delete(sessionId);
    return released;
  }

  // Rob first asks the exact owner to abort and shut down. Signals are only a
  // fallback after that authenticated request fails or its lock stays live.
  if (cooperative.status === "accepted") {
    const released = await waitForOwnershipRelease(record, 15_000);
    if (released.status !== "timeout") {
      if (released.status === "released") externalOwners.delete(sessionId);
      return released;
    }
  }

  const verified = await verifySignalTarget(record);
  if (!verified.ok) return verified;
  const signal = hard ? "SIGKILL" : "SIGTERM";
  try {
    process.kill(record.owner.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") {
      return { status: "error", message: `Could not send ${signal} to pid ${record.owner.pid}: ${error.message}` };
    }
  }

  let released = await waitForOwnershipRelease(record, SIGNAL_EXIT_GRACE_MS);
  if (released.status === "timeout" && !pidAlive(record.owner.pid)) {
    // SIGKILL cannot run session_shutdown. Wait until the abandoned atomic
    // lock reaches its normal stale boundary; the next attach still has to
    // win acquisition rather than deleting or transferring a live lock.
    released = await waitForOwnershipRelease(record, Math.max(0, OWNER_RELEASE_TIMEOUT_MS - SIGNAL_EXIT_GRACE_MS));
  }
  if (released.status === "released") {
    externalOwners.delete(sessionId);
    return released;
  }
  if (!hard && released.status === "timeout" && pidAlive(record.owner.pid)) {
    const confirmationToken = randomUUID();
    record.sigkillAuthorizations ??= new Map();
    record.sigkillAuthorizations.set(confirmationToken, {
      requesterPid: client.pid ?? process.pid,
      requesterProcessStartTime: client.processStartTime,
      expiresAt: Date.now() + 60_000,
    });
    return {
      status: "needs-sigkill",
      message: `Pid ${record.owner.pid} remained alive after SIGTERM. SIGKILL requires a separate confirmation.`,
      confirmationToken,
    };
  }
  return released;
}

function sendHandoffResponse(client, frame, data) {
  sendToClient(client, {
    type: "response",
    command: "request_handoff",
    success: true,
    ...(typeof frame.id === "string" ? { id: frame.id } : {}),
    data,
  });
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
    client.pid = Number.isInteger(frame.pid) && frame.pid > 0 ? frame.pid : undefined;
    client.processStartTime = typeof frame.processStartTime === "number" && Number.isFinite(frame.processStartTime)
      ? frame.processStartTime
      : undefined;
    clients.add(client);
    sendToClient(client, {
      type: "hello_ack",
      protocol: MYPI_DAEMON_PROTOCOL,
      pid: process.pid,
      daemonVersion: process.env.MYPI_RUNTIME_DISPLAY_VERSION ?? null,
    });
    void globalConfigResult.then((loaded) => {
      if (loaded.diagnostic) {
        sendToClient(client, {
          type: "configuration_warning",
          code: loaded.diagnostic.code,
          message: loaded.diagnostic.message,
          path: loaded.diagnostic.path,
        });
      }
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

  if (frame?.type === "list_persisted_sessions") {
    sendDaemonResponse(client, frame, "list_persisted_sessions", listPersistedSessions({
      agentDir: daemonAgentDir,
      ...(typeof frame.cwd === "string" ? { cwd: frame.cwd } : {}),
      includeArchived: frame.includeArchived === true,
      ...(Number.isInteger(frame.offset) ? { offset: frame.offset } : {}),
      ...(Number.isInteger(frame.limit) ? { limit: frame.limit } : {}),
    }));
    return;
  }

  if (frame?.type === "read_session") {
    sendDaemonResponse(client, frame, "read_session", readPersistedSession({
      agentDir: daemonAgentDir,
      ...(typeof frame.sessionFile === "string" ? { sessionFile: frame.sessionFile } : {}),
      ...(typeof frame.sessionId === "string" ? { id: frame.sessionId } : typeof frame.session === "string" ? { id: frame.session } : {}),
      ...(typeof frame.since === "string" ? { since: frame.since } : {}),
      ...(Number.isInteger(frame.limit) ? { limit: frame.limit } : {}),
      ...(Number.isInteger(frame.maxBytes) ? { maxBytes: frame.maxBytes } : {}),
      includeArchived: frame.includeArchived !== false,
    }));
    return;
  }

  if (frame?.type === "get_available_models" && typeof frame.sessionId !== "string") {
    const cwd = typeof frame.cwd === "string" ? frame.cwd : process.cwd();
    sendDaemonResponse(client, frame, "get_available_models", getDaemonAvailableModels(cwd, daemonAgentDir).then((models) => ({ models })));
    return;
  }

  if (frame?.type === "list_skills") {
    const cwd = typeof frame.cwd === "string" ? frame.cwd : process.cwd();
    sendDaemonResponse(client, frame, "list_skills", listDaemonSkills(cwd, daemonAgentDir).then((skills) => ({ skills })));
    return;
  }

  if (frame?.type === "list_extensions") {
    const cwd = typeof frame.cwd === "string" ? frame.cwd : process.cwd();
    sendDaemonResponse(client, frame, "list_extensions", listDaemonExtensions(cwd, daemonAgentDir).then((extensions) => ({ extensions })));
    return;
  }

  if (frame?.type === "get_session_stats" && (!frame.sessionId || !sessions.has(String(frame.sessionId)))) {
    sendDaemonResponse(client, frame, "get_session_stats", getPersistedSessionStats({
      agentDir: daemonAgentDir,
      ...(typeof frame.sessionId === "string" ? { id: frame.sessionId } : {}),
      ...(typeof frame.sessionFile === "string" ? { sessionFile: frame.sessionFile } : {}),
      includeArchived: frame.includeArchived !== false,
    }));
    return;
  }

  if (frame?.type === "daemon_status") {
    sendToClient(client, {
      type: "daemon_status",
      pid: process.pid,
      protocol: MYPI_DAEMON_PROTOCOL,
      runtimeVersion: process.env.MYPI_RUNTIME_DISPLAY_VERSION ?? null,
      startedAt: daemonStartedAt,
      draining,
      sessions: sessions.size,
      activeTurns: activeTurnCount(),
    });
    return;
  }

  if (frame?.type === "restart") {
    beginDrain(client, frame.force === true);
    return;
  }

  if (frame?.type === "request_handoff") {
    void negotiateExternalOwnership(client, frame).then(
      (result) => sendHandoffResponse(client, frame, result),
      (error) => sendHandoffResponse(client, frame, {
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return;
  }

  if (frame?.type === "prepare_surface_session") {
    const sourceSessionId = String(frame.sourceSessionId ?? "");
    const source = sessions.get(sourceSessionId);
    const refuse = (message) => sendToClient(client, {
      type: "error",
      sessionId: sourceSessionId,
      ...(typeof frame.id === "string" ? { id: frame.id } : {}),
      error: message,
    });
    if (draining) {
      refuse("The MyPi session daemon is restarting; retry target preparation in a moment.");
      return;
    }
    if (!source || !source.clients.has(client)) {
      refuse(`No attached source session "${sourceSessionId}" is available for target preparation.`);
      return;
    }
    if (source.turnActive) {
      refuse("Wait for the source session's active turn to settle before creating or deriving another session.");
      return;
    }
    if (source.preparingSurfaceTarget) {
      refuse("Another surface target is already being prepared from this session; retry when it finishes.");
      return;
    }

    let engineFrame;
    if (frame.operation === "new") {
      engineFrame = {
        type: "prepare_new_session",
        materialize: true,
        ...(typeof frame.parentSession === "string" ? { parentSession: frame.parentSession } : {}),
      };
    } else if (
      frame.operation === "fork" &&
      typeof frame.entryId === "string" &&
      (frame.position === undefined || frame.position === "before" || frame.position === "at")
    ) {
      engineFrame = {
        type: "prepare_fork",
        materialize: true,
        entryId: frame.entryId,
        ...(frame.position ? { position: frame.position } : {}),
      };
    } else {
      refuse("Invalid surface-session preparation request.");
      return;
    }

    source.preparingSurfaceTarget = true;
    source.counter += 1;
    const routedId = `__dc_${source.counter}`;
    source.pending.set(routedId, {
      client,
      originalId: typeof frame.id === "string" ? frame.id : undefined,
      commandType: engineFrame.type,
      responseCommand: "prepare_surface_session",
      surfacePreparation: true,
    });
    sendToEngine(source, { ...engineFrame, id: routedId });
    return;
  }

  if (frame?.type === "attach") {
    if (draining) {
      // Refuse new work so the drain can complete; the caller retries once a
      // fresh daemon has taken over the socket.
      sendToClient(client, {
        type: "daemon_draining",
        reason: "The MyPi session daemon is restarting; retry in a moment.",
      });
      return;
    }
    const sessionId = String(frame.sessionId ?? "");
    // No sessionId creates a fresh engine session; the daemon re-keys it and
    // broadcasts `attached` once the child reports its native id.
    let session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session) {
      session = startSession({
        sessionId,
        cwd: frame.cwd,
        model: frame.model,
        sessionStart: normalizeSessionStart(frame.sessionStart),
      });
    }
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
    if (IDENTITY_CHANGING_COMMANDS.has(frame.type) && session.clients.size > 1) {
      sendToClient(client, {
        type: "error",
        code: "shared_session_identity_change_refused",
        sessionId,
        ...(typeof frame.id === "string" ? { id: frame.id } : {}),
        error:
          `Cannot run ${frame.type} by replacing a child shared by ${session.clients.size} clients. ` +
          "Use a surface-local new, fork, clone, or resume operation so only the requester moves.",
      });
      return;
    }
    if (frame.type === "prompt" || frame.type === "steer" || frame.type === "follow_up") session.turnActive = true;
    session.counter += 1;
    const routedId = `__dc_${session.counter}`;
    session.pending.set(routedId, {
      client,
      originalId: typeof frame.id === "string" ? frame.id : undefined,
      commandType: frame.type,
      structuredOutput: frame.type === "prompt" && frame.structuredOutput !== undefined,
    });
    const { sessionId: _ignored, ...engineFrame } = frame;
    sendToEngine(session, { ...engineFrame, id: routedId });
  }
}

function acceptConnection(socket) {
  const client = {
    socket,
    helloDone: false,
    sessions: new Set(),
    name: "unknown",
    pid: undefined,
    processStartTime: undefined,
  };
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
