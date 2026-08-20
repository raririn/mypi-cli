import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageEventStream, type Model, type Provider, type ProviderStreams } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CLIPROXY_PROVIDER_ID, mapCliProxyCatalog, resolveCliProxyEndpoints } from "../../src/product/cliproxy-provider-core.ts";
import { CLIPROXY_FAST_ENTRY, registerCliProxyProvider } from "../../src/product/mypi-cliproxy-provider.ts";

type Handler = (event: any, ctx: ExtensionContext) => unknown;

function harness(initialBranch: unknown[] = []) {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, any>();
  const appended: Array<{ customType: string; data: unknown }> = [];
  let provider: Provider | undefined;
  let branch = initialBranch;
  let idle = true;
  const notices: Array<{ message: string; level: string }> = [];
  const ctx = {
    isIdle: () => idle,
    ui: { notify: (message: string, level: string) => notices.push({ message, level }) },
    sessionManager: { getBranch: () => branch },
  } as unknown as ExtensionContext;
  const pi = {
    registerProvider: (value: Provider) => { provider = value; },
    registerCommand: (name: string, command: unknown) => commands.set(name, command),
    appendEntry: (customType: string, data: unknown) => appended.push({ customType, data }),
    on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
  } as unknown as ExtensionAPI;
  return {
    pi,
    ctx,
    handlers,
    commands,
    appended,
    notices,
    provider: () => provider,
    setBranch: (value: unknown[]) => { branch = value; },
    setIdle: (value: boolean) => { idle = value; },
    emit: async (event: string, value: unknown = {}) => {
      for (const handler of handlers.get(event) ?? []) await handler(value, ctx);
    },
  };
}

function model(fastCapable: boolean): Model<"openai-codex-responses"> {
  return mapCliProxyCatalog({ models: [{
    id: fastCapable ? "fast" : "standard",
    supported_reasoning_levels: ["low"],
    service_tiers: fastCapable ? ["priority"] : [],
  }] }, resolveCliProxyEndpoints("https://proxy.example"))[0]!;
}

test("extension registers the native provider and completes /fast arguments", () => {
  const h = harness();
  const streams: ProviderStreams = {
    stream: () => new AssistantMessageEventStream(),
    streamSimple: () => new AssistantMessageEventStream(),
  };
  registerCliProxyProvider(h.pi, { codexStreams: streams });
  assert.equal(h.provider()?.id, CLIPROXY_PROVIDER_ID);
  assert.deepEqual(h.commands.get("fast")?.getArgumentCompletions("o"), [
    { value: "on", label: "on" },
    { value: "off", label: "off" },
  ]);
});

test("Fast is branch-persistent and changes only at the next turn boundary", async () => {
  let seenPayload: unknown;
  const streams: ProviderStreams = {
    stream: () => new AssistantMessageEventStream(),
    streamSimple: (_model, _context, options) => {
      const payload = { model: "fast" };
      if (options?.onPayload) void options.onPayload(payload, model(true)).then((value) => { seenPayload = value; });
      else seenPayload = payload;
      return new AssistantMessageEventStream();
    },
  };
  const h = harness();
  registerCliProxyProvider(h.pi, { codexStreams: streams });
  await h.emit("session_start", { reason: "startup" });
  const command = h.commands.get("fast");
  await command.handler("on", h.ctx);
  assert.deepEqual(h.appended, [{ customType: CLIPROXY_FAST_ENTRY, data: { version: 1, enabled: true } }]);

  h.provider()?.streamSimple(model(true), { systemPrompt: "", messages: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seenPayload, { model: "fast" });

  await h.emit("turn_start");
  h.provider()?.streamSimple(model(true), { systemPrompt: "", messages: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seenPayload, { model: "fast", service_tier: "priority" });

  h.setIdle(false);
  await command.handler("off", h.ctx);
  h.provider()?.streamSimple(model(true), { systemPrompt: "", messages: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seenPayload, { model: "fast", service_tier: "priority" });
  assert.match(h.notices.at(-1)?.message ?? "", /current turn remains on/);

  await h.emit("turn_start");
  h.provider()?.streamSimple(model(true), { systemPrompt: "", messages: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seenPayload, { model: "fast" });
});

test("resume and tree navigation restore the latest Fast choice on the active branch", async () => {
  const h = harness([
    { type: "custom", customType: CLIPROXY_FAST_ENTRY, data: { version: 1, enabled: true } },
    { type: "custom", customType: CLIPROXY_FAST_ENTRY, data: { version: 1, enabled: false } },
  ]);
  registerCliProxyProvider(h.pi, {
    codexStreams: {
      stream: () => new AssistantMessageEventStream(),
      streamSimple: () => new AssistantMessageEventStream(),
    },
  });
  await h.emit("session_start", { reason: "resume" });
  await h.commands.get("fast").handler("status", h.ctx);
  assert.equal(h.notices.at(-1)?.message, "CLIProxyAPI Fast is off.");

  h.setBranch([{ type: "custom", customType: CLIPROXY_FAST_ENTRY, data: { version: 1, enabled: true } }]);
  await h.emit("session_tree", {});
  await h.commands.get("fast").handler("status", h.ctx);
  assert.equal(h.notices.at(-1)?.message, "CLIProxyAPI Fast is on.");
});

test("Fast never modifies catalog-unsupported models", async () => {
  let seenPayload: unknown;
  const h = harness([{ type: "custom", customType: CLIPROXY_FAST_ENTRY, data: { version: 1, enabled: true } }]);
  registerCliProxyProvider(h.pi, {
    codexStreams: {
      stream: () => new AssistantMessageEventStream(),
      streamSimple: (_model, _context, options) => {
        const payload = { model: "standard" };
        if (options?.onPayload) void options.onPayload(payload, model(false)).then((value) => { seenPayload = value; });
        else seenPayload = payload;
        return new AssistantMessageEventStream();
      },
    },
  });
  await h.emit("session_start", { reason: "resume" });
  await h.emit("turn_start");
  h.provider()?.streamSimple(model(false), { systemPrompt: "", messages: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seenPayload, { model: "standard" });
});
