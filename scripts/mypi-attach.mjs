// `mypi attach [session]` — line-mode client for the session daemon
// (FEAT-061, docs/25-unified-session-authority.md).
//
// Connects to the one per-profile daemon socket, lists or attaches a session
// by id, renders the transcript tail for context, streams the live turn, and
// accepts prompts from stdin. The session keeps running (and stays
// answerable from other surfaces) after detach; this client never owns it.
//
// `--take` performs a native takeover instead: the daemon releases the
// session cleanly and it is reopened in the full TUI as the owner.
//
// In-loop commands: /abort, /steer <text>, /detach, /help. A pending
// ask_user prompt turns the next input line into its answer (number or text).

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import readline from "node:readline";
import { MYPI_DAEMON_PROTOCOL, readLiveDaemon } from "./mypi-daemon-discovery.mjs";

const TRANSCRIPT_TAIL_MESSAGES = 6;
const SPAWN_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 20_000;

const rawArgs = process.argv.slice(3).filter((value) => value !== "--");
const takeMode = rawArgs.includes("--take");
const forceTake = rawArgs.includes("--force");
const args = rawArgs.filter((value) => !value.startsWith("--"));
const target = args[0];

function usage(sessions) {
  process.stderr.write("Usage: mypi attach [--take [--force]] [session-id-or-prefix]\n");
  process.stderr.write("  --take   release the session from the daemon and open it natively in the TUI\n");
  process.stderr.write("  --force  with --take: abort an in-flight turn instead of refusing\n");
  if (!sessions?.length) {
    process.stderr.write("No live sessions. Sessions become live when a surface (a GUI, or the TUI) opens one.\n");
    return;
  }
  process.stderr.write("Live sessions:\n");
  for (const session of sessions) {
    process.stderr.write(`  ${session.sessionId}  (cwd ${session.cwd ?? "?"}${session.busy ? ", busy" : ""})\n`);
  }
}

/** Starts a detached daemon and resolves once its socket is listening. */
function spawnDaemon() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [process.argv[1], "__daemon"], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env },
    });
    let buffer = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error("Timed out waiting for the MyPi session daemon to start"));
    }, SPAWN_TIMEOUT_MS);
    timer.unref?.();
    child.stdout?.on("data", (data) => {
      buffer += data.toString();
      const line = buffer.split("\n").find((candidate) => candidate.trim());
      if (!line || settled) return;
      try {
        const frame = JSON.parse(line);
        if (frame?.type === "daemon_ready" && typeof frame.socketPath === "string") {
          settled = true;
          clearTimeout(timer);
          child.stdout?.destroy();
          child.unref();
          resolve(frame.socketPath);
        }
      } catch {
        // Bootstrap noise before the daemon takes stdout.
      }
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`MyPi session daemon exited during startup (code ${code})`));
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** Connects to the daemon (spawning it when absent) and completes the handshake. */
async function connectToDaemon() {
  const live = readLiveDaemon();
  const socketPath = live?.socketPath ?? (await spawnDaemon());
  const socket = net.connect(socketPath);
  const listeners = new Set();
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }
      for (const listener of listeners) listener(frame);
    }
  });

  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });

  const connection = {
    socket,
    send: (frame) => socket.write(`${JSON.stringify(frame)}\n`),
    onFrame: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    once: (predicate, timeoutMs = REQUEST_TIMEOUT_MS) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        stop();
        reject(new Error("The daemon did not answer in time."));
      }, timeoutMs);
      timer.unref?.();
      const stop = connection.onFrame((frame) => {
        if (!predicate(frame)) return;
        clearTimeout(timer);
        stop();
        resolve(frame);
      });
    }),
  };

  connection.send({ type: "hello", protocol: MYPI_DAEMON_PROTOCOL, client: "mypi-attach" });
  const ack = await connection.once((frame) => frame.type === "hello_ack" || frame.type === "hello_error");
  if (ack.type === "hello_error") {
    process.stderr.write(`${ack.reason}\n`);
    process.exit(5);
  }
  return connection;
}

