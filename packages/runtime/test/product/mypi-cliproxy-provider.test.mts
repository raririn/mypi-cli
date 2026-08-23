import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageEventStream, type Model, type Provider, type ProviderStreams } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CLIPROXY_PROVIDER_ID, mapCliProxyCatalog, resolveCliProxyEndpoints } from "../../src/product/cliproxy-provider-core.ts";
import { registerCliProxyProvider } from "../../src/product/mypi-cliproxy-provider.ts";
import type { ServiceTier } from "../../src/product/global-config.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

function harness() {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, unknown>();
  let provider: Provider | undefined;
  const ctx = {} as ExtensionContext;
  const pi = {
    registerProvider: (value: Provider) => { provider = value; },
    registerCommand: (name: string, command: unknown) => commands.set(name, command),
    on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
  } as unknown as ExtensionAPI;
  return {
    pi,
    commands,
    provider: () => provider,
    emit: async (event: string) => {
      for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
    },
  };
}

function model(priorityCapable: boolean): Model<"openai-codex-responses"> {
  return mapCliProxyCatalog({ models: [{
    id: priorityCapable ? "priority" : "standard",
    supported_reasoning_levels: ["low"],
    service_tiers: priorityCapable ? ["priority"] : [],
  }] }, resolveCliProxyEndpoints("https://proxy.example"))[0]!;
}

test("extension registers the native provider without a provider-specific /fast command", () => {
  const h = harness();
  const streams: ProviderStreams = {
    stream: () => new AssistantMessageEventStream(),
    streamSimple: () => new AssistantMessageEventStream(),
  };
  registerCliProxyProvider(h.pi, { codexStreams: streams, loadServiceTier: async () => "default" });
  assert.equal(h.provider()?.id, CLIPROXY_PROVIDER_ID);
  assert.equal(h.commands.has("fast"), false);
});

test("provider-neutral priority config applies at turn boundaries to capable models", async () => {
  let tier: ServiceTier = "default";
  let seen: unknown;
  const streams: ProviderStreams = {
    stream: () => new AssistantMessageEventStream(),
    streamSimple: (_model, _context, options) => {
      const payload = { model: "priority" };
      if (options?.onPayload) void options.onPayload(payload, model(true)).then((value) => { seen = value; });
      else seen = payload;
      return new AssistantMessageEventStream();
    },
  };
  const h = harness();
  registerCliProxyProvider(h.pi, { codexStreams: streams, loadServiceTier: async () => tier });
  await h.emit("session_start");
  h.provider()?.streamSimple(model(true), { systemPrompt: "", messages: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, { model: "priority" });

  tier = "priority";
  await h.emit("turn_start");
  h.provider()?.streamSimple(model(true), { systemPrompt: "", messages: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, { model: "priority", service_tier: "priority" });
});

test("priority config never modifies catalog-unsupported models", async () => {
  let seen: unknown;
  const streams: ProviderStreams = {
    stream: () => new AssistantMessageEventStream(),
    streamSimple: (_model, _context, options) => {
      const payload = { model: "standard" };
      if (options?.onPayload) void options.onPayload(payload, model(false)).then((value) => { seen = value; });
      else seen = payload;
      return new AssistantMessageEventStream();
    },
  };
  const h = harness();
  registerCliProxyProvider(h.pi, { codexStreams: streams, loadServiceTier: async () => "priority" });
  await h.emit("turn_start");
  h.provider()?.streamSimple(model(false), { systemPrompt: "", messages: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, { model: "standard" });
});
