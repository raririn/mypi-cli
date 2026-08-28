import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import imageGenExtension, {
  DEFAULT_IMAGE_GEN_ENDPOINT,
  GENERATE_IMAGE_TOOL_NAME,
  registerImageGenTool,
  resolveImageGenActivation,
} from "../../src/product/image-gen.ts";

function createHarness() {
  const tools = new Map<string, any>();
  const pi = {
    registerTool(definition: any) {
      tools.set(definition.name, definition);
    },
    on() {},
    registerCommand() {},
  } as unknown as ExtensionAPI;
  return { pi, tool: (name: string) => tools.get(name), toolCount: () => tools.size };
}

/** Unsigned JWT whose payload carries the ChatGPT account-id claim. */
function fakeAccessToken(accountId: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");
  return `${encode({ alg: "none" })}.${encode({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })}.sig`;
}

/** Bytes that satisfy the PNG signature + IHDR dimension probe (8x8). */
function fakePngBytes(): Buffer {
  const buffer = Buffer.alloc(33);
  buffer.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(8, 16);
  buffer.writeUInt32BE(8, 20);
  return buffer;
}

async function writeAgentDir(options: { configured?: boolean; oauth?: boolean; endpoint?: string }): Promise<string> {
  const agentDir = await mkdtemp(join(tmpdir(), "mypi-image-gen-agent-"));
  if (options.configured) {
    const endpointLine = options.endpoint ? `\n    endpoint: ${options.endpoint}` : "";
    await writeFile(
      join(agentDir, "config.yaml"),
      `version: 2\nshared:\n  imageGen:\n    provider: openai-codex${endpointLine}\n`,
      { mode: 0o600 },
    );
  }
  if (options.oauth) {
    await writeFile(
      join(agentDir, "auth.json"),
      JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: fakeAccessToken("acct-123"),
          refresh: "refresh-token",
          expires: Date.now() + 60 * 60 * 1000,
          accountId: "acct-123",
        },
      }),
      { mode: 0o600 },
    );
  }
  return agentDir;
}

test("generate_image gating: registers only when the toggle is on AND an endpoint is set", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "mypi-image-gen-cwd-"));
  const unconfigured = await writeAgentDir({ oauth: true });
  const noEndpoint = await writeAgentDir({ configured: true, oauth: true });
  const ready = await writeAgentDir({ configured: true, oauth: true, endpoint: "https://example.test/codex/" });
  const previousAgentDir = process.env.MYPI_CODING_AGENT_DIR;
  try {
    assert.equal(resolveImageGenActivation({ cwd, agentDir: unconfigured }), undefined, "toggle gate");
    assert.equal(resolveImageGenActivation({ cwd, agentDir: noEndpoint }), undefined, "endpoint gate — no default fallback");
    const activation = resolveImageGenActivation({ cwd, agentDir: ready });
    assert.deepEqual(activation, { endpoint: "https://example.test/codex" }, "endpoint, trailing slash trimmed");

    // Credentials no longer gate registration: an alternative endpoint may
    // not need the Codex OAuth; failures surface at call time.
    const noCredential = await writeAgentDir({ configured: true, endpoint: "https://example.test/codex/" });
    assert.deepEqual(resolveImageGenActivation({ cwd, agentDir: noCredential }), { endpoint: "https://example.test/codex" });
    await rm(noCredential, { recursive: true, force: true });

    // The product-module entry point respects the same gate.
    process.env.MYPI_CODING_AGENT_DIR = noEndpoint;
    const gated = createHarness();
    imageGenExtension(gated.pi);
    assert.equal(gated.toolCount(), 0, "no tool without an endpoint");

    process.env.MYPI_CODING_AGENT_DIR = ready;
    const active = createHarness();
    imageGenExtension(active.pi);
    assert.ok(active.tool(GENERATE_IMAGE_TOOL_NAME), "tool registered when toggled on with an endpoint");
  } finally {
    if (previousAgentDir === undefined) delete process.env.MYPI_CODING_AGENT_DIR;
    else process.env.MYPI_CODING_AGENT_DIR = previousAgentDir;
    for (const dir of [cwd, unconfigured, noEndpoint, ready]) await rm(dir, { recursive: true, force: true });
  }
});

