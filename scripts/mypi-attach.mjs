// `mypi attach [session]` — line-mode client for a live hosted session
// (FEAT-060 Phase 2a, docs/24-session-host-architecture.md).
//
// Attaches to a session-host socket, renders the transcript tail for context,
// streams the live turn, and accepts prompts from stdin. The session keeps
// running (and stays answerable from other surfaces) after detach; this
// client never owns the session.
//
// In-loop commands: /abort, /steer <text>, /detach, /help. A pending
// ask_user prompt turns the next input line into its answer (number or text).

import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import net from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import readline from "node:readline";

const TRANSCRIPT_TAIL_MESSAGES = 6;

function agentDir() {
  const configured = process.env.MYPI_AGENT_DIR || process.env.MYPI_CODING_AGENT_DIR;
  return resolve(configured || join(homedir(), ".mypi", "agent"));
}

function hostsDir() {
  return process.env.MYPI_HOST_DIR ? resolve(process.env.MYPI_HOST_DIR) : join(agentDir(), "hosts");
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

async function discoverHosts() {
  const dir = hostsDir();
  let entries = [];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const hosts = [];
  for (const entry of entries) {
    if (!entry.endsWith(".host.json")) continue;
    try {
      const sidecar = JSON.parse(readFileSync(join(dir, entry), "utf8"));
      if (!sidecar?.socketPath || !pidAlive(sidecar.pid) || !existsSync(sidecar.socketPath)) continue;
      hosts.push(sidecar);
    } catch {
      // Malformed or stale sidecar: skip; hosts prune their own files.
    }
  }
  return hosts;
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
        ? content.filter((b) => b?.type === "text").map((b) => b.text).join("\n")
        : "";
    if (text.trim()) rendered.push({ role, text: text.trim() });
  }
  for (const message of rendered.slice(-TRANSCRIPT_TAIL_MESSAGES)) {
    const label = message.role === "user" ? "you" : "mypi";
    process.stdout.write(`\x1b[2m[${label}]\x1b[0m ${message.text}\n`);
  }
  if (rendered.length > 0) process.stdout.write("\x1b[2m── attached; earlier history above ──\x1b[0m\n");
}

function usage(hosts) {
  process.stderr.write("Usage: mypi attach [session-id-or-prefix]\n");
  if (hosts.length === 0) {
    process.stderr.write("No live hosted sessions. Hosted sessions are created by MyPi GUI clients (CloudCLI).\n");
  } else {
    process.stderr.write("Live hosted sessions:\n");
    for (const host of hosts) {
      process.stderr.write(`  ${host.sessionId}  (cwd ${host.cwd ?? "?"})\n`);
    }
  }
}

const args = process.argv.slice(3).filter((a) => a !== "--");
const target = args[0];

const hosts = await discoverHosts();
let chosen;
if (target) {
  const matches = hosts.filter((h) => h.sessionId === target || h.sessionId.startsWith(target));
  if (matches.length !== 1) {
    process.stderr.write(matches.length === 0 ? `No live host matches "${target}".\n` : `"${target}" is ambiguous.\n`);
    usage(hosts);
    process.exit(1);
  }
  chosen = matches[0];
} else if (hosts.length === 1) {
  chosen = hosts[0];
} else {
  usage(hosts);
  process.exit(hosts.length === 0 ? 1 : 2);
}

const socket = net.connect(chosen.socketPath);
let pendingAsk = null; // { id, options: [{label}] }
let streaming = false;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "› " });

function send(frame) {
  socket.write(`${JSON.stringify(frame)}\n`);
}

function showPrompt() {
  rl.prompt(true);
}

function printAbove(text) {
  // Keep the readline prompt at the bottom.
  process.stdout.write(`\r\x1b[2K${text}\n`);
  showPrompt();
}

socket.on("connect", () => {
  process.stdout.write(`\x1b[2mAttached to session ${chosen.sessionId} (host pid ${chosen.pid}).\x1b[0m\n`);
  renderTranscriptTail(chosen.sessionFile);
  process.stdout.write("\x1b[2mType a prompt; /abort /steer <text> /detach /help.\x1b[0m\n");
  showPrompt();
});

socket.on("error", (error) => {
  process.stderr.write(`Connection failed: ${error.message}\n`);
  process.exit(1);
});

socket.on("close", () => {
  process.stdout.write("\nHost closed the connection.\n");
  process.exit(0);
});

let buffer = "";
socket.on("data", (data) => {
  buffer += data.toString();
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
    handleFrame(frame);
  }
});

function handleFrame(frame) {
  switch (frame.type) {
    case "host_hello":
      return;
    case "agent_start":
      streaming = true;
      printAbove("\x1b[2m[turn started]\x1b[0m");
      return;
    case "message_update": {
      const event = frame.assistantMessageEvent;
      if (event?.type === "text_delta" && typeof event.delta === "string") {
        process.stdout.write(event.delta);
      }
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
    case "host_engine_stderr":
      printAbove(`\x1b[31m[engine] ${frame.text}\x1b[0m`);
      return;
    case "host_engine_exit":
      process.stdout.write(`\nThe session runtime exited${frame.lastErrorNotify ? `: ${frame.lastErrorNotify}` : "."}\n`);
      process.exit(frame.code === 0 ? 0 : 1);
      return;
    default:
      return;
  }
}

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

rl.on("line", (rawLine) => {
  const line = rawLine.trim();

  if (pendingAsk) {
    const ask = pendingAsk;
    pendingAsk = null;
    if (!line) {
      send({ type: "extension_ui_response", id: ask.id, cancelled: true });
    } else {
      const optionIndex = Number(line);
      const option = Number.isInteger(optionIndex) ? ask.options[optionIndex - 1] : undefined;
      send({ type: "extension_ui_response", id: ask.id, value: option ? option.label : line });
    }
    showPrompt();
    return;
  }

  if (line === "/detach" || line === "/exit" || line === "/quit") {
    process.stdout.write("Detached. The session keeps running.\n");
    process.exit(0);
  }
  if (line === "/help") {
    printAbove("/abort — stop the current turn; /steer <text> — steer it; /detach — leave the session running.");
    return;
  }
  if (line === "/abort") {
    send({ id: `a${Date.now()}`, type: "abort" });
    showPrompt();
    return;
  }
  if (line.startsWith("/steer ")) {
    send({ id: `s${Date.now()}`, type: "steer", message: line.slice(7) });
    showPrompt();
    return;
  }
  if (!line) {
    showPrompt();
    return;
  }

  send({ id: `p${Date.now()}`, type: streaming ? "steer" : "prompt", message: line });
  showPrompt();
});

rl.on("SIGINT", () => {
  process.stdout.write("\nDetached (Ctrl+C). The session keeps running; use /abort to stop a turn.\n");
  process.exit(0);
});

rl.on("close", () => {
  process.exit(0);
});
