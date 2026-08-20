import assert from "node:assert/strict";
import test from "node:test";
import {
  CREDENTIAL_REDACTION_PLACEHOLDERS,
  createAssistantMessageEventStream,
  createModels,
  createProvider,
  redactCredentialPayload,
  withCredentialRedaction,
} from "@earendil-works/pi-ai";
import credentialRedactionExtension, { CREDENTIAL_REDACTION_WARNING } from "../../src/product/mypi-credential-redaction.ts";

const openRouterKey = `sk-or-v1-${"a".repeat(64)}`;
const awsAccessKey = `AKIA${"B".repeat(16)}`;
const awsSessionAccessKey = `ASIA${"C".repeat(16)}`;
const awsSecret = "d".repeat(40);

test("redacts conservative credential patterns without mutating provider input", () => {
  const binary = Buffer.from("image bytes");
  const input = {
    system: `keys: ${openRouterKey} ${awsAccessKey} ${awsSessionAccessKey}`,
    messages: [
      { role: "user", content: `AWS_SECRET_ACCESS_KEY=${awsSecret}` },
      { role: "toolResult", content: [{ type: "text", text: `"SecretAccessKey": "${awsSecret}"` }] },
    ],
    structured: { aws_secret_access_key: awsSecret },
    binary,
  };

  const result = redactCredentialPayload(input);
  assert.equal(result.changed, true);
  assert.deepEqual(new Set(result.kinds), new Set(["openrouter", "awsAccessKeyId", "awsSecretAccessKey"]));
  assert.equal(input.structured.aws_secret_access_key, awsSecret);
  assert.equal((result.value as typeof input).binary, binary);
  const serialized = JSON.stringify(result.value);
  for (const secret of [openRouterKey, awsAccessKey, awsSessionAccessKey, awsSecret]) {
    assert.equal(serialized.includes(secret), false);
  }
  for (const placeholder of Object.values(CREDENTIAL_REDACTION_PLACEHOLDERS)) {
    assert.equal(serialized.includes(placeholder), true);
  }
});

test("leaves near misses and unpaired AWS-secret-shaped values intact", () => {
  const input = {
    shortOpenRouter: `sk-or-v1-${"a".repeat(63)}`,
    lowercaseAws: `AKIA${"b".repeat(16)}`,
    wrongAwsLength: `ASIA${"C".repeat(15)}`,
    unpairedSecret: awsSecret,
    unrelatedField: { checksum: awsSecret },
  };
  const result = redactCredentialPayload(input);
  assert.equal(result.changed, false);
  assert.equal(result.value, input);
});

test("is idempotent and sanitizes replacements from a later payload hook", async () => {
  const first = redactCredentialPayload({ prompt: openRouterKey });
  const second = redactCredentialPayload(first.value);
  assert.equal(second.changed, false);
  assert.equal(second.value, first.value);

  const auth = { apiKey: openRouterKey, headers: { Authorization: awsAccessKey } };
  const options = withCredentialRedaction({
    ...auth,
    onPayload: () => ({ nested: [{ text: openRouterKey }] }),
  });
  const payload = await options.onPayload?.({ safe: true }, {} as never);
  assert.equal(JSON.stringify(payload).includes(openRouterKey), false);
  assert.equal(options.apiKey, auth.apiKey, "provider authentication must remain untouched");
  assert.deepEqual(options.headers, auth.headers, "provider headers must remain untouched");
});

test("enforces the Models boundary before arbitrary provider dispatch without redacting auth", async () => {
  const model = {
    id: "capture-model",
    name: "Capture model",
    api: "capture-api",
    provider: "capture-provider",
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 4096,
    maxTokens: 1024,
  } as const;
  let capturedContext: unknown;
  let capturedOptions: Record<string, unknown> | undefined;
  const capture = (context: unknown, options: Record<string, unknown> | undefined) => {
    capturedContext = context;
    capturedOptions = options;
    const stream = createAssistantMessageEventStream();
    stream.end({
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    return stream;
  };
  const provider = createProvider({
    id: model.provider,
    auth: {
      apiKey: {
        name: "capture",
        resolve: async () => ({ auth: { apiKey: "fallback" }, source: "test" }),
      },
    },
    models: [model],
    api: {
      stream: (_model, context, options) => capture(context, options),
      streamSimple: (_model, context, options) => capture(context, options),
    },
  });
  const models = createModels();
  models.setProvider(provider);

  const originalContext = {
    systemPrompt: `system ${openRouterKey}`,
    messages: [{ role: "user", content: `AWS_ACCESS_KEY_ID=${awsAccessKey}` }],
  } as never;
  await models.complete(model, originalContext, {
    apiKey: openRouterKey,
    headers: { Authorization: `Bearer ${awsAccessKey}` },
  });

  assert.equal(JSON.stringify(capturedContext).includes(openRouterKey), false);
  assert.equal(JSON.stringify(capturedContext).includes(awsAccessKey), false);
  assert.equal(JSON.stringify(originalContext).includes(openRouterKey), true, "local context remains unchanged");
  assert.equal(capturedOptions?.apiKey, openRouterKey, "provider authentication stays byte-for-byte intact");
  assert.deepEqual(capturedOptions?.headers, { Authorization: `Bearer ${awsAccessKey}` });
  assert.equal(typeof capturedOptions?.onPayload, "function", "late provider payloads retain a final guard");
});

test("fails closed on excessive model-bound nesting", () => {
  const root: Record<string, unknown> = {};
  let cursor = root;
  for (let depth = 0; depth < 70; depth++) {
    const next: Record<string, unknown> = {};
    cursor.next = next;
    cursor = next;
  }
  assert.throws(() => redactCredentialPayload(root), /nesting limit/);
});

test("warns once per affected run and returns a sanitized final payload", async () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const pi = {
    on(name: string, handler: (...args: any[]) => unknown) { handlers.set(name, handler); },
  };
  credentialRedactionExtension(pi as never);

  const notices: Array<{ message: string; level: string }> = [];
  const ctx = { ui: { notify: (message: string, level: string) => notices.push({ message, level }) } };
  await handlers.get("before_agent_start")?.({ prompt: openRouterKey, systemPrompt: "safe" }, ctx);
  await handlers.get("context")?.({ messages: [{ role: "toolResult", content: awsAccessKey }] }, ctx);
  const sanitized = await handlers.get("before_provider_request")?.({ payload: { value: awsAccessKey } }, ctx);
  assert.equal(notices.length, 1);
  assert.deepEqual(notices[0], { message: CREDENTIAL_REDACTION_WARNING, level: "warning" });
  assert.equal(JSON.stringify(sanitized).includes(awsAccessKey), false);

  await handlers.get("before_agent_start")?.({ prompt: awsAccessKey, systemPrompt: "safe" }, ctx);
  assert.equal(notices.length, 2, "a later affected run receives one new warning");
});
