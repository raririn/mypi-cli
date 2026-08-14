// `mypi daemon <subcommand>` — operator control for the per-profile session
// daemon (FEAT-061). Kept out of the hosted-launch fast path: this is a plain
// short-lived client that connects, sends one control frame, and reports.
//
//   mypi daemon status            version/pid/session/turn counts + skew note
//   mypi daemon restart [--force] graceful drain (wait for turns) then exit
//
// A restart is how a post-update runtime takes effect: the running daemon (and
// its engine children) keep serving old code until it exits, after which the
// next launch spawns a fresh daemon on the installed version. Sessions persist,
// so re-attach is lossless.

import net from "node:net";
import {
  MYPI_DAEMON_PROTOCOL,
  daemonSocketPath,
  readLiveDaemon,
} from "./mypi-daemon-discovery.mjs";

const HELLO_TIMEOUT_MS = 10_000;

function usage() {
  process.stderr.write("Usage: mypi daemon <status|restart> [--force]\n");
}

/** Dial the daemon, complete the handshake, and hand the caller a line-framed connection. */
function connect() {
  return new Promise((resolve, reject) => {
    const socket = net.connect(daemonSocketPath());
    socket.setNoDelay(true);
    let buffer = "";
    let handshook = false;
    const onLine = { handler: () => {} };

    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("The session daemon did not answer the handshake."));
    }, HELLO_TIMEOUT_MS);
    timer.unref?.();

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
        if (!handshook) {
          if (frame.type === "hello_ack") {
            handshook = true;
            clearTimeout(timer);
            resolve({
              socket,
              send: (obj) => socket.write(`${JSON.stringify(obj)}\n`),
              onFrame: (handler) => (onLine.handler = handler),
              ack: frame,
            });
          } else if (frame.type === "hello_error") {
            clearTimeout(timer);
            socket.destroy();
            reject(new Error(String(frame.reason ?? "The daemon refused the handshake.")));
          }
          continue;
        }
        onLine.handler(frame);
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ type: "hello", protocol: MYPI_DAEMON_PROTOCOL, client: "mypi-daemon-control" })}\n`);
    });
  });
}

function installedVersion() {
  return process.env.MYPI_RUNTIME_DISPLAY_VERSION ?? null;
}

async function runStatus() {
  const live = readLiveDaemon();
  if (!live) {
    process.stdout.write("No MyPi session daemon is running; the next launch will start one.\n");
    return 0;
  }
  let connection;
  try {
    connection = await connect();
  } catch (error) {
    process.stderr.write(`Could not reach the session daemon: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  return await new Promise((resolve) => {
    connection.onFrame((frame) => {
      if (frame.type !== "daemon_status") return;
      const installed = installedVersion();
      const running = frame.runtimeVersion ?? "(unknown)";
      process.stdout.write(
        `MyPi session daemon (pid ${frame.pid})\n` +
        `  running:   ${running}\n` +
        (installed ? `  installed: ${installed}\n` : "") +
        `  sessions:  ${frame.sessions} (${frame.activeTurns} with an active turn)\n` +
        `  started:   ${frame.startedAt ?? "(unknown)"}\n` +
        (frame.draining ? "  state:     draining (restart in progress)\n" : "")
      );
      if (installed && frame.runtimeVersion && installed !== frame.runtimeVersion) {
        process.stdout.write(
          `\nUpdate pending: the daemon is running ${frame.runtimeVersion} but ${installed} is installed.\n` +
          "Run `mypi daemon restart` to apply it.\n",
        );
      }
      connection.socket.destroy();
      resolve(0);
    });
    connection.socket.on("close", () => resolve(0));
    connection.send({ type: "daemon_status" });
  });
}

async function runRestart(force) {
  const live = readLiveDaemon();
  if (!live) {
    process.stdout.write("No MyPi session daemon is running; the next launch will start one on the current version.\n");
    return 0;
  }
  let connection;
  try {
    connection = await connect();
  } catch (error) {
    process.stderr.write(`Could not reach the session daemon: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  return await new Promise((resolve) => {
    let acked = false;
    connection.onFrame((frame) => {
      if (frame.type === "restart_ack") {
        acked = true;
        if (frame.force) {
          process.stdout.write("Stopping the session daemon (aborting in-flight turns)…\n");
        } else if (frame.activeTurns > 0) {
          process.stdout.write(
            `Waiting for ${frame.activeTurns} active turn(s) to finish before restarting…\n` +
            "(Leave this running, or press Ctrl-C and re-run with --force to abort them.)\n",
          );
        } else {
          process.stdout.write("Stopping the idle session daemon…\n");
        }
      }
    });
    // The daemon exits when the drain completes; the socket close is our signal.
    connection.socket.on("close", () => {
      if (acked) {
        const installed = installedVersion();
        process.stdout.write(
          `MyPi session daemon stopped. The next \`mypi\` launch will start a fresh one${installed ? ` on ${installed}` : ""}.\n`,
        );
        resolve(0);
      } else {
        process.stderr.write("The session daemon closed the connection before acknowledging the restart.\n");
        resolve(1);
      }
    });
    connection.send({ type: "restart", force });
  });
}

const subcommand = process.argv[3];
const flags = process.argv.slice(4);
let exitCode = 0;
if (subcommand === "status") {
  exitCode = await runStatus();
} else if (subcommand === "restart") {
  exitCode = await runRestart(flags.includes("--force") || flags.includes("-f"));
} else {
  usage();
  exitCode = subcommand ? 1 : 0;
}
process.exit(exitCode);
