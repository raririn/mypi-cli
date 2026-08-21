// End-to-end MCP qualification through a real RPC engine: a mock provider
// drives mcp_search -> mcp_load -> loaded-tool call and records the
// provider-visible tool inventory at every step.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const MYPI = fileURLToPath(new URL("../scripts/mypi.mjs", import.meta.url));
const FIXTURE = fileURLToPath(new URL("../packages/runtime/test/product/fixtures/mcp-fixture-server.mjs", import.meta.url));

function sseToolCall(response, name, args, callId) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: callId, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
  response.end("data: [DONE]\n\n");
}

function sseText(response, text) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}\n\n`);
  response.end("data: [DONE]\n\n");
}

test("gateway tools, load, and loaded-tool calls work through a real RPC engine", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "mypi-mcp-rpc-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  let child;
  const requests = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk.toString(); });
    request.on("end", () => {
      const parsed = JSON.parse(body);
      requests.push(parsed);
      const step = requests.length;
      if (step === 1) sseToolCall(response, "mcp_search", { server: "fixture", kind: "tool" }, "call_search");
      else if (step === 2) sseToolCall(response, "mcp_load", { server: "fixture", tools: ["echo"] }, "call_load");
      else if (step === 3) sseToolCall(response, "mcp_fixture_echo", { text: "roundtrip" }, "call_echo");
      else sseText(response, "mcp-e2e-done");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
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
    await writeFile(join(agentDir, "config.yaml"), JSON.stringify({
      version: 1,
      mcp: { servers: { fixture: { command: process.execPath, args: [FIXTURE], toolPolicy: { echo: { effect: "read", allowInPlan: true } } } } },
    }));

    child = spawn(process.execPath, [MYPI, "--mode", "rpc", "--provider", "localtest", "--model", "mock", "--approve"], {
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
    const waitFor = (predicate, label, timeoutMs = 40_000) => new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const tick = () => {
        const match = frames.find(predicate);
        if (match) return resolve(match);
        if (Date.now() > deadline) return reject(new Error(`Timed out waiting for ${label}. stderr: ${stderr.slice(-2000)}`));
        setTimeout(tick, 25);
      };
      tick();
    });

    child.stdin.write(`${JSON.stringify({ id: "p1", type: "prompt", message: "Use the fixture MCP server" })}\n`);
    await waitFor((f) => f.type === "agent_settled", "settlement");

    const toolEnds = frames.filter((f) => f.type === "tool_execution_end");
    const byName = Object.fromEntries(toolEnds.map((f) => [f.toolName, f]));
    assert.ok(byName.mcp_search, "mcp_search executed");
    assert.equal(byName.mcp_search.isError, false);
    assert.ok(byName.mcp_load, "mcp_load executed");
    assert.equal(byName.mcp_load.isError, false, JSON.stringify(byName.mcp_load.result ?? {}));
    assert.ok(byName.mcp_fixture_echo, "loaded tool executed in the same run");
    assert.equal(byName.mcp_fixture_echo.isError, false, JSON.stringify(byName.mcp_fixture_echo.result ?? {}));
    const echoText = (byName.mcp_fixture_echo.result?.content ?? []).map((part) => part.text).join("\n");
    assert.match(echoText, /echo: roundtrip/u);

    // Provider-visible inventory: the gateway is present from the start and
    // the loaded definition reaches the provider before its call step.
    const toolNames = (request) => (request.tools ?? []).map((tool) => tool.function?.name ?? tool.name);
    assert.ok(toolNames(requests[0]).includes("mcp_search"), `gateway advertised: ${toolNames(requests[0]).join(",")}`);
    assert.ok(toolNames(requests[2]).includes("mcp_fixture_echo"), `loaded tool advertised on the step after load: ${toolNames(requests[2]).join(",")}`);
  } finally {
    child?.kill("SIGKILL");
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});
