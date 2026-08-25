// Pressure tests for the v2 one-shot agent hooks against a REAL RPC engine
// with a scripted provider. These exercise the failure modes that got the
// v1 tools removed (transcript 01a0310f): steer-injected firings preventing
// settlement, accumulating timers, and firings resurrecting stopped runs.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const MYPI = fileURLToPath(new URL("../scripts/mypi.mjs", import.meta.url));

function sseText(response, text) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\n`);
  response.end("data: [DONE]\n\n");
}

function sseToolCall(response, name, args, callId) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: callId, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
  response.end("data: [DONE]\n\n");
}

/** Boots a real RPC engine wired to a scripted provider. `script(step, request, response)`
 *  answers the Nth provider request (1-based). */
async function bootEngine(script) {
  const root = await mkdtemp(join(tmpdir(), "mypi-agent-hooks-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  const requests = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk.toString(); });
    request.on("end", () => {
      const parsed = JSON.parse(body);
      requests.push(parsed);
      script(requests.length, parsed, response);
    });
  });
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const port = server.address().port;
  await writeFile(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      localtest: {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        api: "openai-completions",
        apiKey: "test-only",
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: [{ id: "mock", name: "Mock", reasoning: false, input: ["text"], contextWindow: 64_000, maxTokens: 2_000 }],
      },
    },
  }), { mode: 0o600 });

  const child = spawn(process.execPath, [MYPI, "--mode", "rpc", "--provider", "localtest", "--model", "mock", "--approve"], {
    cwd: root,
    env: { ...process.env, MYPI_AGENT_DIR: agentDir, MYPI_CODING_AGENT_DIR: agentDir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d.toString(); });
  const frames = [];
  let buffer = "";
  child.stdout.on("data", (d) => {
    buffer += d.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try { frames.push(JSON.parse(line)); } catch { /* banners */ }
    }
  });
  const waitFor = (predicate, label, timeoutMs = 40_000) => new Promise((resolvePromise, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const match = frames.find(predicate);
      if (match) return resolvePromise(match);
      if (Date.now() > deadline) return reject(new Error(`Timed out waiting for ${label}. stderr: ${stderr.slice(-2000)}`));
      setTimeout(tick, 25);
    };
    tick();
  });
  const send = (frame) => child.stdin.write(`${JSON.stringify(frame)}\n`);
  const cleanup = async () => {
    child.kill("SIGKILL");
    server.close();
    await rm(root, { recursive: true, force: true });
  };
  return { root, child, frames, requests, waitFor, send, cleanup };
}

const settleCount = (frames) => frames.filter((f) => f.type === "agent_settled").length;
const lastUserText = (request) => {
  const users = (request.messages ?? []).filter((message) => message.role === "user");
  const content = users[users.length - 1]?.content;
  return typeof content === "string" ? content : (content ?? []).map((part) => part.text ?? "").join("\n");
};

test("one-shot watch fires once while idle, starts one labeled turn, and is consumed", { timeout: 60_000 }, async () => {
  const engine = await bootEngine((step, _request, response) => {
    if (step === 1) sseToolCall(response, "watch_files", { action: "watch", path: "artifact.txt", note: "artifact updated" }, "call_watch");
    else if (step === 2) sseText(response, "watching-now");
    else sseText(response, "hook-handled");
  });
  try {
    const artifact = join(engine.root, "artifact.txt");
    writeFileSync(artifact, "initial");
    engine.send({ id: "p1", type: "prompt", message: "watch the artifact" });
    await engine.waitFor((f) => f.type === "agent_settled", "first settlement");
    const settlesBefore = settleCount(engine.frames);

    writeFileSync(artifact, "changed");
    await engine.waitFor((f) => f.type === "message_start" && f.message?.role === "custom" && f.message?.customType === "mypi-hook-fired", "hook-fired custom message");
    await engine.waitFor(() => settleCount(engine.frames) > settlesBefore, "hook-triggered run settles");

    assert.equal(engine.requests.length, 3, "exactly one hook-triggered provider run");
    const notification = lastUserText(engine.requests[2]);
    assert.match(notification, /^\[Automated agent-hook notification — not a user message/u);
    assert.match(notification, /file watch f\d+ .*: artifact updated/u);
    assert.match(notification, /never schedule wakeups to poll/u);

    // Consumed: further changes are silent.
    writeFileSync(artifact, "changed-again");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_500));
    assert.equal(engine.requests.length, 3, "consumed watch must not fire again");
  } finally {
    await engine.cleanup();
  }
});

test("a firing during an active run is held to settlement, then continues as its own run", { timeout: 60_000 }, async () => {
  let releaseStep2;
  const step2Released = new Promise((resolvePromise) => { releaseStep2 = resolvePromise; });
  const engine = await bootEngine((step, _request, response) => {
    if (step === 1) sseToolCall(response, "watch_files", { action: "watch", path: "artifact.txt", note: "mid-run change" }, "call_watch");
    else if (step === 2) void step2Released.then(() => sseText(response, "long-run-done"));
    else sseText(response, "post-settle-handled");
  });
  try {
    const artifact = join(engine.root, "artifact.txt");
    writeFileSync(artifact, "initial");
    engine.send({ id: "p1", type: "prompt", message: "watch then work" });
    // Step 2 (the run's continuation after the tool result) is now pending at
    // the provider; the run is active. Fire the watch mid-run.
    await engine.waitFor(() => engine.requests.length === 2, "run active on provider step 2");
    writeFileSync(artifact, "changed");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_800));
    assert.equal(
      engine.frames.some((f) => f.type === "message_start" && f.message?.customType === "mypi-hook-fired"),
      false,
      "firing must not be injected into the active run",
    );
    releaseStep2();

    await engine.waitFor((f) => f.type === "agent_settled", "first settlement");
    await engine.waitFor(() => engine.requests.length >= 3, "hook continuation run");
    const settleIndex = engine.frames.findIndex((f) => f.type === "agent_settled");
    const hookIndex = engine.frames.findIndex((f) => f.type === "message_start" && f.message?.customType === "mypi-hook-fired");
    assert.ok(hookIndex > settleIndex, "notification delivered only after the run settled");
    assert.match(lastUserText(engine.requests[2]), /mid-run change/u);
  } finally {
    await engine.cleanup();
  }
});

test("after an abort, a pending firing lands in context but never resurrects the run", { timeout: 60_000 }, async () => {
  const engine = await bootEngine((step, _request, response) => {
    if (step === 1) sseToolCall(response, "watch_files", { action: "watch", path: "artifact.txt", note: "aborted-run change" }, "call_watch");
    else if (step === 2) { /* never answer: the run hangs until the abort */ }
    else sseText(response, "must-not-happen");
  });
  try {
    const artifact = join(engine.root, "artifact.txt");
    writeFileSync(artifact, "initial");
    engine.send({ id: "p1", type: "prompt", message: "watch then hang" });
    await engine.waitFor(() => engine.requests.length === 2, "run hanging on provider step 2");
    writeFileSync(artifact, "changed");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_800));
    engine.send({ id: "a1", type: "abort" });
    await engine.waitFor((f) => f.type === "agent_settled", "aborted settlement");

    // The notice reaches context as a custom message without starting a run.
    await engine.waitFor((f) => f.type === "message_end" && f.message?.customType === "mypi-hook-fired", "held notice lands in context");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_500));
    assert.equal(engine.requests.length, 2, "no provider run after the abort");
    assert.equal(settleCount(engine.frames), 1, "no second run to settle");
  } finally {
    await engine.cleanup();
  }
});

test("schedule_wakeup holds a single replaceable slot through real tool calls", { timeout: 60_000 }, async () => {
  const engine = await bootEngine((step, _request, response) => {
    if (step === 1) sseToolCall(response, "schedule_wakeup", { action: "schedule", delaySeconds: 3600, note: "first" }, "call_w1");
    else if (step === 2) sseToolCall(response, "schedule_wakeup", { action: "schedule", delaySeconds: 7200, note: "second" }, "call_w2");
    else if (step === 3) sseToolCall(response, "schedule_wakeup", { action: "status" }, "call_status");
    else if (step === 4) sseToolCall(response, "schedule_wakeup", { action: "cancel" }, "call_cancel");
    else sseText(response, "wakeup-lifecycle-done");
  });
  try {
    engine.send({ id: "p1", type: "prompt", message: "exercise the wakeup slot" });
    await engine.waitFor((f) => f.type === "agent_settled", "settlement");
    const results = engine.frames.filter((f) => f.type === "tool_execution_end").map((f) => (f.result?.content ?? []).map((part) => part.text ?? "").join("\n"));
    assert.match(results[0], /Scheduled wakeup w1: fires once in 3600s/u);
    assert.match(results[1], /replacing w1 \(one wakeup slot per session\)/u);
    assert.match(results[2], /Wakeup w2 fires in 7\d{3}s — second/u);
    assert.match(results[3], /Cancelled wakeup w2/u);
    assert.equal(engine.frames.some((f) => f.type === "message_start" && f.message?.customType === "mypi-hook-fired"), false, "nothing fired");
  } finally {
    await engine.cleanup();
  }
});

test("new_session clears agent hooks: a pre-switch watch never fires into the replacement session", { timeout: 60_000 }, async () => {
  const engine = await bootEngine((step, _request, response) => {
    if (step === 1) sseToolCall(response, "watch_files", { action: "watch", path: "artifact.txt", note: "stale session watch" }, "call_watch");
    else sseText(response, "ok");
  });
  try {
    const artifact = join(engine.root, "artifact.txt");
    writeFileSync(artifact, "initial");
    engine.send({ id: "p1", type: "prompt", message: "watch the artifact" });
    await engine.waitFor((f) => f.type === "agent_settled", "first settlement");

    engine.send({ id: "n1", type: "new_session" });
    await engine.waitFor((f) => f.type === "response" && f.id === "n1", "new_session ack");

    writeFileSync(artifact, "changed");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_500));
    assert.equal(
      engine.frames.some((f) => f.type === "message_start" && f.message?.customType === "mypi-hook-fired"),
      false,
      "watch from the previous session must not fire into the new one",
    );
  } finally {
    await engine.cleanup();
  }
});
