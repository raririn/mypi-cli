import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HOST_SCRIPT = fileURLToPath(new URL("../scripts/mypi-host.mjs", import.meta.url));
const ATTACH_SCRIPT = fileURLToPath(new URL("../scripts/mypi-attach.mjs", import.meta.url));
const FAKE_ENGINE = fileURLToPath(new URL("./fixtures/fake-rpc-engine.cjs", import.meta.url));

function waitFor(predicate, timeoutMs = 3_000, label = "condition") {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (predicate()) return resolve(undefined);
      if (Date.now() > deadline) return reject(new Error(`Timed out waiting for ${label}`));
      setTimeout(tick, 15);
    };
    tick();
  });
}

/** Spawns a host wired to the fake engine; resolves once the socket is up. */
async function startHost({ mode, graceMs = 200, engineArgs = [] } = {}) {
  const hostDir = await mkdtemp(join(tmpdir(), "mypi-host-test-"));
  const child = spawn(
    process.execPath,
    // argv[2] must be "__host" — the host script slices from index 3.
    [HOST_SCRIPT, "__host", "--host-grace-ms", String(graceMs), ...engineArgs],
    {
      env: {
        ...process.env,
        MYPI_HOST_DIR: hostDir,
        MYPI_HOST_ENGINE_CMD: JSON.stringify([process.execPath, FAKE_ENGINE]),
        ...(mode ? { FAKE_ENGINE_MODE: mode } : { FAKE_ENGINE_MODE: "" }),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr += d.toString();
  });

  const ready = await new Promise((resolve, reject) => {
    let buffer = "";
    const onExit = () => reject(new Error(`host exited before ready. stderr: ${stderr}`));
    child.once("exit", onExit);
    child.stdout.on("data", (data) => {
      buffer += data.toString();
      const line = buffer.split("\n").find((l) => l.trim());
      if (!line) return;
      child.off("exit", onExit);
      resolve(JSON.parse(line));
    });
  });

  return {
    child,
    hostDir,
    socketPath: ready.socketPath,
    exited: false,
    async cleanup() {
      child.kill("SIGKILL");
      await rm(hostDir, { recursive: true, force: true });
    },
  };
}

/** Connects a JSONL client to the host socket. */
function connectClient(socketPath) {
  const socket = net.connect(socketPath);
  const frames = [];
  let buffer = "";
  socket.on("data", (data) => {
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) frames.push(JSON.parse(line));
    }
  });
  const closed = new Promise((resolve) => socket.once("close", resolve));
  return {
    socket,
    frames,
    closed,
    send(frame) {
      socket.write(`${JSON.stringify(frame)}\n`);
    },
    ofType(type) {
      return frames.filter((frame) => frame.type === type);
    },
    async connected() {
      await new Promise((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
    },
  };
}

test("host announces readiness, writes a sidecar, and greets clients with host_hello", async () => {
  const host = await startHost();
  try {
    const client = connectClient(host.socketPath);
    await client.connected();
    await waitFor(() => client.ofType("host_hello").length > 0, 3_000, "host_hello");

    const hello = client.ofType("host_hello")[0];
    assert.equal(hello.sessionId, "fake-session-1");
    assert.match(hello.sessionFile, /fake-session-1\.jsonl$/);

    const sidecarPath = join(host.hostDir, "fake-session-1.host.json");
    await waitFor(() => existsSync(sidecarPath), 3_000, "sidecar");
    const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8"));
    assert.equal(sidecar.pid, host.child.pid);
    assert.equal(sidecar.socketPath, host.socketPath);
    client.socket.destroy();
  } finally {
    await host.cleanup();
  }
});

test("commands route responses to the issuing client only; events fan out to all", async () => {
  const host = await startHost();
  try {
    const first = connectClient(host.socketPath);
    const second = connectClient(host.socketPath);
    await first.connected();
    await second.connected();

    // Colliding client-chosen ids must not cross-route.
    first.send({ id: "1", type: "get_state" });
    second.send({ id: "1", type: "get_state" });
    await waitFor(
      () => first.ofType("response").length === 1 && second.ofType("response").length === 1,
      3_000,
      "both get_state responses",
    );
    assert.equal(first.ofType("response")[0].id, "1");
    assert.equal(second.ofType("response")[0].id, "1");
    assert.equal(first.ofType("response")[0].data.sessionId, "fake-session-1");

    // A turn started by one client streams to both.
    first.send({ id: "p1", type: "prompt", message: "hello" });
    await waitFor(
      () => first.ofType("agent_settled").length === 1 && second.ofType("agent_settled").length === 1,
      3_000,
      "settled on both clients",
    );
    assert.equal(second.ofType("message_update").length, 1);
    // The prompt ack went only to the issuing client.
    assert.equal(second.frames.filter((f) => f.type === "response" && f.command === "prompt").length, 0);

    first.socket.destroy();
    second.socket.destroy();
  } finally {
    await host.cleanup();
  }
});

test("first extension_ui_response wins; duplicates never reach the engine", async () => {
  const host = await startHost({ mode: "ask-user" });
  try {
    const first = connectClient(host.socketPath);
    const second = connectClient(host.socketPath);
    await first.connected();
    await second.connected();

    first.send({ id: "p1", type: "prompt", message: "risky" });
    await waitFor(
      () => first.ofType("extension_ui_request").length === 1 && second.ofType("extension_ui_request").length === 1,
      3_000,
      "ui request broadcast",
    );

    second.send({ type: "extension_ui_response", id: "ask-1", value: "Yes" });
    first.send({ type: "extension_ui_response", id: "ask-1", value: "No" });

    await waitFor(() => first.ofType("__fake_ui_response_received").length >= 1, 3_000, "engine echo");
    // Give a duplicate a chance to (incorrectly) arrive, then assert exactly one.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(first.ofType("__fake_ui_response_received").length, 1);
    assert.equal(first.ofType("__fake_ui_response_received")[0].value, "Yes");

    first.socket.destroy();
    second.socket.destroy();
  } finally {
    await host.cleanup();
  }
});

test("host exits after grace when the last client leaves, cleaning discovery files", async () => {
  const host = await startHost({ graceMs: 150 });
  try {
    const client = connectClient(host.socketPath);
    await client.connected();
    await waitFor(() => client.ofType("host_hello").length > 0, 3_000, "hello");
    const hostExit = new Promise((resolve) => host.child.once("exit", resolve));

    client.socket.destroy();
    await hostExit;

    assert.equal(existsSync(host.socketPath), false, "socket removed");
    const leftover = await readdir(host.hostDir);
    assert.deepEqual(leftover, [], "hosts dir is clean");
  } finally {
    await host.cleanup();
  }
});

test("an active turn defers shutdown until it settles", async (t) => {
  // The fake's turn runs 600ms; grace is 60ms. A host that ignored the active
  // turn would exit ~60ms after the disconnect, killing the engine mid-turn.
  t.diagnostic("turn=600ms grace=60ms");
  const previousTurnMs = process.env.FAKE_ENGINE_TURN_MS;
  process.env.FAKE_ENGINE_TURN_MS = "600";
  const host = await startHost({ graceMs: 60 });
  try {
    const client = connectClient(host.socketPath);
    await client.connected();
    client.send({ id: "p1", type: "prompt", message: "long-running" });
    await waitFor(() => client.ofType("agent_start").length === 1, 3_000, "turn started");

    const disconnectedAt = Date.now();
    const hostExit = new Promise((resolve) => host.child.once("exit", resolve));
    client.socket.destroy();

    // Well past grace, mid-turn: the host must still be alive.
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(host.child.exitCode, null, "host survived grace expiry during the turn");

    await hostExit;
    const lifetime = Date.now() - disconnectedAt;
    assert.ok(lifetime >= 550, `host lived through the turn (lived ${lifetime}ms)`);
  } finally {
    if (previousTurnMs === undefined) delete process.env.FAKE_ENGINE_TURN_MS;
    else process.env.FAKE_ENGINE_TURN_MS = previousTurnMs;
    await host.cleanup();
  }
});

function spawnAttach(hostDir, attachArgs = []) {
  const child = spawn(process.execPath, [ATTACH_SCRIPT, "attach", ...attachArgs], {
    env: { ...process.env, MYPI_HOST_DIR: hostDir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => {
    stdout += d.toString();
  });
  child.stderr.on("data", (d) => {
    stderr += d.toString();
  });
  return {
    child,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    write(line) {
      child.stdin.write(`${line}\n`);
    },
    exited: new Promise((resolve) => child.once("exit", resolve)),
  };
}

test("mypi attach continues a hosted session: prompt, stream, detach leaves it running", async () => {
  const host = await startHost();
  try {
    await waitFor(() => existsSync(join(host.hostDir, "fake-session-1.host.json")), 3_000, "sidecar");

    const attach = spawnAttach(host.hostDir, ["fake-session-1"]);
    await waitFor(() => attach.stdout.includes("Attached to session fake-session-1"), 3_000, "attach banner");

    attach.write("hello world");
    await waitFor(() => attach.stdout.includes("echo:hello world"), 3_000, "streamed echo");
    await waitFor(() => attach.stdout.includes("[turn success]"), 3_000, "settled marker");

    attach.write("/detach");
    const code = await attach.exited;
    assert.equal(code, 0);

    // Detaching must not tear the session down while another client is live.
    const stillThere = connectClient(host.socketPath);
    await stillThere.connected();
    stillThere.send({ id: "1", type: "get_state" });
    await waitFor(() => stillThere.ofType("response").length === 1, 3_000, "host alive after detach");
    stillThere.socket.destroy();
  } finally {
    await host.cleanup();
  }
});

test("mypi attach renders ask_user prompts and forwards the chosen answer", async () => {
  const host = await startHost({ mode: "ask-user" });
  try {
    await waitFor(() => existsSync(join(host.hostDir, "fake-session-1.host.json")), 3_000, "sidecar");

    // A raw co-client observes what actually reaches the engine.
    const observer = connectClient(host.socketPath);
    await observer.connected();

    const attach = spawnAttach(host.hostDir);
    await waitFor(() => attach.stdout.includes("Attached to session"), 3_000, "attach banner");

    attach.write("do the risky thing");
    await waitFor(() => attach.stdout.includes("Proceed?"), 3_000, "question rendered");
    assert.match(attach.stdout, /1\. Yes/);

    attach.write("1");
    await waitFor(() => observer.ofType("__fake_ui_response_received").length === 1, 3_000, "answer reached engine");
    assert.equal(observer.ofType("__fake_ui_response_received")[0].value, "Yes");

    attach.write("/detach");
    await attach.exited;
    observer.socket.destroy();
  } finally {
    await host.cleanup();
  }
});

test("host_release: idle release shuts the host down cleanly and notifies clients", async () => {
  const host = await startHost();
  try {
    const watcher = connectClient(host.socketPath);
    const requester = connectClient(host.socketPath);
    await watcher.connected();
    await requester.connected();
    await waitFor(() => requester.ofType("host_hello").length > 0, 3_000, "hello");

    const hostExit = new Promise((resolve) => host.child.once("exit", resolve));
    requester.send({ type: "host_release" });

    await waitFor(() => requester.ofType("host_release_ok").length === 1, 3_000, "release ok");
    assert.match(requester.ofType("host_release_ok")[0].sessionFile, /fake-session-1\.jsonl$/);
    await waitFor(() => watcher.ofType("host_released").length === 1, 3_000, "release broadcast");
    await hostExit;
    assert.equal(existsSync(host.socketPath), false, "socket removed");
    assert.equal(existsSync(join(host.hostDir, "fake-session-1.host.json")), false, "sidecar removed");
  } finally {
    await host.cleanup();
  }
});

test("host_release: refused mid-turn without force; force aborts and completes", async (t) => {
  t.diagnostic("turn=600ms");
  const previousTurnMs = process.env.FAKE_ENGINE_TURN_MS;
  process.env.FAKE_ENGINE_TURN_MS = "600";
  const host = await startHost();
  try {
    const client = connectClient(host.socketPath);
    await client.connected();
    client.send({ id: "p1", type: "prompt", message: "long" });
    await waitFor(() => client.ofType("agent_start").length === 1, 3_000, "turn started");

    client.send({ type: "host_release" });
    await waitFor(() => client.ofType("host_release_denied").length === 1, 3_000, "denied mid-turn");
    assert.equal(client.ofType("host_release_denied")[0].turnActive, true);
    assert.equal(host.child.exitCode, null, "host still running after denial");

    const hostExit = new Promise((resolve) => host.child.once("exit", resolve));
    client.send({ type: "host_release", force: true });
    await waitFor(() => client.ofType("host_release_ok").length === 1, 5_000, "forced release ok");
    const settled = client.ofType("agent_settled");
    assert.equal(settled.length, 1, "turn settled before the release completed");
    assert.equal(settled[0].outcome?.kind, "aborted", "forced release aborted the turn");
    await hostExit;
  } finally {
    if (previousTurnMs === undefined) delete process.env.FAKE_ENGINE_TURN_MS;
    else process.env.FAKE_ENGINE_TURN_MS = previousTurnMs;
    await host.cleanup();
  }
});

test("mypi attach --take releases the host and opens the session natively", async () => {
  const host = await startHost();
  try {
    await waitFor(() => existsSync(join(host.hostDir, "fake-session-1.host.json")), 3_000, "sidecar");

    const fakeTui = fileURLToPath(new URL("./fixtures/fake-tui.cjs", import.meta.url));
    const child = spawn(process.execPath, [ATTACH_SCRIPT, "attach", "--take", "fake-session-1"], {
      env: {
        ...process.env,
        MYPI_HOST_DIR: host.hostDir,
        MYPI_ATTACH_TAKE_EXEC: JSON.stringify([process.execPath, fakeTui]),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    const exited = new Promise((resolve) => child.once("exit", resolve));

    const code = await exited;
    assert.equal(code, 0, `attach --take exited cleanly. output: ${stdout}`);
    assert.match(stdout, /Session released\. Opening it in the TUI/);
    assert.match(stdout, /FAKE_TUI --session \/tmp\/fake-engine\/fake-session-1\.jsonl/);
    // The host is gone: its discovery entries must not linger.
    assert.equal(existsSync(host.socketPath), false, "socket removed after takeover");
  } finally {
    await host.cleanup();
  }
});

test("engine death is broadcast as host_engine_exit and the host cleans up", async () => {
  const host = await startHost({ mode: "crash-mid-turn" });
  try {
    const client = connectClient(host.socketPath);
    await client.connected();
    await waitFor(() => client.ofType("host_hello").length > 0, 3_000, "hello");

    const hostExit = new Promise((resolve) => host.child.once("exit", resolve));
    client.send({ id: "p1", type: "prompt", message: "boom" });

    await waitFor(() => client.ofType("host_engine_exit").length === 1, 3_000, "engine exit frame");
    await client.closed;
    await hostExit;
    assert.equal(existsSync(host.socketPath), false, "socket removed");
  } finally {
    await host.cleanup();
  }
});
