import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import safemodeExtension from "./mypi-safemode.ts";

type Handler = (event: any, ctx: any) => unknown;

function harness() {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, any>();
  const tools = [
    { name: "read", sourceInfo: { path: "<builtin:read>", source: "builtin", scope: "temporary", origin: "top-level" } },
    { name: "write", sourceInfo: { path: "<builtin:write>", source: "builtin", scope: "temporary", origin: "top-level" } },
    { name: "web_search", sourceInfo: { path: "<builtin:mypi-core>", source: "builtin", scope: "temporary", origin: "top-level" } },
    { name: "web_fetch", sourceInfo: { path: "<builtin:mypi-core>", source: "builtin", scope: "temporary", origin: "top-level" } },
  ];
  let selections = 0;
  const pi = {
    registerCommand(name: string, command: any) { commands.set(name, command); },
    on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    getAllTools() { return tools; },
    events: { emit() {} },
  } as unknown as ExtensionAPI;
  const ctx = {
    hasUI: true,
    abort() {},
    ui: {
      setStatus() {},
      notify() {},
      editor: async () => undefined,
      select: async () => { selections += 1; return "Approve"; },
    },
  };
  safemodeExtension(pi);
  return {
    commands,
    ctx,
    tools,
    get selections() { return selections; },
    async emit(name: string, event: unknown) {
      let result: unknown;
      for (const handler of handlers.get(name) ?? []) {
        const next = await handler(event, ctx);
        if (next !== undefined) result = next;
      }
      return result;
    },
  };
}

test("safe mode allows provenance-verified web reads but still gates mutations and spoofed tools", async () => {
  const h = harness();
  await h.commands.get("safemode").handler("on", h.ctx);
  assert.equal(await h.emit("tool_call", { toolName: "web_search", input: { query: "news" } }), undefined);
  assert.equal(await h.emit("tool_call", { toolName: "web_fetch", input: { url: "https://example.com" } }), undefined);
  assert.equal(h.selections, 0);

  await h.emit("tool_call", { toolName: "write", input: { path: "x" } });
  assert.equal(h.selections, 1);

  const web = h.tools.find((tool) => tool.name === "web_search")!;
  web.sourceInfo = { path: "<sdk:web_search>", source: "sdk", scope: "temporary", origin: "top-level" };
  await h.emit("tool_call", { toolName: "web_search", input: { query: "spoof" } });
  assert.equal(h.selections, 2);
});
