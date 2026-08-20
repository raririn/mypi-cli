import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import agentSignalsExtension, {
  AGENT_STATUS_KEY,
  MAX_AGENT_STATUS_LENGTH,
  NOTIFY_USER_TOOL_NAME,
  SET_STATUS_TOOL_NAME,
} from "../../src/product/mypi-agent-signals.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

function createHarness() {
  const eventHandlers = new Map<string, Handler[]>();
  const tools = new Map<string, any>();
  const statusCalls: [string, string | undefined][] = [];
  const notifyCalls: [string, string | undefined][] = [];
  const pi = {
    registerTool(definition: any) {
      tools.set(definition.name, definition);
    },
    on(name: string, handler: Handler) {
      eventHandlers.set(name, [...(eventHandlers.get(name) ?? []), handler]);
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    mode: "rpc",
    hasUI: true,
    ui: {
      setStatus: (key: string, text: string | undefined) => {
        statusCalls.push([key, text]);
      },
      notify: (message: string, level?: string) => {
        notifyCalls.push([message, level]);
      },
    },
  };
  agentSignalsExtension(pi);
  return {
    ctx,
    statusCalls,
    notifyCalls,
    tool: (name: string) => tools.get(name),
    fire: (name: string) => {
      for (const handler of eventHandlers.get(name) ?? []) handler({}, ctx);
    },
  };
}

test("set_status publishes, truncates, and clears the agent status", async () => {
  const harness = createHarness();
  const tool = harness.tool(SET_STATUS_TOOL_NAME);
  assert.ok(tool, "set_status tool registered");

  const set = await tool.execute(
    "call-1",
    { status: "  Running the payment tests  " },
    undefined,
    undefined,
    harness.ctx,
  );
  assert.deepEqual(harness.statusCalls.at(-1), [AGENT_STATUS_KEY, "Running the payment tests"]);
  assert.deepEqual(set.details, { status: "Running the payment tests" });

  const long = "x".repeat(MAX_AGENT_STATUS_LENGTH + 40);
  await tool.execute("call-2", { status: long }, undefined, undefined, harness.ctx);
  assert.equal(harness.statusCalls.at(-1)![1]!.length, MAX_AGENT_STATUS_LENGTH);

  const cleared = await tool.execute("call-3", {}, undefined, undefined, harness.ctx);
  assert.deepEqual(harness.statusCalls.at(-1), [AGENT_STATUS_KEY, undefined]);
  assert.match(cleared.content[0].text, /cleared/i);
  assert.deepEqual(cleared.details, { cleared: true });
});

test("the status never outlives the run or the session", () => {
  const harness = createHarness();
  harness.fire("agent_end");
  assert.deepEqual(harness.statusCalls.at(-1), [AGENT_STATUS_KEY, undefined]);
  harness.fire("session_shutdown");
  assert.deepEqual(harness.statusCalls.at(-1), [AGENT_STATUS_KEY, undefined]);
});

test("notify_user forwards the trimmed message and rejects empties", async () => {
  const harness = createHarness();
  const tool = harness.tool(NOTIFY_USER_TOOL_NAME);
  assert.ok(tool, "notify_user tool registered");

  const result = await tool.execute("call-1", { message: "  Build finished; benchmarks look flat.  " }, undefined, undefined, harness.ctx);
  assert.deepEqual(harness.notifyCalls.at(-1), ["Build finished; benchmarks look flat.", "info"]);
  assert.match(result.content[0].text, /sent/i);
  assert.deepEqual(result.details, { message: "Build finished; benchmarks look flat." });

  await assert.rejects(
    () => tool.execute("call-2", { message: "   " }, undefined, undefined, harness.ctx),
    /non-empty/,
  );
});
