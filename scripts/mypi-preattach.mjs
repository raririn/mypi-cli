// Launcher-side engine pre-warm for the hosted TUI (FEAT-061).
//
// A hosted launch pays two ~5s module-graph boots in sequence: the TUI child
// imports the coding agent, and only then its attach makes the daemon spawn
// the engine child, which imports the same graph again. This module lets the
// lightweight launcher send the daemon an `attach` *before* the TUI child is
// spawned, so the engine boots concurrently with the TUI's import instead of
// after it.
//
// The handoff for fresh sessions goes through a tmp file whose path rides in
// MYPI_TUI_PREATTACH_FILE: the launcher writes {sessionId} once the daemon
// reports `attached`, and the TUI adopts that session instead of creating a
// second one. Resumes need no handoff (the TUI attaches by the same id; the
// daemon simply adds it as another client of the already-spawning engine).
//
// Strictly best-effort: every failure path writes {failed:true} so the TUI
// stops waiting immediately, and an engine nobody ends up adopting is
// reaped by the daemon's idle grace once the launcher's socket closes.

import { randomUUID } from "node:crypto";
import { mkdtempSync, renameSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The launcher cannot replicate the TUI's full hosted-eligibility rules, and
 * a pre-attach for a launch that then runs embedded strands a session in the
 * daemon until the idle grace reaps it. Pre-warm only invocation shapes we
 * fully understand: a plain launch, a `--session <id>` resume, and an
 * optional `--model <name>` — which covers the two hot paths (bare `mypi`
 * and CloudCLI's terminal resume).
 */
export function parsePreattachEligible(argv) {
  let sessionId;
  let model;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--session" || arg === "-s") {
      sessionId = argv[index + 1];
      if (!sessionId || sessionId.startsWith("-")) return undefined;
      index += 1;
    } else if (arg === "--model" || arg === "-m") {
      model = argv[index + 1];
      if (!model || model.startsWith("-")) return undefined;
      index += 1;
    } else {
      return undefined;
    }
  }
  return { sessionId, model };
}

/**
 * Fire-and-forget: dial the daemon, attach, and publish the adopted session
 * id for the TUI child. Never throws, never blocks, never holds the
 * launcher's event loop open (everything is unref'd).
 */
export function startPreattach({ socketPath, protocol, argv, cwd = process.cwd() }) {
  const eligible = parsePreattachEligible(argv);
  if (!eligible) return;

  const handoffDir = mkdtempSync(join(tmpdir(), "mypi-preattach-"));
  const handoffFile = join(handoffDir, "attached.json");
  process.env.MYPI_TUI_PREATTACH_FILE = handoffFile;

  const publish = (payload) => {
    try {
      const temp = join(handoffDir, `attached.${randomUUID()}.tmp`);
      writeFileSync(temp, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
      renameSync(temp, handoffFile);
    } catch {
      // The TUI falls back to its normal attach after the wait timeout.
    }
  };

  let socket;
  const fail = () => {
    publish({ failed: true });
    socket?.destroy();
  };

  try {
    socket = net.connect(socketPath);
  } catch {
    fail();
    return;
  }
  socket.unref();
  socket.setNoDelay(true);
  socket.on("error", fail);
  socket.on("close", () => publish({ failed: true }));

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
      if (frame?.type === "hello_ack") {
        socket.write(`${JSON.stringify({
          type: "attach",
          ...(eligible.sessionId ? { sessionId: eligible.sessionId } : {}),
          cwd,
          ...(eligible.model ? { model: eligible.model } : {}),
        })}\n`);
      } else if (frame?.type === "hello_error" || frame?.type === "error" || frame?.type === "session_exit") {
        fail();
      } else if (frame?.type === "attached" && typeof frame.sessionId === "string") {
        publish({ sessionId: frame.sessionId });
        // Stay connected: the engine must not enter its zero-client grace
        // window between now and the TUI's own attach. The socket dies with
        // the launcher process, which outlives the TUI child.
      }
    }
  });
  socket.on("connect", () => {
    socket.write(`${JSON.stringify({ type: "hello", protocol, client: "mypi-launcher-preattach" })}\n`);
  });
}
