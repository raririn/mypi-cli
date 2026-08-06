// Extension slash commands that park on interactive dialogs must not stall
// the RPC prompt contract: the prompt acks at dispatch (not after the
// handler), and a command that never starts an agent run still closes the
// turn with a synthetic agent_settled.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const MYPI = fileURLToPath(new URL("../scripts/mypi.mjs", import.meta.url));

const EXTENSION = `
export default function qaDialogs(pi) {
  pi.registerCommand("pickfruit", {
    description: "QA: ui.select round-trip",
    handler: async (args, ctx) => {
      const choice = await ctx.ui.select("Pick a fruit", ["apple", "banana", "cherry"]);
      ctx.ui.notify("You picked: " + (choice ?? "(cancelled)"), "info");
    },
  });
}
`;

test("a dialog-parking extension command acks at dispatch and settles without a run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mypi-rpc-dialog-"));
  let child;
  try {
    await mkdir(join(dir, "agent", "extensions"), { recursive: true });
    await writeFile(join(dir, "agent", "extensions", "qa-dialogs.js"), EXTENSION);

    child = spawn(process.execPath, [MYPI, "--mode", "rpc"], {
      cwd: dir,
      env: {
        ...process.env,
        MYPI_AGENT_DIR: join(dir, "agent"),
        MYPI_CODING_AGENT_DIR: join(dir, "agent"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    const frames = [];
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          frames.push(JSON.parse(line));
        } catch {
          /* engine banners are not JSON */
        }
      }
    });

    const waitFor = (predicate, label, timeoutMs = 20_000) =>
      new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const tick = () => {
          const match = frames.find(predicate);
          if (match) return resolve(match);
          if (Date.now() > deadline) {
            return reject(new Error(`Timed out waiting for ${label}. stderr: ${stderr}`));
          }
          setTimeout(tick, 25);
        };
        tick();
      });

    // Readiness: a get_state round-trip proves the command loop is live.
    child.stdin.write(`${JSON.stringify({ id: "s0", type: "get_state" })}\n`);
    await waitFor((f) => f.type === "response" && f.id === "s0", "get_state ack");

    child.stdin.write(`${JSON.stringify({ id: "p1", type: "prompt", message: "/pickfruit" })}\n`);

    // The dialog parks the handler — the prompt must ack anyway.
    const dialog = await waitFor(
      (f) => f.type === "extension_ui_request" && f.method === "select",
      "select dialog",
    );
    await waitFor(
      (f) => f.type === "response" && f.id === "p1" && f.success === true,
      "prompt ack while the dialog is parked",
      5_000,
    );
    assert.ok(
      !frames.some((f) => f.type === "agent_settled"),
      "no settle before the dialog is answered",
    );

    child.stdin.write(
      `${JSON.stringify({ type: "extension_ui_response", id: dialog.id, value: "banana" })}\n`,
    );

    await waitFor(
      (f) => f.type === "extension_ui_request" && f.method === "notify"
        && String(f.message ?? "").includes("You picked: banana"),
      "notify with the answer",
    );
    // No agent run happened, so the engine owes the client a synthetic settle.
    await waitFor((f) => f.type === "agent_settled", "synthetic agent_settled");
  } finally {
    child?.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
});
