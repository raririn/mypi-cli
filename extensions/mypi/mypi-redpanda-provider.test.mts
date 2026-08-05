import assert from "node:assert/strict";
import test from "node:test";
import {
  REDPANDA_API_BASE_URL,
  REDPANDA_FALLBACK_MODELS,
  REDPANDA_MANIFEST_URL,
  REDPANDA_OAUTH_CLIENT_ID,
  createRedPandaProviderConfig,
  parseRedPandaManifest,
} from "./redpanda-provider-core.ts";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("provider keeps a deduplicated fallback catalog within limit", () => {
  assert.ok(REDPANDA_FALLBACK_MODELS.length > 0 && REDPANDA_FALLBACK_MODELS.length <= 20);
  assert.equal(new Set(REDPANDA_FALLBACK_MODELS.map((model) => model.id)).size, REDPANDA_FALLBACK_MODELS.length);
  assert.equal(REDPANDA_API_BASE_URL, "https://api.whimsicott.com/mypi/v1");
});

test("manifest parser accepts the site contract and rejects catalog overflow", () => {
  const manifest = {
    version: 1,
    provider: { id: "redpanda" },
    models: [REDPANDA_FALLBACK_MODELS[0]],
  };
  assert.deepEqual(parseRedPandaManifest(manifest).map((model) => model.id), ["openai/gpt-latest"]);
  assert.throws(
    () => parseRedPandaManifest({ ...manifest, models: Array.from({ length: 21 }, (_, index) => ({ ...REDPANDA_FALLBACK_MODELS[0], id: `model-${index}` })) }),
    /between 1 and 20/,
  );
});

test("device OAuth reports the code, polls, and retains the refresh token", async () => {
  const requests: Array<{ url: string; body: URLSearchParams }> = [];
  const responses = [
    jsonResponse({
      device_code: "device-secret",
      user_code: "ABCD-1234",
      verification_uri: "https://auth.example/device",
      verification_uri_complete: "https://auth.example/device?code=ABCD-1234",
      expires_in: 900,
      interval: 5,
    }),
    jsonResponse({ error: "authorization_pending" }, 400),
    jsonResponse({ access_token: "oauth-access", refresh_token: "oauth-refresh", expires_in: 600 }),
    jsonResponse({ access_token: "oauth-access-2", expires_in: 600 }),
  ];
  let clock = 10_000;
  const config = createRedPandaProviderConfig({
    now: () => clock,
    sleep: async (milliseconds) => { clock += milliseconds; },
    fetch: async (input, init) => {
      requests.push({ url: String(input), body: new URLSearchParams(String(init?.body ?? "")) });
      const response = responses.shift();
      assert.ok(response);
      return response;
    },
  });
  let shownCode = "";
  const credentials = await config.oauth?.login({
    onAuth: () => undefined,
    onDeviceCode: ({ userCode, verificationUri }) => {
      shownCode = `${userCode} ${verificationUri}`;
    },
    onPrompt: async () => "",
    onSelect: async () => undefined,
    onProgress: () => undefined,
  });
  assert.ok(credentials);
  assert.match(shownCode, /ABCD-1234/);
  assert.equal(credentials.access, "oauth-access");
  assert.equal(credentials.refresh, "oauth-refresh");
  assert.equal(config.oauth?.getApiKey(credentials), "oauth-access");
  assert.equal(requests[0]?.body.get("client_id"), REDPANDA_OAUTH_CLIENT_ID);
  assert.match(requests[0]?.body.get("scope") ?? "", /offline_access/);

  const refreshed = await config.oauth?.refreshToken(credentials);
  assert.equal(refreshed?.access, "oauth-access-2");
  assert.equal(refreshed?.refresh, "oauth-refresh");
});

test("model refresh uses the public manifest and persists the provider-scoped catalog", async () => {
  const writes: unknown[] = [];
  const config = createRedPandaProviderConfig({
    fetch: async (input) => {
      assert.equal(String(input), REDPANDA_MANIFEST_URL);
      return jsonResponse({ version: 1, provider: { id: "redpanda" }, models: [REDPANDA_FALLBACK_MODELS[0]] });
    },
  });
  const models = await config.refreshModels?.({
    allowNetwork: true,
    force: true,
    store: {
      read: async () => undefined,
      write: async (value) => { writes.push(value); },
    },
  });
  assert.deepEqual(models?.map((model) => model.id), ["openai/gpt-latest"]);
  assert.equal(writes.length, 1);
});