function renderTranscriptTail(sessionFile) {
  if (!sessionFile || !existsSync(sessionFile)) return;
  let lines;
  try {
    lines = readFileSync(sessionFile, "utf8").split("\n");
  } catch {
    return;
  }
  const rendered = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== "message" || !entry.message) continue;
    const { role, content } = entry.message;
    if (role !== "user" && role !== "assistant") continue;
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.filter((block) => block?.type === "text").map((block) => block.text).join("\n")
        : "";
    if (text.trim()) rendered.push({ role, text: text.trim() });
  }
  for (const message of rendered.slice(-TRANSCRIPT_TAIL_MESSAGES)) {
    const label = message.role === "user" ? "you" : "mypi";
    process.stdout.write(`\x1b[2m[${label}]\x1b[0m ${message.text}\n`);
  }
  if (rendered.length > 0) process.stdout.write("\x1b[2m── attached; earlier history above ──\x1b[0m\n");
}

const connection = await connectToDaemon();

connection.send({ type: "list_sessions" });
const listing = await connection.once((frame) => frame.type === "sessions");
const sessions = listing.sessions ?? [];

let chosen;
if (target) {
  const matches = sessions.filter((s) => s.sessionId === target || s.sessionId.startsWith(target));
  if (matches.length === 1) {
    chosen = matches[0];
  } else if (matches.length > 1) {
    process.stderr.write(`"${target}" is ambiguous.\n`);
    usage(sessions);
    process.exit(2);
  } else {
    // Not live yet: the daemon loads it on attach, which is how a session
    // that is merely persisted (not running) is resumed.
    chosen = { sessionId: target, cwd: process.cwd() };
  }
} else if (sessions.length === 1) {
  chosen = sessions[0];
} else {
  usage(sessions);
  process.exit(sessions.length === 0 ? 1 : 2);
}

/**
 * Native takeover: ask the daemon to release the session cleanly, then open
 * it in the full TUI as its owner. Ownership moves only via clean shutdown
 * of the owning runtime — the lease is never transferred.
 */