test("generate_image shapes the Codex request, writes the PNG, and returns an image content block", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "mypi-image-gen-ws-"));
  const agentDir = await writeAgentDir({ configured: true, oauth: true, endpoint: DEFAULT_IMAGE_GEN_ENDPOINT });
  const previousAgentDir = process.env.MYPI_CODING_AGENT_DIR;
  process.env.MYPI_CODING_AGENT_DIR = agentDir;
  const png = fakePngBytes();
  const requests: { url: string; init: RequestInit }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    requests.push({ url: String(input), init: init ?? {} });
    return new Response(
      JSON.stringify({ created: 1, data: [{ b64_json: png.toString("base64") }], size: "8x8", usage: {} }),
      { status: 200, headers: { "content-type": "application/json", "x-codex-imagegen-request-id": "req-42" } },
    );
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  try {
    const harness = createHarness();
    imageGenExtension(harness.pi);
    const tool = harness.tool(GENERATE_IMAGE_TOOL_NAME);
    assert.ok(tool, "tool registered");

    const ctx = { cwd } as any;
    const result = await tool.execute(
      "call-1",
      { prompt: "a red fox", size: "512x512", quality: "high" },
      undefined,
      undefined,
      ctx,
    );

    // Request shaping: URL, headers, body.
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://chatgpt.com/backend-api/codex/images/generations");
    const headers = new Headers(requests[0].init.headers as HeadersInit);
    assert.equal(headers.get("authorization"), `Bearer ${fakeAccessToken("acct-123")}`);
    assert.equal(headers.get("chatgpt-account-id"), "acct-123");
    assert.equal(headers.get("originator"), "pi");
    assert.equal(headers.get("content-type"), "application/json");
    assert.equal(headers.get("accept"), "application/json");
    assert.equal(headers.get("openai-beta"), null, "no OpenAI-Beta header");
    assert.match(headers.get("user-agent") ?? "", /^pi \(/);
    const body = JSON.parse(String(requests[0].init.body));
    assert.deepEqual(body, {
      prompt: "a red fox",
      model: "gpt-image-2",
      background: "auto",
      quality: "high",
      size: "512x512",
    });

    // Result: text block naming the file plus an inline image block.
    assert.equal(result.content.length, 2);
    assert.match(result.content[0].text, /^Generated generated-images\/img-\d+-1\.png \(8x8\)$/);
    assert.equal(result.content[1].type, "image");
    assert.equal(result.content[1].mimeType, "image/png");
    assert.equal(result.content[1].data, png.toString("base64"));
    assert.equal(result.details.responseId, "req-42");

    // The file landed inside the workspace with the returned bytes.
    const written = await readFile(join(cwd, result.details.files[0].path));
    assert.deepEqual(written, png);

    // Edits: input images route to /images/edits as data URIs.
    await mkdir(join(cwd, "assets"), { recursive: true });
    await writeFile(join(cwd, "assets", "base.png"), png);
    await tool.execute(
      "call-2",
      { prompt: "make it blue", input_images: ["assets/base.png"] },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(requests.length, 2);
    assert.equal(requests[1].url, "https://chatgpt.com/backend-api/codex/images/edits");
    const editBody = JSON.parse(String(requests[1].init.body));
    assert.equal(editBody.images.length, 1);
    assert.ok(editBody.images[0].image_url.startsWith(`data:image/png;base64,${png.toString("base64").slice(0, 16)}`));

    // Workspace containment: escaping paths are rejected before any request.
    await assert.rejects(
      () => tool.execute("call-3", { prompt: "x", input_images: ["../outside.png"] }, undefined, undefined, ctx),
      /inside the workspace/,
    );
    assert.equal(requests.length, 2);
  } finally {
    if (previousAgentDir === undefined) delete process.env.MYPI_CODING_AGENT_DIR;
    else process.env.MYPI_CODING_AGENT_DIR = previousAgentDir;
    await rm(cwd, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("generate_image surfaces friendly usage-limit errors without retrying the 429", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "mypi-image-gen-limit-"));
  const agentDir = await writeAgentDir({ configured: true, oauth: true, endpoint: DEFAULT_IMAGE_GEN_ENDPOINT });
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(
      JSON.stringify({
        error: { code: "usage_limit_reached", limit_id: "image_gen", plan_type: "Plus", resets_at: Math.floor(Date.now() / 1000) + 1800 },
      }),
      { status: 429 },
    );
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  try {
    const harness = createHarness();
    registerImageGenTool(harness.pi, { endpoint: DEFAULT_IMAGE_GEN_ENDPOINT });
    const previousAgentDir = process.env.MYPI_CODING_AGENT_DIR;
    process.env.MYPI_CODING_AGENT_DIR = agentDir;
    try {
      await assert.rejects(
        () =>
          harness
            .tool(GENERATE_IMAGE_TOOL_NAME)
            .execute("call-1", { prompt: "a fox" }, undefined, undefined, { cwd } as any),
        /hit your ChatGPT image generation limit \(plus plan\)\. Try again in ~\d+ min\./,
      );
    } finally {
      if (previousAgentDir === undefined) delete process.env.MYPI_CODING_AGENT_DIR;
      else process.env.MYPI_CODING_AGENT_DIR = previousAgentDir;
    }
    assert.equal(calls, 1, "429 is never blind-retried");
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
  }
});
