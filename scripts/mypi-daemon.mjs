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
//     {type:"set_default_model", provider, modelId}   no engine required
//     {type:"list_skills"|"list_extensions"|"list_commands", cwd?}
//                                                       no engine required
//     {type:"get_session_stats", sessionId|sessionFile} no engine required
//     {type:"get_project_tracking"|"estimate_project_tracking", cwd}
//     {type:"set_project_tracking", cwd, tracking:"track"|"dont-track"|null}
//     {type:"rebuild_project_tracker", cwd, confirm:true}
//     {type:"get_session_changes", sessionId|sessionFile}
//     {type:"get_change_set", sessionId, changeSetId}
//     {type:"list_checkpoints", sessionId}
//     {type:"prepare_rewind", sessionId, checkpointId}
//     {type:"force_prepare_rewind", sessionId, forceToken, confirm:true}
//     {type:"execute_rewind", sessionId, operationToken, confirm:true, confirmAffected?}
//     {type:"prepare_project_removal", cwd, historyMode:"archive"|"delete"}
//     {type:"execute_project_removal", operationToken, confirm:true}
//     {type:"daemon_status"}                           version/pid/turn counts
//     {type:"restart", force?}                         graceful drain + exit
//     {type:"attach", sessionId?, cwd?, model?, sessionStart?}
//                                                       subscribe (spawns child)
//       Omitting sessionId creates a fresh engine session; the daemon keys
//       it under the native session id once the child reports it, and the
//       `attached` frame carries that id for the client to adopt.
//     {type:"detach", sessionId}
//       `attach` also accepts profile:"chat" — create/resume a MyPi Chat
//       engine (sealed chat tools, chat-sessions root); persisted listings
//       carry `profile` so clients know which attach shape to use.
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
//     {type:"tracking_status"|"tracking_warning", ...}
//     {type:"turn_changes_finalized", sessionId, changes}
//     {type:"workspace_rewound"|"project_removed", ...}
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
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { hostname } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  MYPI_DAEMON_PROTOCOL,
  acquireStartupLock,
  daemonDir,
  daemonSidecarPath,
  daemonSocketPath,
  readLiveDaemon,
} from "./mypi-daemon-discovery.mjs";
import {
  clearDaemonServiceCache,
  estimateWorkspaceTracking,
  estimatePersistedSessionChanges,
  estimatedChangeSet,
  executeProjectRemoval,
  getDaemonAvailableModels,
  getDaemonModelCatalog,
  getAgentDir,
  getPersistedSessionStats,
  isEstimatedFileMutationTool,
  listDaemonCommands,
  listDaemonExtensions,
  listDaemonSkills,
	listMcpServerSettings,
  listPersistedSessions,
  loadGlobalConfig,
	migrateGuiConfig,
  previewProjectRemoval,
  ProjectTrustStore,
  resolveProjectTrustRoot,
  prepareChatEngineLaunch,
	probeMcpWizardTarget,
	removeMcpWizardServer,
  readGlobalDefaultSafetyMode,
  readPersistedSession,
	readDaemonResourceFile,
	resetGlobalConfig,
	removeWorkspaceTracker,
  runNewSessionMaintenance,
  cleanupArchivedSessions,
  compactPersistedSession,
  previewArchiveCleanup,
  setPersistedSessionArchived,
	saveMcpWizardServer,
	setMcpWizardServerEnabled,
	testMcpWizardServer,
  updateDefaultModel,
	updateGlobalConfigField,
	updateGlobalDefaultSafetyMode,
	sanitizeGlobalConfig,
  WorkspaceTracker,
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
const preparedFreshSessionIds = new Set();
const rewindPreviews = new Map();
const rewindForcePreviews = new Map();
const projectRemovalPreviews = new Map();
const liveChangeSets = new Map();
const projectMaintenanceRoots = new Set();
const daemonAgentDir = getAgentDir();
const daemonGlobalConfigPath = resolve(daemonAgentDir, "config.yaml");
/** Sanitized config.yaml plus daemon-composed settings.json extras (additive
 *  `safety` section; newly created sessions capture safety.defaultMode). */
function composeSanitizedGlobalConfig(config) {
  let defaultMode = "full";
  try {
    defaultMode = readGlobalDefaultSafetyMode(daemonAgentDir);
  } catch {
    // Unreadable settings.json must not break config service replies.
  }
  return { ...sanitizeGlobalConfig(config), safety: { defaultMode } };
}

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

function publicTrackerError(error, fallback) {
  const message = error instanceof Error ? error.message : String(error);
  if (/^(?:Checkpoint is unavailable|Tracker changed after preview|Transcript truncation was cancelled|Forked session identity was unavailable|Invalid entry ID for forking|Engine (?:fork|get_state) (?:timed out|is unavailable))/u.test(message)) return message;
  return fallback;
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
    protocol: 2,
    sessionId: record.sessionId,
    sessionFile: record.sessionFile,
    owner: {
      pid: Number.isInteger(owner.pid) ? owner.pid : 0,
      hostname: typeof owner.hostname === "string" ? owner.hostname : "unknown",
      startedAt: typeof owner.startedAt === "string" ? owner.startedAt : "unknown",
      surface: typeof owner.surface === "string" ? owner.surface : "unknown",
      ownerId: typeof owner.ownerId === "string" ? owner.ownerId : null,
      processStartTime: typeof owner.processStartTime === "number" ? owner.processStartTime : null,
      cooperativeHandoffAvailable: owner.control?.protocol === 2,
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
    value?.protocol !== 2 ||
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
    return [
      ...base,
      ...(session.launchArgs ?? []),
      ...(session.sessionArg ? ["--session", session.sessionArg] : session.sessionId ? ["--session", session.sessionId] : []),
      ...(session.model ? ["--model", session.model] : []),
    ];
  }
  return [
    process.execPath,
    process.argv[1],
    "--mode",
    "rpc",
    ...(session.launchArgs ?? []),
    ...(session.sessionArg ? ["--session", session.sessionArg] : session.sessionId ? ["--session", session.sessionId] : []),
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

function startSession({ sessionId, cwd, model, sessionStart, profile, launchArgs, launchEnv, sessionArg }) {
  // (joined by joinSessionAsClient below)
  const session = {
    sessionId: sessionId || null,
    // Fresh sessions have no id until the engine reports one; they are keyed
    // under a private placeholder and re-keyed on the first state report.
    key: sessionId || `__new_${(newSessionCounter += 1)}`,
    cwd: cwd || process.cwd(),
    model: model || null,
    profile: profile === "chat" ? "chat" : "coding",
    launchArgs: launchArgs ?? null,
    launchEnv: launchEnv ?? null,
    sessionArg: sessionArg ?? null,
    sessionFile: null,
    child: null,
    clients: new Set(),
    clientDraftIds: new Map(),
    pending: new Map(),
    structuredCorrelations: new Map(),
    abandonedEngineRequestIds: new Set(),
    outstandingUi: new Map(),
    turnActive: false,
    compacting: false,
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
    trackingRoot: null,
    trackingRun: null,
    trackingCapturePromise: null,
    trackingEstimates: new Map(),
    trackingToolCalls: new Map(),
    trackingOmissions: [],
    trackingIntersection: new Set(),
    trackingWarningSent: false,
    trackingCaptureRaced: false,
    trackingPendingPrompt: null,
  };
  const [executable, ...args] = engineCommand(session);
  session.child = spawn(executable, args, {
    cwd: session.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      ...(session.launchEnv ?? {}),
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
    rejectInternalEngineRequests(session, `Engine exited before completing an internal request (code ${code ?? "null"}, signal ${signal ?? "null"}).`);
    broadcast(session, {
      type: "session_exit",
      sessionId: session.sessionId ?? session.key,
      code,
      signal,
      lastErrorNotify: session.lastErrorNotify,
    });
    for (const client of session.clients) client.sessions.delete(session.key);
    sessions.delete(session.key);
    void pruneDetachedTracking(session);
  });
  session.child.on("error", () => {
    session.exited = true;
    rejectInternalEngineRequests(session, "Engine failed before completing an internal request.");
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
  if (session.exited || !session.child.stdin.writable) return false;
  session.child.stdin.write(`${JSON.stringify(frame)}\n`);
  return true;
}

function requestEngineInternal(session, command, timeoutMs = 15_000) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (session.exited || !session.child.stdin.writable) {
      rejectPromise(new Error(`Engine ${command.type} is unavailable.`));
      return;
    }
    const id = `__daemon_internal_${++session.counter}`;
    const timer = setTimeout(() => {
      session.pending.delete(id);
      rejectPromise(new Error(`Engine ${command.type} timed out.`));
    }, timeoutMs);
    timer.unref?.();
    session.pending.set(id, {
      internal: true,
      commandType: command.type,
      resolve: (frame) => { clearTimeout(timer); resolvePromise(frame); },
      reject: (error) => { clearTimeout(timer); rejectPromise(error); },
    });
    if (!sendToEngine(session, { ...command, id })) {
      session.pending.delete(id);
      clearTimeout(timer);
      rejectPromise(new Error(`Engine ${command.type} is unavailable.`));
    }
  });
}

function rejectInternalEngineRequests(session, reason) {
  for (const [id, pending] of session.pending) {
    if (!pending.internal) continue;
    session.pending.delete(id);
    pending.reject(new Error(reason));
  }
}

/** Shared attach bookkeeping: membership, grace-timer cancel, and the
 *  attached/outstanding-UI replay for already-ready engines. */
function joinSessionAsClient(client, session, clientDraftId) {
  if (session.graceTimer) {
    clearTimeout(session.graceTimer);
    session.graceTimer = null;
  }
  session.clients.add(client);
  client.sessions.add(session.key);
  if (typeof clientDraftId === "string" && clientDraftId.startsWith("new:")) {
    session.clientDraftIds.set(client, clientDraftId);
  }
  if (session.ready) {
    sendToClient(client, {
      type: "attached",
      sessionId: session.sessionId ?? session.key,
      nativeSessionId: session.nativeSessionId ?? null,
      sessionFile: session.sessionFile,
      cwd: session.cwd,
      clients: session.clients.size,
      profile: session.profile ?? "coding",
      ...(session.clientDraftIds.get(client) ? { clientDraftId: session.clientDraftIds.get(client) } : {}),
    });
    session.clientDraftIds.delete(client);
    for (const pendingFrame of session.outstandingUi.values()) {
      sendToClient(client, pendingFrame);
    }
  }
}

function canonicalTrackingRoot(cwd) {
  try { return resolveProjectTrustRoot(cwd); }
  catch { return resolve(cwd); }
}

function sessionsWorkingInRoot(root, except) {
  return [...sessions.values()].filter((candidate) =>
    candidate !== except && !candidate.exited && candidate.turnActive && canonicalTrackingRoot(candidate.cwd) === root,
  );
}

function describeRewindBlockers(root) {
  return [...sessions.values()]
    .filter((candidate) => !candidate.exited && candidate.turnActive && canonicalTrackingRoot(candidate.cwd) === root)
    .map((candidate) => ({
      kind: "daemon-session",
      sessionId: candidate.sessionId ?? candidate.key,
      reason: candidate.compacting ? "A task is compacting its context." : "A task is currently working in this workspace.",
      surfaces: [...new Set([...candidate.clients].map((attached) => attached.name).filter(Boolean))],
      ...(Number.isInteger(candidate.child?.pid) ? { pid: candidate.child.pid } : {}),
      canStop: true,
      canTakeOver: false,
    }));
}

async function waitForRewindIdle(root, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (describeRewindBlockers(root).length > 0) {
    if (Date.now() >= deadline) throw new Error("A task did not settle after the stop request.");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
}

async function stopRewindBlockers(root) {
  const blockers = [...sessions.values()].filter(
    (candidate) => !candidate.exited && candidate.turnActive && canonicalTrackingRoot(candidate.cwd) === root,
  );
  await Promise.all(blockers.map(async (candidate) => {
    try {
      await requestEngineInternal(candidate, { type: "abort" }, 30_000);
    } catch (error) {
      throw new Error(`Could not stop session ${candidate.sessionId ?? candidate.key}: ${boundedError(error)}`);
    }
  }));
  await waitForRewindIdle(root);
}

function textFromUserMessage(message) {
  if (!Array.isArray(message?.content)) return typeof message?.content === "string" ? message.content : "";
  return message.content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n");
}

function queuedMode(message) {
  if (!Array.isArray(message?.content)) return null;
  for (const part of message.content) {
    if (part?.mypiQueuedMessageMode === "steer" || part?.mypiQueuedMessageMode === "followUp") return part.mypiQueuedMessageMode;
  }
  return null;
}

function queuedId(message) {
  if (!Array.isArray(message?.content)) return null;
  for (const part of message.content) if (typeof part?.mypiQueuedMessageId === "string") return part.mypiQueuedMessageId;
  return null;
}

function latestPersistedUserEntry(sessionFile, startedAt) {
  let fd;
  try {
    const size = statSync(sessionFile).size;
    const length = Math.min(size, 8 * 1024 * 1024);
    const buffer = Buffer.allocUnsafe(length);
    fd = openSync(sessionFile, "r");
    const bytes = readSync(fd, buffer, 0, length, Math.max(0, size - length));
    let text = buffer.subarray(0, bytes).toString("utf8");
    if (length < size) text = text.slice(text.indexOf("\n") + 1);
    const lines = text.split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (!lines[index]?.trim()) continue;
      let entry;
      try { entry = JSON.parse(lines[index]); } catch { continue; }
      if (entry?.type !== "message" || entry.message?.role !== "user" || typeof entry.id !== "string") continue;
      if (queuedMode(entry.message) === "steer") continue;
      const timestamp = typeof entry.message.timestamp === "number" ? entry.message.timestamp : Date.parse(String(entry.timestamp ?? ""));
      if (Number.isFinite(timestamp) && timestamp < startedAt - 1_000) continue;
      return entry;
    }
  } catch {}
  finally { if (fd !== undefined) try { closeSync(fd); } catch {} }
  return undefined;
}

function isFirstPersistedUserEntry(sessionFile, userMessageId) {
  let fd;
  try {
    const size = statSync(sessionFile).size;
    const length = Math.min(size, 8 * 1024 * 1024);
    const buffer = Buffer.allocUnsafe(length);
    fd = openSync(sessionFile, "r");
    const bytes = readSync(fd, buffer, 0, length, 0);
    const lines = buffer.subarray(0, bytes).toString("utf8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry?.type !== "message" || entry.message?.role !== "user" || typeof entry.id !== "string") continue;
      if (queuedMode(entry.message) === "steer") continue;
      return entry.id === userMessageId;
    }
  } catch {}
  finally { if (fd !== undefined) try { closeSync(fd); } catch {} }
  return false;
}

async function trackingContext(session) {
  const context = await trackingContextForRoot(session.cwd);
  const root = context.root;
  session.trackingRoot = root;
  return context;
}

async function trackingContextForRoot(cwd) {
  const root = canonicalTrackingRoot(cwd);
  const loaded = await loadGlobalConfig(daemonGlobalConfigPath);
  const store = new ProjectTrustStore(daemonAgentDir);
  let decision = null;
  try { decision = store.getTracking(root); } catch {}
  const tracker = await WorkspaceTracker.open(daemonAgentDir, root, loaded.config.tracking);
  return { root, loaded, decision, tracker, health: await tracker.health(decision), storageHealth: await tracker.storageHealth() };
}

function markTrackingIntersection(session, root) {
  const overlapping = sessionsWorkingInRoot(root, session);
  for (const other of overlapping) {
    session.trackingIntersection.add(other.sessionId ?? other.key);
    other.trackingIntersection.add(session.sessionId ?? session.key);
  }
  return overlapping;
}

function publishTrackingWarning(session, status, message) {
  if (session.trackingWarningSent) return;
  session.trackingWarningSent = true;
  broadcast(session, {
    type: "tracking_warning",
    sessionId: session.sessionId ?? session.key,
    cwd: session.trackingRoot ?? canonicalTrackingRoot(session.cwd),
    status,
    message,
  });
}

async function finalizeTrackingRun(session, skipCaptureWait = false) {
  if (!skipCaptureWait) {
    await session.trackingCapturePromise?.catch(() => undefined);
    session.trackingCapturePromise = null;
  }
  const run = session.trackingRun;
  if (!run) return null;
  if (run.tracker && run.checkpointId && session.sessionFile) {
    try {
      const entry = latestPersistedUserEntry(session.sessionFile, run.startedAt);
      if (entry?.id) await run.tracker.bindCheckpointToUserMessage(session.sessionId ?? session.key, run.checkpointId, entry.id, run.promptPreview);
    } catch {}
  }
  let changeSet;
  if (run.tracker && run.checkpointId) {
    try {
      changeSet = await run.tracker.finalizeChangeSet({
        sessionId: session.sessionId ?? session.key,
        checkpointId: run.checkpointId,
        intersection: session.trackingIntersection.size ? "concurrent-session" : "none",
        affectedTaskCount: session.trackingIntersection.size,
        ...(session.trackingCaptureRaced ? { partialReason: "A file tool began before the checkpoint capture completed." } : {}),
      });
    } catch (error) {
      session.trackingOmissions.push("Tracker finalization failed; estimates were used.");
      publishTrackingWarning(session, "corrupt", "The project tracker is unavailable. File changes are estimated until it is rebuilt or disabled.");
    }
  }
  if (!changeSet) {
    changeSet = estimatedChangeSet({
      sessionId: session.sessionId ?? session.key,
      trackerStatus: run.health,
      files: [...session.trackingEstimates.values()],
      intersection: session.trackingIntersection.size ? "concurrent-session" : "none",
      affectedTaskCount: session.trackingIntersection.size,
      omissions: session.trackingOmissions,
    });
  }
  liveChangeSets.set(changeSet.id, { root: run.root, changeSet });
  if (liveChangeSets.size > 2_000) liveChangeSets.delete(liveChangeSets.keys().next().value);
  session.lastChangeSet = changeSet;
  broadcast(session, { type: "turn_changes_finalized", sessionId: session.sessionId ?? session.key, changes: changeSet });
  session.trackingRun = null;
  session.trackingEstimates = new Map();
  session.trackingToolCalls = new Map();
  session.trackingOmissions = [];
  session.trackingIntersection = new Set();
  session.trackingCaptureRaced = false;
  return changeSet;
}

function beginTrackingUserMessage(session, message) {
  if (session.profile === "chat" || queuedMode(message) === "steer") return;
  const previousCapture = session.trackingCapturePromise;
  session.trackingCapturePromise = (async () => {
    await previousCapture?.catch(() => undefined);
    if (session.trackingRun) await finalizeTrackingRun(session, true);
    const context = await trackingContext(session);
    const overlapping = markTrackingIntersection(session, context.root);
    const pendingPrompt = queuedMode(message) === "followUp" ? null : session.trackingPendingPrompt;
    session.trackingPendingPrompt = null;
    const run = {
      root: context.root,
      health: context.health,
      tracker: null,
      checkpointId: null,
	  startedAt: typeof message?.timestamp === "number" ? message.timestamp : Date.now(),
	  promptPreview: pendingPrompt?.text ?? textFromUserMessage(message),
    };
    if (context.decision === "track" && context.health !== "corrupt") {
      try {
        const checkpoint = await context.tracker.createCheckpoint({
          sessionId: session.sessionId ?? session.key,
		  userMessageId: queuedId(message) ?? pendingPrompt?.id ?? `message-${message?.timestamp ?? Date.now()}-${randomUUID()}`,
		  promptPreview: pendingPrompt?.text ?? textFromUserMessage(message),
          intersection: overlapping.length ? "concurrent-session" : "none",
          affectedTaskCount: overlapping.length,
        });
        run.tracker = context.tracker;
        run.checkpointId = checkpoint.id;
        run.health = "ready";
      } catch (error) {
        run.health = "corrupt";
        session.trackingOmissions.push("Checkpoint capture failed; estimates were used.");
        publishTrackingWarning(session, "corrupt", "The project tracker is unavailable. File changes are estimated until it is rebuilt or disabled.");
      }
    }
    session.trackingRun = run;
  })();
}

function normalizeTrackedToolPath(session, value) {
  if (typeof value !== "string" || !value) return null;
  const root = session.trackingRoot ?? canonicalTrackingRoot(session.cwd);
  const absolute = resolve(session.cwd, value);
  const rel = relative(root, absolute);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

function patchCounts(patch) {
  let additions = 0;
  let deletions = 0;
  for (const line of String(patch ?? "").split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions };
}

function recordToolTracking(session, frame) {
  if (frame?.type === "tool_execution_start" && typeof frame.toolCallId === "string") {
    if (!isEstimatedFileMutationTool(String(frame.toolName ?? ""))) return;
    if (session.trackingCapturePromise && !session.trackingRun) session.trackingCaptureRaced = true;
    session.trackingToolCalls.set(frame.toolCallId, { name: frame.toolName, args: frame.args });
    return;
  }
  if (frame?.type !== "tool_execution_end" || frame.isError || typeof frame.toolCallId !== "string") return;
  const call = session.trackingToolCalls.get(frame.toolCallId);
  if (!call) return;
  session.trackingToolCalls.delete(frame.toolCallId);
  const args = call.args && typeof call.args === "object" ? call.args : {};
  const path = normalizeTrackedToolPath(session, args.path ?? args.file_path ?? args.filePath);
  if (!path) return;
  const previous = session.trackingEstimates.get(path);
  const result = frame.result && typeof frame.result === "object" ? frame.result : {};
  const patch = typeof result.details?.patch === "string" ? result.details.patch : undefined;
  const counts = patch ? patchCounts(patch) : typeof args.content === "string"
    ? { additions: args.content ? args.content.split("\n").length - (args.content.endsWith("\n") ? 1 : 0) : 0, deletions: 0 }
    : { additions: 0, deletions: 0 };
  const boundedPatch = patch && Buffer.byteLength(patch) <= 400_000 ? patch : undefined;
  session.trackingEstimates.set(path, {
    path,
    status: previous?.status ?? "modified",
    additions: (previous?.additions ?? 0) + counts.additions,
    deletions: (previous?.deletions ?? 0) + counts.deletions,
    opaque: false,
    ...(boundedPatch ? { patch: boundedPatch } : {}),
    diffAvailable: Boolean(boundedPatch),
  });
}

async function pruneDetachedTracking(session) {
  if (shuttingDown || session.clients.size > 0 || !session.trackingRoot || !session.sessionId) return;
  try {
    const context = await trackingContext(session);
    if (context.storageHealth === "ready") await context.tracker.pruneDetached(session.sessionId);
  } catch {}
}

function handleEngineFrame(session, line) {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    broadcast(session, { type: "session_raw", sessionId: session.sessionId ?? session.key, line });
    return;
  }

  recordToolTracking(session, frame);
  if (frame?.type === "message_start" && frame.message?.role === "user") beginTrackingUserMessage(session, frame.message);

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
        for (const attachedClient of session.clients) {
          sendToClient(attachedClient, {
            type: "attached",
            sessionId: session.sessionId ?? session.key,
            nativeSessionId: session.nativeSessionId,
            sessionFile: session.sessionFile,
            cwd: session.cwd,
            clients: session.clients.size,
            profile: session.profile ?? "coding",
            ...(session.clientDraftIds.get(attachedClient) ? { clientDraftId: session.clientDraftIds.get(attachedClient) } : {}),
          });
          session.clientDraftIds.delete(attachedClient);
        }
        if (session.profile !== "chat") {
          void trackingContext(session).then((context) => {
            broadcast(session, {
              type: "tracking_status",
              sessionId: session.sessionId ?? session.key,
              cwd: context.root,
              status: context.health,
              tracking: context.decision,
            });
            if (context.health === "corrupt") publishTrackingWarning(session, "corrupt", "The project tracker is unavailable. File changes are estimated until it is rebuilt or disabled.");
          }).catch(() => publishTrackingWarning(session, "corrupt", "The project tracker could not be inspected. File changes are estimated."));
        }
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
    if (frame.id === "__daemon_release_abort" || frame.id === "__daemon_subagent_detached") return;
    if (session.abandonedEngineRequestIds.delete(frame.id)) return;
    const pending = session.pending.get(frame.id);
    if (pending) {
      session.pending.delete(frame.id);
	  if (pending.internal) {
		if (frame.success) pending.resolve(frame);
		else pending.reject(new Error(frame.error || `Engine ${pending.commandType} failed.`));
		if (frame.success && IDENTITY_CHANGING_COMMANDS.has(pending.commandType)) {
		  sendToEngine(session, { id: "__daemon_state", type: "get_state" });
		}
		return;
	  }
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
      if (
        frame.success &&
        pending.preparedOperation === "new" &&
        typeof frame.data?.target?.sessionId === "string"
      ) preparedFreshSessionIds.add(frame.data.target.sessionId);
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
  if (frame?.type === "compaction_start") session.compacting = true;
  if (frame?.type === "compaction_end") session.compacting = false;
  if (frame?.type === "agent_settled") {
	if (frame.continuationPending === true) {
	  session.turnActive = true;
	  broadcast(session, { ...frame, sessionId: session.sessionId ?? session.key });
	  return;
	}
    session.turnActive = false;
    void finalizeTrackingRun(session).then((changes) => {
      broadcast(session, { ...frame, sessionId: session.sessionId ?? session.key, ...(changes ? { changes } : {}) });
    }).catch((error) => {
      broadcast(session, { ...frame, sessionId: session.sessionId ?? session.key, trackingError: boundedError(error) });
    }).finally(() => {
      session.structuredCorrelations.clear();
      clearDaemonServiceCache();
      persistedChanged(session, "updated");
      // A drain in progress exits as soon as the last turn settles.
      if (draining) maybeFinishDrain();
      if (session.pendingRelease) completeRelease(session);
      else if (session.clients.size === 0) scheduleSessionGrace(session);
    });
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

async function closeIdleSessionForArchive(session, requestingClient) {
  if (session.turnActive) throw new Error("Session archive is blocked while the session is working.");
  const otherClients = [...session.clients].filter((attached) => attached !== requestingClient);
  if (otherClients.length > 0) throw new Error("Session archive is blocked while another client is attached.");
  if (session.clients.has(requestingClient)) detachClientFromSession(requestingClient, session);
  if (session.graceTimer) {
    clearTimeout(session.graceTimer);
    session.graceTimer = null;
  }
  if (session.exited) return;
  await new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error("Session engine did not close before archive.")), 10_000);
    session.child.once("exit", () => {
      clearTimeout(timer);
      resolvePromise();
    });
    closeSession(session);
  });
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
	session.clientDraftIds.delete(client);
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
  if (session.clients.size === 0) {
    sendToEngine(session, { id: "__daemon_subagent_detached", type: "notify_parent_detached" });
    scheduleSessionGrace(session);
  }
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
    control?.protocol !== 2 ||
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
        protocol: 2,
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
    void loadGlobalConfig(daemonGlobalConfigPath).then((loaded) => {
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

  if (frame?.type === "set_project_trust") {
    try {
      const cwd = String(frame.cwd ?? "");
      if (!cwd) throw new Error("set_project_trust requires cwd");
      const trusted = frame.trusted === true ? true : frame.trusted === false ? false : null;
      new ProjectTrustStore(daemonAgentDir).set(cwd, trusted);
      sendDaemonResponse(client, frame, "set_project_trust", { cwd, trusted });
    } catch (error) {
      sendToClient(client, {
        type: "response",
        command: "set_project_trust",
        success: false,
        ...(typeof frame.id === "string" ? { id: frame.id } : {}),
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }
  if (frame?.type === "get_project_tracking" || frame?.type === "estimate_project_tracking") {
    const cwd = String(frame.cwd ?? "");
    sendDaemonResponse(client, frame, frame.type, (async () => {
      if (!cwd) throw new Error(`${frame.type} requires cwd`);
      const root = canonicalTrackingRoot(cwd);
      const loaded = await loadGlobalConfig(daemonGlobalConfigPath);
      const store = new ProjectTrustStore(daemonAgentDir);
      const decision = store.getTracking(root);
      const tracker = await WorkspaceTracker.open(daemonAgentDir, root, loaded.config.tracking);
      const estimate = await estimateWorkspaceTracking(root, loaded.config.tracking);
      return { root, trusted: store.get(root), tracking: decision, status: await tracker.health(decision), estimate };
    })());
    return;
  }
  if (frame?.type === "set_project_tracking") {
    try {
      const cwd = String(frame.cwd ?? "");
      if (!cwd) throw new Error("set_project_tracking requires cwd");
      const root = canonicalTrackingRoot(cwd);
      const tracking = frame.tracking === "track" ? "track" : frame.tracking === "dont-track" ? "dont-track" : null;
      new ProjectTrustStore(daemonAgentDir).setTracking(root, tracking);
      sendDaemonResponse(client, frame, "set_project_tracking", { root, tracking });
    } catch (error) {
      sendToClient(client, { type: "response", command: "set_project_tracking", success: false, ...(typeof frame.id === "string" ? { id: frame.id } : {}), error: boundedError(error) });
    }
    return;
  }
  if (frame?.type === "rebuild_project_tracker") {
    const cwd = String(frame.cwd ?? "");
    sendDaemonResponse(client, frame, "rebuild_project_tracker", (async () => {
      if (!cwd || frame.confirm !== true) throw new Error("rebuild_project_tracker requires cwd and confirm=true");
      const root = canonicalTrackingRoot(cwd);
      if ([...sessions.values()].some((session) => !session.exited && canonicalTrackingRoot(session.cwd) === root && session.turnActive)) throw new Error("Tracker rebuild is blocked while a task is working in this workspace.");
      if (projectMaintenanceRoots.has(root)) throw new Error("Another project maintenance operation is active.");
      projectMaintenanceRoots.add(root);
      try {
        const loaded = await loadGlobalConfig(daemonGlobalConfigPath);
        const tracker = await WorkspaceTracker.open(daemonAgentDir, root, loaded.config.tracking);
        try { await tracker.rebuild(); }
        catch (error) { throw new Error(publicTrackerError(error, "Tracker rebuild failed.")); }
        new ProjectTrustStore(daemonAgentDir).setTracking(root, "track");
        broadcastAll({ type: "tracking_status", cwd: root, status: "ready", tracking: "track" });
        return { root, status: "ready", tracking: "track" };
      } finally { projectMaintenanceRoots.delete(root); }
    })());
    return;
  }

  if (frame?.type === "prepare_project_removal") {
    const cwd = String(frame.cwd ?? "");
    const historyMode = frame.historyMode === "archive" ? "archive" : frame.historyMode === "delete" ? "delete" : null;
    sendDaemonResponse(client, frame, "prepare_project_removal", (async () => {
      if (!cwd || !historyMode) throw new Error("prepare_project_removal requires cwd and historyMode archive|delete");
      const preview = await previewProjectRemoval(cwd, historyMode, daemonAgentDir);
      const live = [...sessions.values()].filter((session) => !session.exited && canonicalTrackingRoot(session.cwd) === preview.project);
      const operationToken = randomUUID();
      projectRemovalPreviews.set(operationToken, { client, preview, expiresAt: Date.now() + 5 * 60_000 });
      return { operationToken, ...preview, liveSessions: live.length, activeSessions: live.filter((session) => session.turnActive).length };
    })());
    return;
  }

  if (frame?.type === "execute_project_removal") {
    const token = typeof frame.operationToken === "string" ? frame.operationToken : "";
    const prepared = projectRemovalPreviews.get(token);
    sendDaemonResponse(client, frame, "execute_project_removal", (async () => {
      if (!prepared || prepared.client !== client || prepared.expiresAt < Date.now()) throw new Error("Project removal preview expired or is invalid.");
      if (frame.confirm !== true) throw new Error("Project removal requires confirm=true after preview.");
      const root = prepared.preview.project;
      if (projectMaintenanceRoots.has(root)) throw new Error("Another project maintenance operation is active.");
      projectMaintenanceRoots.add(root);
      try {
		const matchingLive = [...sessions.values()].filter((session) => !session.exited && canonicalTrackingRoot(session.cwd) === root);
		// The requesting client commonly has idle reader/owner attachments to the
		// project it is deleting. Close those engines through the same safe path
		// as single-session archive; active turns and other attached clients remain
		// hard blockers. Without this, a GUI could never remove its selected idle
		// project because its own attachment kept the lease alive.
		if (matchingLive.some((live) => live.turnActive)) throw new Error("Project removal is blocked while a matching session is working.");
		if (matchingLive.some((live) => [...live.clients].some((attached) => attached !== client))) {
		  throw new Error("Project removal is blocked while another client is attached to this workspace.");
		}
		for (const live of matchingLive) await closeIdleSessionForArchive(live, client);
        const result = await executeProjectRemoval(prepared.preview, { agentDir: daemonAgentDir });
        if (result.failures.length > 0) {
          broadcastAll({ type: "project_removal_partial", project: root, historyMode: prepared.preview.historyMode, ...result });
          return { project: root, historyMode: prepared.preview.historyMode, projectStateRemoved: false, ...result };
        }
		await removeWorkspaceTracker(daemonAgentDir, root);
        new ProjectTrustStore(daemonAgentDir).removeProject(root);
        projectRemovalPreviews.delete(token);
        clearDaemonServiceCache();
        broadcastAll({ type: "project_removed", project: root, historyMode: prepared.preview.historyMode, ...result });
        return { project: root, historyMode: prepared.preview.historyMode, projectStateRemoved: true, ...result };
      } finally { projectMaintenanceRoots.delete(root); }
    })());
    return;
  }
  if (frame?.type === "list_persisted_sessions") {
    sendDaemonResponse(client, frame, "list_persisted_sessions", listPersistedSessions({
      agentDir: daemonAgentDir,
      ...(typeof frame.cwd === "string" ? { cwd: frame.cwd } : {}),
      includeArchived: frame.includeArchived === true,
      ...(frame.profile === "chat" || frame.profile === "coding" ? { profile: frame.profile } : {}),
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

  if (frame?.type === "preview_archive_cleanup") {
    const cwd = typeof frame.cwd === "string" ? frame.cwd : "";
    sendDaemonResponse(client, frame, "preview_archive_cleanup", (async () => {
      if (!cwd) throw new Error("preview_archive_cleanup requires cwd");
      const preview = await previewArchiveCleanup(cwd, daemonAgentDir);
      // Candidates carry absolute paths; clients only need counts + ids.
      return {
        cwd: preview.cwd,
        maxArchived: preview.maxArchived,
        archivedCount: preview.archivedCount,
        excess: preview.excess,
        candidateIds: preview.candidates.map((session) => session.id),
        ...(preview.configDiagnostic ? { configDiagnostic: { code: preview.configDiagnostic.code, message: preview.configDiagnostic.message } } : {}),
      };
    })());
    return true;
  }
  if (frame?.type === "execute_archive_cleanup") {
    const cwd = typeof frame.cwd === "string" ? frame.cwd : "";
    sendDaemonResponse(client, frame, "execute_archive_cleanup", (async () => {
      if (!cwd || frame.confirm !== true) throw new Error("execute_archive_cleanup requires cwd and confirm: true");
      const result = await cleanupArchivedSessions(cwd, { confirm: true, agentDir: daemonAgentDir });
      for (const id of result.deleted) broadcastAll({ type: "persisted_changed", sessionId: id, kind: "removed" });
      return {
        deleted: result.deleted,
        failures: result.failures,
        excess: result.preview.excess,
        maxArchived: result.preview.maxArchived,
      };
    })());
    return true;
  }

  if (frame?.type === "compact_session") {
    const sessionId = typeof frame.sessionId === "string" ? frame.sessionId : "";
    sendDaemonResponse(client, frame, "compact_session", (async () => {
      if (!sessionId || frame.confirm !== true) throw new Error("compact_session requires sessionId and confirm: true");
      const live = [...sessions.values()].find((session) =>
        !session.exited && (session.sessionId === sessionId || session.nativeSessionId === sessionId || session.key === sessionId),
      );
      if (live) throw new Error("Session is live; compaction only runs on idle sessions.");
      const result = await compactPersistedSession(sessionId, daemonAgentDir);
      if (result.compacted) broadcastAll({ type: "persisted_changed", sessionId, kind: "updated" });
      return result;
    })());
    return true;
  }
  if (frame?.type === "set_session_archived") {
    const sessionId = typeof frame.sessionId === "string" ? frame.sessionId : "";
    sendDaemonResponse(client, frame, "set_session_archived", (async () => {
      if (!sessionId || typeof frame.archived !== "boolean") throw new Error("set_session_archived requires sessionId and archived");
      const live = [...sessions.values()].find((session) =>
        !session.exited && (session.sessionId === sessionId || session.nativeSessionId === sessionId || session.key === sessionId),
      );
      if (live) await closeIdleSessionForArchive(live, client);
      const result = await setPersistedSessionArchived(sessionId, frame.archived, daemonAgentDir);
      broadcastAll({ type: "persisted_changed", sessionId, kind: frame.archived ? "archived" : "restored" });
      return result;
    })());
    return;
  }

  if (frame?.type === "get_session_changes") {
    sendDaemonResponse(client, frame, "get_session_changes", (async () => {
      const requestedId = typeof frame.sessionId === "string" ? frame.sessionId : "";
      const live = requestedId ? sessions.get(requestedId) : undefined;
      if (live && live.clients.has(client)) {
        const context = await trackingContext(live);
        const tracked = context.storageHealth === "ready" ? await context.tracker.listChangeSets(requestedId) : [];
        return { sessionId: requestedId, status: context.health, changes: tracked.length ? tracked : [...liveChangeSets.values()].map((item) => item.changeSet).filter((item) => item.sessionId === requestedId) };
      }
      const history = await readPersistedSession({
        agentDir: daemonAgentDir,
        ...(requestedId ? { id: requestedId } : {}),
        ...(typeof frame.sessionFile === "string" ? { sessionFile: frame.sessionFile } : {}),
        includeArchived: frame.includeArchived !== false,
        limit: 5_000,
        maxBytes: 8 * 1024 * 1024,
      });
      const header = history.entries.find((entry) => entry && typeof entry === "object" && entry.type === "session");
      const cwd = typeof header?.cwd === "string" ? header.cwd : "";
      const estimates = estimatePersistedSessionChanges(history.id, history.entries);
      if (!cwd) return { sessionId: history.id, status: "missing", changes: estimates, complete: !history.hasMore };
      const root = canonicalTrackingRoot(cwd);
      const loaded = await loadGlobalConfig(daemonGlobalConfigPath);
      const store = new ProjectTrustStore(daemonAgentDir);
      const decision = store.getTracking(root);
      const tracker = await WorkspaceTracker.open(daemonAgentDir, root, loaded.config.tracking);
      const status = await tracker.health(decision);
      const tracked = await tracker.storageHealth() === "ready" ? await tracker.listChangeSets(history.id) : [];
      const exactUsers = new Set(tracked.map((item) => item.userMessageId).filter(Boolean));
      return { sessionId: history.id, status, changes: [...estimates.filter((item) => !exactUsers.has(item.userMessageId)), ...tracked], complete: !history.hasMore };
    })());
    return;
  }

  if (frame?.type === "get_available_models" && typeof frame.sessionId !== "string") {
    const cwd = typeof frame.cwd === "string" ? frame.cwd : process.cwd();
    sendDaemonResponse(client, frame, "get_available_models", getDaemonModelCatalog(cwd, daemonAgentDir));
    return;
  }

  if (frame?.type === "set_default_model" && typeof frame.sessionId !== "string") {
    const provider = typeof frame.provider === "string" ? frame.provider : "";
    const modelId = typeof frame.modelId === "string" ? frame.modelId : "";
    if (!provider || !modelId) {
      sendToClient(client, { type: "response", command: "set_default_model", success: false, ...(typeof frame.id === "string" ? { id: frame.id } : {}), error: "set_default_model requires provider and modelId" });
      return;
    }
    sendDaemonResponse(client, frame, "set_default_model", updateDefaultModel(`${provider}/${modelId}`, daemonGlobalConfigPath).then((config) => ({ defaultModel: config.defaultModel })));
    return;
  }

  if (frame?.type === "get_global_config") {
    sendDaemonResponse(client, frame, "get_global_config", loadGlobalConfig(daemonGlobalConfigPath).then((loaded) => ({
      config: composeSanitizedGlobalConfig(loaded.config),
      ...(loaded.diagnostic ? { diagnostic: { code: loaded.diagnostic.code, message: loaded.diagnostic.message } } : {}),
    })));
    return;
  }

  if (frame?.type === "update_global_config") {
    const field = typeof frame.field === "string" ? frame.field : "";
    if (field === "safety.defaultMode") {
      // settings.json authority, not config.yaml: newly created sessions on
      // every client capture this default (agent-session safety seeding).
      sendDaemonResponse(client, frame, "update_global_config", Promise.resolve().then(async () => {
        await updateGlobalDefaultSafetyMode(frame.value, daemonAgentDir);
        const loaded = await loadGlobalConfig(daemonGlobalConfigPath);
        return { config: composeSanitizedGlobalConfig(loaded.config) };
      }));
      return;
    }
    sendDaemonResponse(client, frame, "update_global_config", updateGlobalConfigField(field, frame.value, daemonGlobalConfigPath).then((config) => ({
      config: composeSanitizedGlobalConfig(config),
    })));
    return;
  }

  if (frame?.type === "migrate_gui_config") {
    const candidate = frame.gui && typeof frame.gui === "object" && !Array.isArray(frame.gui) ? frame.gui : {};
    sendDaemonResponse(client, frame, "migrate_gui_config", migrateGuiConfig(candidate, daemonGlobalConfigPath).then((config) => ({
      config: composeSanitizedGlobalConfig(config),
    })));
    return;
  }

  if (frame?.type === "repair_global_config") {
    if (frame.confirm !== true) {
      sendToClient(client, { type: "response", command: "repair_global_config", success: false, ...(typeof frame.id === "string" ? { id: frame.id } : {}), error: "Configuration repair requires in-app confirmation." });
      return;
    }
    sendDaemonResponse(client, frame, "repair_global_config", resetGlobalConfig(daemonGlobalConfigPath).then((config) => ({ config: composeSanitizedGlobalConfig(config) })));
    return;
  }

  if (frame?.type === "list_mcp_servers") {
    sendDaemonResponse(client, frame, "list_mcp_servers", listMcpServerSettings(daemonGlobalConfigPath));
    return;
  }
  if (frame?.type === "probe_mcp_target") {
    sendDaemonResponse(client, frame, "probe_mcp_target", probeMcpWizardTarget(String(frame.target ?? "")));
    return;
  }
  if (frame?.type === "save_mcp_server") {
    sendDaemonResponse(client, frame, "save_mcp_server", saveMcpWizardServer(frame.server ?? {}, daemonGlobalConfigPath));
    return;
  }
  if (frame?.type === "set_mcp_server_enabled") {
    sendDaemonResponse(client, frame, "set_mcp_server_enabled", setMcpWizardServerEnabled(String(frame.serverId ?? ""), frame.enabled === true, daemonGlobalConfigPath));
    return;
  }
  if (frame?.type === "remove_mcp_server") {
    if (frame.confirm !== true) {
      sendToClient(client, { type: "response", command: "remove_mcp_server", success: false, ...(typeof frame.id === "string" ? { id: frame.id } : {}), error: "MCP removal requires in-app confirmation." });
      return;
    }
    sendDaemonResponse(client, frame, "remove_mcp_server", removeMcpWizardServer(String(frame.serverId ?? ""), daemonGlobalConfigPath));
    return;
  }
  if (frame?.type === "test_mcp_server") {
    sendDaemonResponse(client, frame, "test_mcp_server", testMcpWizardServer(String(frame.serverId ?? ""), { path: daemonGlobalConfigPath, workspaceCwd: typeof frame.cwd === "string" ? frame.cwd : process.cwd(), agentDir: daemonAgentDir }));
    return;
  }

  if (frame?.type === "read_resource_file") {
    const cwd = typeof frame.cwd === "string" ? frame.cwd : process.cwd();
    sendDaemonResponse(client, frame, "read_resource_file", readDaemonResourceFile(cwd, String(frame.path ?? ""), daemonAgentDir));
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

  if (frame?.type === "list_commands") {
    const cwd = typeof frame.cwd === "string" ? frame.cwd : process.cwd();
    sendDaemonResponse(client, frame, "list_commands", listDaemonCommands(cwd, daemonAgentDir).then((commands) => ({ commands })));
    return;
  }

  const statsLiveSession = frame?.type === "get_session_stats" && typeof frame.sessionId === "string"
    ? sessions.get(String(frame.sessionId))
    : undefined;
  if (frame?.type === "get_session_stats" && (!statsLiveSession || !statsLiveSession.clients.has(client))) {
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

  if (frame?.type === "get_change_set") {
    const id = String(frame.changeSetId ?? "");
    const sessionId = String(frame.sessionId ?? "");
    sendDaemonResponse(client, frame, "get_change_set", (async () => {
      const memory = liveChangeSets.get(id);
      if (memory?.changeSet.sessionId === sessionId) return { changes: memory.changeSet };
      const session = sessions.get(sessionId);
      if (!session || !session.clients.has(client)) throw new Error("Change set is unavailable for this session.");
      const context = await trackingContext(session);
      const changes = await context.tracker.getChangeSet(id, sessionId);
      if (!changes) throw new Error("Change set is unavailable for this session.");
      return { changes };
    })());
    return;
  }

  if (frame?.type === "list_checkpoints" || frame?.type === "prepare_rewind" || frame?.type === "force_prepare_rewind" || frame?.type === "execute_rewind") {
    const sessionId = String(frame.sessionId ?? "");
    const session = sessions.get(sessionId);
    if (frame.type === "list_checkpoints" && (!session || !session.clients.has(client))) {
      sendDaemonResponse(client, frame, "list_checkpoints", (async () => {
        if (session) {
          const context = await trackingContextForRoot(session.cwd);
          if (context.storageHealth !== "ready") return { status: context.health, checkpoints: [] };
          return { status: context.health, checkpoints: await context.tracker.listCheckpoints(session.sessionId ?? session.key) };
        }
        const history = await readPersistedSession({
          agentDir: daemonAgentDir,
          id: sessionId,
          includeArchived: false,
          limit: 1,
          maxBytes: 64 * 1024,
        });
        const header = history.entries.find((entry) => entry && typeof entry === "object" && entry.type === "session");
        if (typeof header?.cwd !== "string" || !header.cwd) throw new Error("Session working directory is unavailable.");
        const context = await trackingContextForRoot(header.cwd);
        if (context.storageHealth !== "ready") return { status: context.health, checkpoints: [] };
        return { status: context.health, checkpoints: await context.tracker.listCheckpoints(history.id) };
      })());
      return;
    }
    if (!session || !session.clients.has(client)) {
      sendToClient(client, { type: "response", command: frame.type, success: false, ...(typeof frame.id === "string" ? { id: frame.id } : {}), error: "Attach the session before using checkpoints." });
      return;
    }
    if (frame.type === "list_checkpoints") {
      sendDaemonResponse(client, frame, "list_checkpoints", (async () => {
        const context = await trackingContext(session);
        if (context.storageHealth !== "ready") return { status: context.health, checkpoints: [] };
        return { status: context.health, checkpoints: await context.tracker.listCheckpoints(sessionId) };
      })());
      return;
    }
    if (frame.type === "prepare_rewind") {
      sendDaemonResponse(client, frame, "prepare_rewind", (async () => {
        const root = canonicalTrackingRoot(session.cwd);
        const context = await trackingContext(session);
        if (context.storageHealth !== "ready") throw new Error(`Rewind is unavailable because tracker status is ${context.storageHealth}.`);
        const checkpointId = String(frame.checkpointId ?? "");
        const blockers = describeRewindBlockers(root);
        if (blockers.length > 0) {
          const forceToken = randomUUID();
          rewindForcePreviews.set(forceToken, { client, sessionId, root, checkpointId, expiresAt: Date.now() + 5 * 60_000 });
          return { status: "blocked", forceToken, blockers };
        }
        let preview;
        try { preview = await context.tracker.previewRewind(sessionId, checkpointId); }
        catch (error) { throw new Error(publicTrackerError(error, "Tracker could not prepare rewind.")); }
        const removesTask = Boolean(session.sessionFile && isFirstPersistedUserEntry(session.sessionFile, preview.checkpoint.userMessageId));
        const operationToken = randomUUID();
        rewindPreviews.set(operationToken, { client, sessionId, root, checkpointId: preview.checkpoint.id, userMessageId: preview.checkpoint.userMessageId, sequence: preview.sequence, generation: preview.generation, affectedOtherTasks: preview.affectedOtherTasks, expiresAt: Date.now() + 5 * 60_000 });
        return { status: "ready", operationToken, removesTask, ...preview };
      })());
      return;
    }
    if (frame.type === "force_prepare_rewind") {
      sendDaemonResponse(client, frame, "force_prepare_rewind", (async () => {
        const forceToken = String(frame.forceToken ?? "");
        const preparedForce = rewindForcePreviews.get(forceToken);
        if (!preparedForce || preparedForce.client !== client || preparedForce.sessionId !== sessionId || preparedForce.expiresAt < Date.now()) {
          throw new Error("Force-rewind preparation expired or is invalid.");
        }
        if (frame.confirm !== true) throw new Error("Force rewind requires confirm=true after blocker review.");
        if (projectMaintenanceRoots.has(preparedForce.root)) throw new Error("Another project maintenance operation is active.");
        await stopRewindBlockers(preparedForce.root);
        const context = await trackingContext(session);
        if (context.storageHealth !== "ready") throw new Error(`Rewind is unavailable because tracker status is ${context.storageHealth}.`);
        let preview;
        try { preview = await context.tracker.previewRewind(sessionId, preparedForce.checkpointId); }
        catch (error) { throw new Error(publicTrackerError(error, "Tracker could not prepare rewind.")); }
        const removesTask = Boolean(session.sessionFile && isFirstPersistedUserEntry(session.sessionFile, preview.checkpoint.userMessageId));
        const operationToken = randomUUID();
        rewindPreviews.set(operationToken, { client, sessionId, root: preparedForce.root, checkpointId: preview.checkpoint.id, userMessageId: preview.checkpoint.userMessageId, sequence: preview.sequence, generation: preview.generation, affectedOtherTasks: preview.affectedOtherTasks, expiresAt: Date.now() + 5 * 60_000 });
        rewindForcePreviews.delete(forceToken);
        return { status: "ready", operationToken, removesTask, ...preview };
      })());
      return;
    }
    sendDaemonResponse(client, frame, "execute_rewind", (async () => {
      const prepared = rewindPreviews.get(String(frame.operationToken ?? ""));
      if (!prepared || prepared.client !== client || prepared.sessionId !== sessionId || prepared.expiresAt < Date.now()) throw new Error("Rewind preview expired or is invalid.");
      if (frame.confirm !== true) throw new Error("Rewind requires confirm=true after preview.");
      if (prepared.affectedOtherTasks > 0 && frame.confirmAffected !== true) throw new Error("Rewind affects checkpoints from other tasks and requires confirmAffected=true.");
      if (session.turnActive || sessionsWorkingInRoot(prepared.root, session).length > 0) throw new Error("Rewind is blocked while a task is working in this workspace.");
      if (projectMaintenanceRoots.has(prepared.root)) throw new Error("Another project maintenance operation is active.");
      projectMaintenanceRoots.add(prepared.root);
      try {
        const context = await trackingContext(session);
        const previousSessionId = sessionId;
        let result;
        try {
          result = await context.tracker.rewind(
            { sessionId, checkpointId: prepared.checkpointId, expectedSequence: prepared.sequence, expectedGeneration: prepared.generation },
            async () => {
              const forked = await requestEngineInternal(session, { type: "fork", entryId: prepared.userMessageId, position: "before" }, 30_000);
              if (forked.data?.cancelled === true) throw new Error("Transcript truncation was cancelled by a session hook.");
              const state = await requestEngineInternal(session, { type: "get_state" });
              if (!state.data || typeof state.data.sessionId !== "string") throw new Error("Forked session identity was unavailable.");
              const nativeSessionId = state.data.sessionId;
              rekeySession(session, nativeSessionId);
              session.nativeSessionId = nativeSessionId;
              session.sessionFile = state.data.sessionFile ?? null;
              if (typeof state.data.cwd === "string" && state.data.cwd) session.cwd = state.data.cwd;
              for (const attachedClient of session.clients) {
                sendToClient(attachedClient, {
                  type: "attached",
                  sessionId: nativeSessionId,
                  nativeSessionId,
                  previousSessionId,
                  sessionFile: session.sessionFile,
                  cwd: session.cwd,
                  clients: session.clients.size,
                  profile: session.profile ?? "coding",
                });
              }
            },
          );
        }
        catch (error) { throw new Error(publicTrackerError(error, "Tracker could not complete rewind.")); }
        for (const [changeSetId, entry] of liveChangeSets) {
          if (entry.changeSet?.sessionId === previousSessionId) liveChangeSets.delete(changeSetId);
        }
        session.lastChangeSet = undefined;
        session.trackingRun = null;
        session.trackingCapturePromise = null;
        session.trackingEstimates = new Map();
        session.trackingToolCalls = new Map();
        session.trackingOmissions = [];
        session.trackingIntersection = new Set();
        session.trackingCaptureRaced = false;
        session.trackingPendingPrompt = null;
        rewindPreviews.delete(String(frame.operationToken));
        const identity = { sessionId: session.sessionId ?? session.key, nativeSessionId: session.nativeSessionId ?? null, sessionFile: session.sessionFile };
        broadcastAll({ type: "workspace_rewound", project: prepared.root, previousSessionId, ...identity, checkpointId: prepared.checkpointId, ...result });
        return { ...result, ...identity, previousSessionId };
      } finally { projectMaintenanceRoots.delete(prepared.root); }
    })());
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
      preparedOperation: frame.operation,
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
    if (!session && frame.profile === "chat") {
      // Chat engines need their sealed launch recipe (asset cwd, restricted
      // tools, chat session root) resolved before spawn; the recipe lookup is
      // asynchronous, so chat attaches join through this deferred path.
      void prepareChatEngineLaunch({ agentDir: daemonAgentDir, ...(sessionId ? { sessionId } : {}) }).then(
        (launch) => {
          if (draining) {
            sendToClient(client, {
              type: "daemon_draining",
              reason: "The MyPi session daemon is restarting; retry in a moment.",
            });
            return;
          }
          const raced = sessionId ? sessions.get(sessionId) : undefined;
          const chatSession = raced ?? startSession({
            sessionId,
            cwd: launch.cwd,
            model: frame.model,
            sessionStart: null,
            profile: "chat",
            launchArgs: launch.args,
            launchEnv: launch.env,
            sessionArg: launch.sessionPath ?? null,
          });
          joinSessionAsClient(client, chatSession, frame.clientDraftId);
        },
        (error) => {
          sendToClient(client, {
            type: "error",
            sessionId,
            error: `Chat attach failed: ${error instanceof Error ? error.message : String(error)}`,
          });
        },
      );
      return;
    }
    if (!session) {
      const preparedFresh = sessionId ? preparedFreshSessionIds.delete(sessionId) : false;
      session = startSession({
        sessionId,
        cwd: frame.cwd,
        model: frame.model,
        sessionStart: normalizeSessionStart(frame.sessionStart) ?? (preparedFresh ? { reason: "new" } : null),
      });
    }
    joinSessionAsClient(client, session, frame.clientDraftId);
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
    if (frame.type === "prompt" || frame.type === "steer" || frame.type === "follow_up") {
      const root = canonicalTrackingRoot(session.cwd);
      if (projectMaintenanceRoots.has(root)) {
        sendToClient(client, { type: "error", sessionId, ...(typeof frame.id === "string" ? { id: frame.id } : {}), error: "Project maintenance is in progress; retry when it finishes." });
        return;
      }
      session.turnActive = true;
	  if (frame.type === "prompt") session.trackingPendingPrompt = { id: typeof frame.id === "string" ? frame.id : randomUUID(), text: typeof frame.message === "string" ? frame.message : "" };
    }
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
