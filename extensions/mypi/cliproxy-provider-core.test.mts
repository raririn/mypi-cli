import assert from "node:assert/strict";
import test from "node:test";
import type { ApiKeyCredential } from "@earendil-works/pi-ai";
import {
  CLIPROXY_BASE_URL_ENV,
  CLIPROXY_CATALOG_TIMEOUT_MS,
  CLIPROXY_PROVIDER_ID,
  applyCliProxyFastPayload,
  createCliProxyProvider,
  fetchCliProxyModels,
  mapCliProxyCatalog,
  resolveCliProxyEndpoints,
} from "./cliproxy-provider-core.ts";

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const catalog = {
  models: [
    {
      slug: "gpt-fast",
      display_name: "GPT Fast",
      context_window: 200_000,
      max_output_tokens: 32_000,
      input_modalities: ["text", "image", "audio"],
      supported_reasoning_levels: [{ effort: "none" }, { effort: "low" }, { effort: "xhigh" }],
      service_tiers: [{ id: "priority" }],
    },
    { id: "hidden", visibility: "hide" },
    { id: "gpt-fast", name: "duplicate" },
  ],
};

test("endpoint normalization confines HTTP to literal loopback and derives both protocol paths", () => {
  assert.deepEqual(resolveCliProxyEndpoints("127.0.0.1:8317/v1"), {
    rootUrl: "http://127.0.0.1:8317",
    inferenceBaseUrl: "http://127.0.0.1:8317/backend-api/",
    modelsUrl: "http://127.0.0.1:8317/v1/models?client_version=mypi",
  });
  assert.deepEqual(resolveCliProxyEndpoints("https://proxy.example/team/backend-api"), {
    rootUrl: "https://proxy.example/team",
    inferenceBaseUrl: "https://proxy.example/team/backend-api/",
    modelsUrl: "https://proxy.example/team/v1/models?client_version=mypi",
  });
  assert.throws(() => resolveCliProxyEndpoints("http://proxy.example"), /Plain HTTP/);
  assert.throws(() => resolveCliProxyEndpoints("http://localhost:8317"), /Plain HTTP/);
  assert.throws(() => resolveCliProxyEndpoints("https://user:secret@proxy.example"), /must not be embedded/);
  assert.throws(() => resolveCliProxyEndpoints("https://proxy.example?token=secret"), /query or fragment/);
});

test("catalog mapping is bounded, deduplicated, and carries Codex/Fast compatibility", () => {
  const endpoints = resolveCliProxyEndpoints("https://proxy.example");
  const models = mapCliProxyCatalog(catalog, endpoints);
  assert.equal(models.length, 1);
  assert.deepEqual(models[0], {
    id: "gpt-fast",
    name: "GPT Fast",
    api: "openai-codex-responses",
    provider: CLIPROXY_PROVIDER_ID,
    baseUrl: "https://proxy.example/backend-api/",
    reasoning: true,
    thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: null, high: null, xhigh: "xhigh", max: null },
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 32_000,
    compat: {
      requiresChatGptAccountId: false,
      supportsCodexToolCallIds: true,
      supportsPriorityServiceTier: true,
    },
  });
  assert.throws(() => mapCliProxyCatalog({ models: [] }, endpoints), /no usable models/);
});

test("model discovery sends bearer auth, bounds errors, and never includes the response body", async () => {
  const endpoints = resolveCliProxyEndpoints("https://proxy.example");
  let authorization = "";
  const models = await fetchCliProxyModels(endpoints, "test-api-key", {
    fetch: async (input, init) => {
      assert.equal(String(input), endpoints.modelsUrl);
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      assert.ok(init?.signal);
      return response(catalog);
    },
  });
  assert.equal(authorization, "Bearer test-api-key");
  assert.equal(models[0]?.id, "gpt-fast");
  assert.equal(CLIPROXY_CATALOG_TIMEOUT_MS, 15_000);

  await assert.rejects(
    fetchCliProxyModels(endpoints, "test-api-key", {
      fetch: async () => new Response("secret upstream diagnostic", { status: 401 }),
    }),
    (error: Error) => error.message === "CLIProxyAPI model discovery failed with HTTP 401.",
  );
});

