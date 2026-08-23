// `mypi proxy` — stdio ↔ session-daemon pass-through (FEAT-061, option A).
//
// Remote surfaces reach the daemon with one pipe:
//
//     ssh host mypi proxy
//
// The frames are the daemon's own protocol, unchanged, so a client speaks
// exactly what it would speak locally and a feature shipped in the daemon
// works remotely the same day. Narrowing is expressed as a *filter* here,
// not as a second protocol: `--read-only` refuses mutating frames with a
// typed error while leaving every frame shape identical.
//
// Exits when either side closes.

import { spawn } from "node:child_process";
import net from "node:net";
import { daemonSocketPath, readLiveDaemon } from "./mypi-daemon-discovery.mjs";

const SPAWN_TIMEOUT_MS = 15_000;

/** Frames that change state; refused in --read-only mode. */
const MUTATING_FRAME_TYPES = new Set([
  "prompt",
  "steer",
  "follow_up",
  "abort",
  "compact",
  "set_model",
  "set_thinking_level",
  "cycle_model",
  "cycle_thinking_level",
  "new_session",
  "switch_session",
  "navigate_tree",
  "fork",
  "clone",
  "set_session_name",
  "set_project_trust",
  "set_project_tracking",
  "rebuild_project_tracker",
  "execute_rewind",
  "execute_project_removal",
  "bash",
  "release",
  "extension_ui_response",
]);

const args = process.argv.slice(3).filter((value) => value !== "--");
const readOnly = args.includes("--read-only");
const noSpawn = args.includes("--no-spawn");

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

const live = readLiveDaemon();
let socketPath = live?.socketPath ?? null;
if (!socketPath) {
  if (noSpawn) {
    process.stderr.write("No MyPi session daemon is running (--no-spawn).\n");
    process.exit(4);
  }
  try {
    socketPath = await spawnDaemon();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

const socket = net.connect(socketPath ?? daemonSocketPath());

socket.on("error", (error) => {
  process.stderr.write(`MyPi proxy connection failed: ${error.message}\n`);
  process.exit(1);
});
socket.on("close", () => process.exit(0));
socket.on("data", (chunk) => process.stdout.write(chunk));

if (!readOnly) {
  process.stdin.pipe(socket);
} else {
  // Line-aware filtering so a refusal cannot desynchronize framing.
  let buffer = "";
  process.stdin.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        socket.write(`${line}\n`);
        continue;
      }
      if (MUTATING_FRAME_TYPES.has(frame?.type)) {
        process.stdout.write(`${JSON.stringify({
          type: "error",
          sessionId: frame.sessionId ?? null,
          id: frame.id ?? undefined,
          error: `This proxy is read-only; "${frame.type}" is refused.`,
          code: "PROXY_READ_ONLY",
        })}\n`);
        continue;
      }
      socket.write(`${line}\n`);
    }
  });
}

process.stdin.on("end", () => socket.end());
process.on("SIGTERM", () => socket.destroy());
process.on("SIGINT", () => socket.destroy());