if (takeMode) {
  process.stdout.write(`Requesting release of ${chosen.sessionId}…\n`);
  connection.send({ type: "attach", sessionId: chosen.sessionId, cwd: chosen.cwd });
  const attached = await connection.once((frame) => frame.type === "attached" && frame.sessionId === chosen.sessionId, 30_000);
  connection.send({ type: "release", sessionId: chosen.sessionId, force: forceTake });
  const outcome = await connection.once(
    (frame) => (frame.type === "released" || frame.type === "release_denied") && frame.sessionId === chosen.sessionId,
    30_000,
  );
  if (outcome.type === "release_denied") {
    process.stderr.write(`Release denied: ${outcome.reason}\n`);
    process.exit(3);
  }
  const sessionFile = outcome.sessionFile ?? attached.sessionFile;
  connection.socket.destroy();
  if (!sessionFile) {
    process.stderr.write("The daemon did not report a session file; cannot resume natively.\n");
    process.exit(1);
  }
  // Give the released engine a moment to exit so its writer lease is free.
  await new Promise((resolve) => setTimeout(resolve, 400));
  process.stdout.write("Session released. Opening it in the TUI…\n");
  const execSeam = process.env.MYPI_ATTACH_TAKE_EXEC;
  const argv = execSeam
    ? [...JSON.parse(execSeam), "--session", sessionFile]
    : [process.execPath, process.argv[1], "--session", sessionFile];
  const tui = spawn(argv[0], argv.slice(1), { stdio: "inherit" });
  tui.on("exit", (code) => process.exit(code ?? 0));
  tui.on("error", (error) => {
    process.stderr.write(`Failed to start the TUI: ${error.message}\n`);
    process.exit(1);
  });
} else {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "› " });
  let pendingAsk = null;
  let streaming = false;

  const showPrompt = () => rl.prompt(true);
  const printAbove = (text) => {
    process.stdout.write(`\r\x1b[2K${text}\n`);
    showPrompt();
  };

  connection.onFrame((frame) => {
    if (frame.sessionId && frame.sessionId !== chosen.sessionId) return;
    switch (frame.type) {
      case "attached":
        process.stdout.write(`\x1b[2mAttached to session ${frame.sessionId}.\x1b[0m\n`);
        renderTranscriptTail(frame.sessionFile);
        process.stdout.write("\x1b[2mType a prompt; /abort /steer <text> /detach /help.\x1b[0m\n");
        showPrompt();
        return;
      case "agent_start":
        streaming = true;
        printAbove("\x1b[2m[turn started]\x1b[0m");
        return;
      case "message_update": {
        const event = frame.assistantMessageEvent;
        if (event?.type === "text_delta" && typeof event.delta === "string") process.stdout.write(event.delta);
        return;
      }
      case "message_end":
        process.stdout.write("\n");
        return;
      case "tool_execution_start":
        printAbove(`\x1b[2m[tool] ${frame.toolName ?? "?"}\x1b[0m`);
        return;
      case "agent_settled":
        streaming = false;
        printAbove(`\x1b[2m[turn ${frame.outcome?.kind ?? "settled"}]\x1b[0m`);
        return;
      case "extension_ui_request":
        handleUiRequest(frame);
        return;
      case "session_stderr":
        printAbove(`\x1b[31m[engine] ${frame.text}\x1b[0m`);
        return;
      case "session_released":
        process.stdout.write("\nThe session was released to another surface.\n");
        process.exit(0);
        return;
      case "session_exit":
        process.stdout.write(`\nThe session runtime exited${frame.lastErrorNotify ? `: ${frame.lastErrorNotify}` : "."}\n`);
        process.exit(frame.code === 0 ? 0 : 1);
        return;
      case "error":
        printAbove(`\x1b[31m${frame.error}\x1b[0m`);
        return;
      default:
        return;
    }
  });

  function handleUiRequest(frame) {
    switch (frame.method) {
      case "mypiAskUser": {
        pendingAsk = { id: frame.id, options: frame.options ?? [] };
        const lines = [`\x1b[36m? ${frame.question}\x1b[0m`];
        pendingAsk.options.forEach((option, index) => {
          lines.push(`  ${index + 1}. ${option.label}${option.description ? ` \x1b[2m— ${option.description}\x1b[0m` : ""}`);
        });
        lines.push("\x1b[2mAnswer with a number or free text (Enter alone skips).\x1b[0m");
        printAbove(lines.join("\n"));
        return;
      }
      case "dismiss":
        if (pendingAsk?.id === frame.targetId) {
          pendingAsk = null;
          printAbove("\x1b[2m[question dismissed — answered on another surface]\x1b[0m");
        }
        return;
      case "notify":
        printAbove(`\x1b[33m[${frame.notifyType ?? "info"}] ${frame.message}\x1b[0m`);
        return;
      default:
        return;
    }
  }

  connection.socket.on("close", () => {
    process.stdout.write("\nThe daemon closed the connection.\n");
    process.exit(0);
  });

  connection.send({ type: "attach", sessionId: chosen.sessionId, cwd: chosen.cwd });

  rl.on("line", (rawLine) => {
    const line = rawLine.trim();
    if (pendingAsk) {
      const ask = pendingAsk;
      pendingAsk = null;
      if (!line) {
        connection.send({ type: "extension_ui_response", sessionId: chosen.sessionId, id: ask.id, cancelled: true });
      } else {
        const optionIndex = Number(line);
        const option = Number.isInteger(optionIndex) ? ask.options[optionIndex - 1] : undefined;
        connection.send({
          type: "extension_ui_response",
          sessionId: chosen.sessionId,
          id: ask.id,
          value: option ? option.label : line,
        });
      }
      showPrompt();
      return;
    }

    if (line === "/detach" || line === "/exit" || line === "/quit") {
      connection.send({ type: "detach", sessionId: chosen.sessionId });
      process.stdout.write("Detached. The session keeps running.\n");
      process.exit(0);
    }
    if (line === "/help") {
      printAbove("/abort — stop the current turn; /steer <text> — steer it; /detach — leave the session running.");
      return;
    }
    if (line === "/abort") {
      connection.send({ id: `a${Date.now()}`, type: "abort", sessionId: chosen.sessionId });
      showPrompt();
      return;
    }
    if (line.startsWith("/steer ")) {
      connection.send({ id: `s${Date.now()}`, type: "steer", message: line.slice(7), sessionId: chosen.sessionId });
      showPrompt();
      return;
    }
    if (!line) {
      showPrompt();
      return;
    }

    connection.send({
      id: `p${Date.now()}`,
      type: streaming ? "steer" : "prompt",
      message: line,
      sessionId: chosen.sessionId,
    });
    showPrompt();
  });

  rl.on("SIGINT", () => {
    process.stdout.write("\nDetached (Ctrl+C). The session keeps running; use /abort to stop a turn.\n");
    process.exit(0);
  });
  rl.on("close", () => process.exit(0));
}
