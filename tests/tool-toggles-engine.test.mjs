// Settings → Tools exit condition: sessions must survive ANY disabled-group
// combination — half off limits capability, all off leaves a chatbot — with
// no tool schemas advertised for disabled groups and no prompt references
// to their tools. Runs a REAL RPC engine against a scripted provider.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const MYPI = fileURLToPath(new URL("../scripts/mypi.mjs", import.meta.url));

function sseText(response, text) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}\n\n`);
  response.end("data: [DONE]\n\n");
}

async function runSession({ disabled, enabled }) {
  const root = await mkdtemp(join(tmpdir(), "mypi-tool-toggles-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  const requests = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk.toString(); });
    request.on("end", () => {
      const parsed = JSON.parse(body);
      if (JSON.stringify(parsed.messages ?? []).includes("Generate a short UI conversation title")) {
        sseText(response, "Mock Title");
        return;
      }
      requests.push(parsed);
      sseText(response, "toggles-ok");
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
  // YAML is a JSON superset; v2 sectioned layout.
  await writeFile(join(agentDir, "config.yaml"), JSON.stringify({
    version: 2,
    shared: { tools: { mode: "compatible", disabled, enabled } },
  }));

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

  try {
    child.stdin.write(`${JSON.stringify({ id: "p1", type: "prompt", message: "Say hello." })}\n`);
    await waitFor((f) => f.type === "agent_settled", "settlement");
    assert.ok(requests.length >= 1, "the provider saw the agent turn");
    const first = requests[0];
    const toolNames = (first.tools ?? []).map((t) => t.function?.name ?? t.name).filter(Boolean);
    const systemText = JSON.stringify(first.messages ?? []);
    const errors = frames.filter((f) => f.type === "error");
    return { toolNames, systemText, errors };
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolvePromise) => server.close(resolvePromise));
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

test("half the groups off: session works, disabled tools vanish from schemas and prompt", { timeout: 90_000 }, async () => {
  const { toolNames, systemText } = await runSession({
    disabled: ["shell", "file-editing", "web", "subagents", "goals", "mcp", "wakeups"],
    enabled: [],
  });
  // Enabled groups still present.
  assert.ok(toolNames.includes("read"), `read missing: ${toolNames.join(",")}`);
  assert.ok(toolNames.includes("ask_user"), "ask_user missing");
  // Disabled groups gone from the advertised schema surface.
  for (const gone of ["bash", "edit", "write", "web_search", "web_fetch", "subagent_start", "create_goal", "mcp_search", "schedule_wakeup"]) {
    assert.ok(!toolNames.includes(gone), `${gone} should be disabled`);
  }
  // Prompt no longer teaches the shell or editing workflow.
  assert.ok(!/Reserve `bash` for actually running things/.test(systemText), "bash guidance leaked");
  assert.ok(!/never with shell redirection/.test(systemText), "edit guidance leaked");
});

test("ALL groups off: the session still settles — a chatbot, not a crash", { timeout: 90_000 }, async () => {
  const { toolNames, systemText, errors } = await runSession({
    disabled: [
      "workspace-read", "file-editing", "shell", "web", "ask-user", "commentary",
      "checkpoints", "goals", "subagents", "mcp", "status", "wakeups",
    ],
    enabled: [],
  });
  const nonExec = toolNames.filter((name) => name !== "exec_code");
  assert.equal(nonExec.length, 0, `expected no tools beyond exec_code, got: ${toolNames.join(",")}`);
  assert.ok(!/`bash`|`grep`|web_search|Destructive actions/.test(systemText), "disabled-tool references leaked into the prompt");
  assert.equal(errors.length, 0, `engine errors: ${JSON.stringify(errors).slice(0, 400)}`);
});

test("default-off groups appear when explicitly enabled", { timeout: 90_000 }, async () => {
  const { toolNames } = await runSession({ disabled: [], enabled: ["archive-manage"] });
  assert.ok(toolNames.includes("session_archive_stats"), "archive tools should be present when enabled");
  const defaults = await runSession({ disabled: [], enabled: [] });
  assert.ok(!defaults.toolNames.includes("session_archive_stats"), "archive tools must stay off by default");
});
