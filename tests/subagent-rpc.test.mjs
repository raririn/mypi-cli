import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SubagentManager } from "../packages/runtime/dist/product/subagents.js";

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error("Timed out waiting for condition");
}

function writeCompletion(response, text) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(`data: ${JSON.stringify({ id: "chatcmpl-subagent", object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ id: "chatcmpl-subagent", object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\n`);
  response.end("data: [DONE]\n\n");
}

function writeBashToolCall(response, command) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(`data: ${JSON.stringify({
    id: "chatcmpl-tool",
    object: "chat.completion.chunk",
    created: 1,
    model: "mock",
    choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_work", type: "function", function: { name: "bash", arguments: JSON.stringify({ command }) } }] }, finish_reason: null }],
  })}\n\n`);
  response.write(`data: ${JSON.stringify({ id: "chatcmpl-tool", object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
  response.end("data: [DONE]\n\n");
}

async function writeLocalModel(agentDir, port) {
  await writeFile(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      localtest: {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        api: "openai-completions",
        apiKey: "test-only",
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: [{ id: "mock", name: "Mock", reasoning: false, input: ["text"], contextWindow: 32_000, maxTokens: 2_000 }],
      },
    },
  }), { mode: 0o600 });
}

test("session-owned subagent manager runs a package-pinned async RPC child and delivers only its bounded result", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "mypi-subagent-rpc-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  let providerRequestBody = "";
  const server = createServer((request, response) => {
    if (request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    let body = "";
    request.on("data", (chunk) => { body += chunk.toString(); });
    request.on("end", () => {
      providerRequestBody = body;
      writeCompletion(response, "child-rpc-ok");
    });
  });
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await writeLocalModel(agentDir, address.port);

  const previousAgentDir = process.env.MYPI_AGENT_DIR;
  const previousCodingAgentDir = process.env.MYPI_CODING_AGENT_DIR;
  process.env.MYPI_AGENT_DIR = agentDir;
  process.env.MYPI_CODING_AGENT_DIR = agentDir;
  let delivered;
  const delivery = new Promise((resolvePromise) => { delivered = resolvePromise; });
  const pi = {
    sendMessage(message, options) { delivered({ message, options }); },
  };
  const sessionFile = join(root, "parent.jsonl");
  await writeFile(sessionFile, "{}\n");
  const ctx = {
    cwd,
    model: { provider: "localtest", id: "mock" },
    thinkingLevel: "off",
    isIdle: () => true,
    isProjectTrusted: () => true,
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => "parent-rpc-test",
      getLeafId: () => null,
      getBranch: () => [{ type: "message", message: { role: "user", content: "PARENT_TRANSCRIPT_SECRET" } }],
    },
  };
  const manager = new SubagentManager(pi);
  try {
    const accepted = await manager.start([{ role: "explore", label: "RPC smoke", task: "Return child-rpc-ok." }], ctx);
    assert.match(accepted.batchId, /^sb_/);
    assert.equal(accepted.jobs[0].status, "queued");
    let timeoutHandle;
    const result = await Promise.race([
      delivery,
      new Promise((_, reject) => { timeoutHandle = setTimeout(() => reject(new Error("Timed out waiting for subagent delivery")), 20_000); }),
    ]).finally(() => clearTimeout(timeoutHandle));
    assert.equal(result.message.customType, "mypi-subagent-results");
    assert.match(String(result.message.content), /child-rpc-ok/);
    assert.equal(result.options.triggerTurn, true);
    const childId = accepted.jobs[0].childId;
    const childSession = join(agentDir, "subagents", "by-parent", "parent-rpc-test", "children", childId, "session.jsonl");
    const history = await readFile(childSession, "utf8");
    assert.match(history, /Return child-rpc-ok/);
    assert.match(history, /child-rpc-ok/);
    assert.doesNotMatch(String(result.message.content), /toolCall|thinkingSignature/);
    assert.doesNotMatch(providerRequestBody, /PARENT_TRANSCRIPT_SECRET/, "the child provider request never receives parent history");
  } finally {
    await manager.shutdown("test_complete");
    await new Promise((resolvePromise) => server.close(resolvePromise));
    if (previousAgentDir === undefined) delete process.env.MYPI_AGENT_DIR;
    else process.env.MYPI_AGENT_DIR = previousAgentDir;
    if (previousCodingAgentDir === undefined) delete process.env.MYPI_CODING_AGENT_DIR;
    else process.env.MYPI_CODING_AGENT_DIR = previousCodingAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("last-client detach cancels an RPC grant without delivery and follow-up revives the retained child", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "mypi-subagent-revive-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  let requestCount = 0;
  const sockets = new Set();
  const server = createServer((request, response) => {
    if (request.url !== "/v1/chat/completions") return response.writeHead(404).end();
    request.resume();
    request.on("end", () => {
      requestCount += 1;
      if (requestCount === 1) return; // Hold the first provider request until parent-detach aborts it.
      writeCompletion(response, "revived-ok");
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await writeLocalModel(agentDir, address.port);
  const previousAgentDir = process.env.MYPI_AGENT_DIR;
  const previousCodingAgentDir = process.env.MYPI_CODING_AGENT_DIR;
  process.env.MYPI_AGENT_DIR = agentDir;
  process.env.MYPI_CODING_AGENT_DIR = agentDir;
  const deliveries = [];
  const pi = { sendMessage(message, options) { deliveries.push({ message, options }); } };
  const sessionFile = join(root, "parent.jsonl");
  await writeFile(sessionFile, "{}\n");
  const ctx = {
    cwd,
    model: { provider: "localtest", id: "mock" },
    thinkingLevel: "off",
    isIdle: () => true,
    isProjectTrusted: () => true,
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => "parent-revive-test",
      getLeafId: () => null,
      getBranch: () => [],
    },
  };
  const manager = new SubagentManager(pi);
  try {
    const accepted = await manager.start([{ role: "explore", label: "Slow RPC", task: "Wait." }], ctx);
    const childId = accepted.jobs[0].childId;
    await waitFor(() => manager.status([childId])[0]?.status === "running");
    await manager.detach();
    await waitFor(() => manager.status([childId])[0]?.status === "cancelled");
    assert.equal(manager.status([childId])[0].reason, "parent_detached");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
    assert.equal(deliveries.length, 0, "a dead parent is never auto-woken for cancellation delivery");

    manager.markAttached();
    await manager.followup(childId, "Return revived-ok.", ctx);
    await waitFor(() => deliveries.some((entry) => String(entry.message.content).includes("revived-ok")), 20_000);
    assert.equal(manager.status([childId])[0].status, "completed");
    assert.equal(manager.status([childId])[0].revivable, true);
  } finally {
    await manager.shutdown("test_complete");
    for (const socket of sockets) socket.destroy();
    await new Promise((resolvePromise) => server.close(resolvePromise));
    if (previousAgentDir === undefined) delete process.env.MYPI_AGENT_DIR;
    else process.env.MYPI_AGENT_DIR = previousAgentDir;
    if (previousCodingAgentDir === undefined) delete process.env.MYPI_CODING_AGENT_DIR;
    else process.env.MYPI_CODING_AGENT_DIR = previousCodingAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("work grants hold the parent write lease and force child Bash through the protected sandbox", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "mypi-subagent-work-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  await mkdir(join(cwd, ".git"), { recursive: true, mode: 0o700 });
  const gitConfig = join(cwd, ".git", "config");
  await writeFile(gitConfig, "protected\n");
  let requestCount = 0;
  const server = createServer((request, response) => {
    if (request.url !== "/v1/chat/completions") return response.writeHead(404).end();
    request.resume();
    request.on("end", () => {
      requestCount += 1;
      if (requestCount === 1) writeBashToolCall(response, "printf hacked > .git/config");
      else writeCompletion(response, "work-finished");
    });
  });
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await writeLocalModel(agentDir, address.port);
  const previousAgentDir = process.env.MYPI_AGENT_DIR;
  const previousCodingAgentDir = process.env.MYPI_CODING_AGENT_DIR;
  process.env.MYPI_AGENT_DIR = agentDir;
  process.env.MYPI_CODING_AGENT_DIR = agentDir;
  const deliveries = [];
  const pi = { sendMessage(message, options) { deliveries.push({ message, options }); } };
  const sessionFile = join(root, "parent.jsonl");
  await writeFile(sessionFile, "{}\n");
  const ctx = {
    cwd,
    model: { provider: "localtest", id: "mock" },
    thinkingLevel: "off",
    isIdle: () => true,
    isProjectTrusted: () => true,
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => "parent-work-test",
      getLeafId: () => null,
      getBranch: () => [],
    },
  };
  const manager = new SubagentManager(pi);
  try {
    const accepted = await manager.start([{ role: "work", label: "Sandbox work", task: "Attempt the requested check." }], ctx);
    const childId = accepted.jobs[0].childId;
    await waitFor(() => manager.hasWorkLease());
    await waitFor(() => deliveries.some((entry) => String(entry.message.content).includes("work-finished")), 20_000);
    assert.equal(manager.hasWorkLease(), false);
    assert.equal(await readFile(gitConfig, "utf8"), "protected\n", "the work child cannot corrupt protected Git metadata");
    assert.match(String(deliveries.at(-1).message.content), /Workspace evidence/);
    const childSession = join(agentDir, "subagents", "by-parent", "parent-work-test", "children", childId, "session.jsonl");
    assert.match(await readFile(childSession, "utf8"), /sandbox|denied|not permitted|Operation not permitted/i);
  } finally {
    await manager.shutdown("test_complete");
    await new Promise((resolvePromise) => server.close(resolvePromise));
    if (previousAgentDir === undefined) delete process.env.MYPI_AGENT_DIR;
    else process.env.MYPI_AGENT_DIR = previousAgentDir;
    if (previousCodingAgentDir === undefined) delete process.env.MYPI_CODING_AGENT_DIR;
    else process.env.MYPI_CODING_AGENT_DIR = previousCodingAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});