test("native API-key login validates the catalog and stores endpoint metadata with the secret credential", async () => {
  const prompts: string[] = [];
  const notifications: string[] = [];
  const provider = createCliProxyProvider({
    fetch: async () => response(catalog),
    environment: {},
  });
  const credential = await provider.auth.apiKey?.login?.({
    prompt: async (prompt) => {
      prompts.push(`${prompt.type}:${prompt.message}`);
      return prompt.type === "secret" ? "test-api-key" : "https://proxy.example/v1";
    },
    notify: (event) => {
      if (event.type === "progress") notifications.push(event.message);
    },
  });
  assert.deepEqual(credential, {
    type: "api_key",
    key: "test-api-key",
    env: { [CLIPROXY_BASE_URL_ENV]: "https://proxy.example" },
  });
  assert.deepEqual(prompts.map((item) => item.split(":", 1)[0]), ["text", "secret"]);
  assert.match(notifications[0] ?? "", /Validating/);
});

test("provider refresh reuses only a fresh catalog for the credential endpoint", async () => {
  const credential: ApiKeyCredential = {
    type: "api_key",
    key: "test-api-key",
    env: { [CLIPROXY_BASE_URL_ENV]: "https://proxy.example" },
  };
  let fetches = 0;
  let stored: Parameters<NonNullable<Parameters<NonNullable<ReturnType<typeof createCliProxyProvider>["refreshModels"]>>[0]["store"]["write"]>>[0] | undefined;
  const provider = createCliProxyProvider({
    now: () => 20_000,
    fetch: async () => {
      fetches++;
      return response(catalog);
    },
  });
  const store = {
    read: async () => stored,
    write: async (value: NonNullable<typeof stored>) => { stored = value; },
    delete: async () => { stored = undefined; },
  };
  await provider.refreshModels?.({ credential, store, allowNetwork: true, force: true });
  assert.equal(fetches, 1);
  assert.equal(provider.getModels()[0]?.id, "gpt-fast");
  await provider.refreshModels?.({ credential, store, allowNetwork: true });
  assert.equal(fetches, 1);

  const otherEndpoint: ApiKeyCredential = {
    ...credential,
    env: { [CLIPROXY_BASE_URL_ENV]: "https://other.example" },
  };
  await provider.refreshModels?.({ credential: otherEndpoint, store, allowNetwork: false });
  assert.deepEqual(provider.getModels(), []);
});

test("offline fallback preserves an already checked catalog for ambient-only auth", async () => {
  const provider = createCliProxyProvider({ fetch: async () => response(catalog) });
  const credential: ApiKeyCredential = {
    type: "api_key",
    key: "ambient-api-key",
    env: { [CLIPROXY_BASE_URL_ENV]: "https://proxy.example" },
  };
  let stored: Awaited<ReturnType<Parameters<NonNullable<typeof provider.refreshModels>>[0]["store"]["read"]>>;
  const store = {
    read: async () => stored,
    write: async (value: NonNullable<typeof stored>) => { stored = value; },
    delete: async () => { stored = undefined; },
  };

  await provider.refreshModels?.({ credential, store, allowNetwork: true, force: true });
  assert.equal(provider.getModels()[0]?.id, "gpt-fast");
  await provider.refreshModels?.({ credential: undefined, store, allowNetwork: false });
  assert.equal(provider.getModels()[0]?.id, "gpt-fast");
});

test("Fast payload injection is exact and leaves non-object payloads unchanged", () => {
  assert.deepEqual(applyCliProxyFastPayload({ model: "gpt-fast", service_tier: "default" }), {
    model: "gpt-fast",
    service_tier: "priority",
  });
  assert.equal(applyCliProxyFastPayload("opaque"), "opaque");
});
