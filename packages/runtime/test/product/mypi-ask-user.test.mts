import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GUI_CONTROL_STATE_EVENT } from "../../src/product/gui-control/events.ts";
import askUserExtension, { ASK_USER_TOOL_NAME } from "../../src/product/mypi-ask-user.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

const params = {
  question: "Which implementation should we use?",
  options: [
    { label: "Small patch", description: "Change only the extension" },
    { label: "Shared protocol", description: "Add a cross-surface request" },
    { label: "Defer", description: "Keep the current behavior" },
  ],
  recommendedOption: 1,
};

function createHarness(options: {
  mode?: "tui" | "rpc" | "json" | "print";
  hasUI?: boolean;
  select?: (...args: any[]) => Promise<string | undefined>;
  input?: (...args: any[]) => Promise<string | undefined>;
} = {}) {
  const eventHandlers = new Map<string, Handler[]>();
  const busHandlers = new Map<string, Handler[]>();
  let tool: any;
  const selectCalls: any[][] = [];
  const inputCalls: any[][] = [];
  const pi = {
    registerTool(definition: any) { tool = definition; },
    on(name: string, handler: Handler) {
      eventHandlers.set(name, [...(eventHandlers.get(name) ?? []), handler]);
    },
    events: {
      on(name: string, handler: Handler) {
        busHandlers.set(name, [...(busHandlers.get(name) ?? []), handler]);
      },
      emit(name: string, event: unknown) {
        for (const handler of busHandlers.get(name) ?? []) handler(event, undefined);
      },
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    mode: options.mode ?? "rpc",
    hasUI: options.hasUI ?? true,
    ui: {
      select: async (...args: any[]) => {
        selectCalls.push(args);
        return options.select ? options.select(...args) : args[1][0];
      },
      input: async (...args: any[]) => {
        inputCalls.push(args);
        return options.input ? options.input(...args) : "custom response";
      },
    },
  };
  askUserExtension(pi);
  return {
    ctx,
    get tool() { return tool; },
    selectCalls,
    inputCalls,
    emitBus(name: string, event: unknown) { (pi.events as any).emit(name, event); },
    async emit(name: string, event: unknown = {}) {
      let result: unknown;
      for (const handler of eventHandlers.get(name) ?? []) {
        const next = await handler(event, ctx);
        if (next !== undefined) result = next;
      }
      return result;
    },
  };
}

async function execute(harness: ReturnType<typeof createHarness>, signal = new AbortController().signal) {
  return harness.tool.execute("ask-1", params, signal, undefined, harness.ctx);
}

test("registers a sequential tool whose schema requires three options and one recommendation", () => {
  const harness = createHarness();
  assert.equal(harness.tool.name, ASK_USER_TOOL_NAME);
  assert.equal(harness.tool.executionMode, "sequential");
  assert.equal(harness.tool.parameters.properties.options.minItems, 3);
  assert.equal(harness.tool.parameters.properties.options.maxItems, 3);
  assert.equal(harness.tool.parameters.properties.recommendedOption.minimum, 1);
  assert.equal(harness.tool.parameters.properties.recommendedOption.maximum, 3);
  assert.match(harness.tool.description, /exactly three/i);
  assert.match(harness.tool.promptGuidelines.join("\n"), /by itself/i);
});

test("keeps execution pending until the user selects and marks the recommendation", async () => {
  let resolveSelection!: (value: string) => void;
  const harness = createHarness({
    select: () => new Promise((resolve) => { resolveSelection = resolve; }),
  });
  const signal = new AbortController().signal;
  let settled = false;
  const pending = execute(harness, signal).then((result: any) => {
    settled = true;
    return result;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(harness.selectCalls.length, 1);
  assert.equal(harness.selectCalls[0][0], params.question);
  assert.deepEqual(harness.selectCalls[0][1], [
    "1. Small patch (Recommended) — Change only the extension",
    "2. Shared protocol — Add a cross-surface request",
    "3. Defer — Keep the current behavior",
    "4. Other — Type any response",
  ]);
  assert.equal(harness.selectCalls[0][2].signal, signal);

  resolveSelection(harness.selectCalls[0][1][1]);
  const result = await pending;
  assert.equal(result.content[0].text, "User selected 2. Shared protocol");
  assert.equal(result.details.selectedOption, 2);
  assert.equal(result.details.custom, false);
  assert.equal(result.terminate, undefined);
});

test("lets Other accept unrestricted text through an abort-aware input dialog", async () => {
  const signal = new AbortController().signal;
  const harness = createHarness({
    select: async (_title, choices) => choices[3],
    input: async () => "Combine the first two approaches",
  });
  const result = await execute(harness, signal);
  assert.equal(harness.inputCalls.length, 1);
  assert.equal(harness.inputCalls[0][0], params.question);
  assert.equal(harness.inputCalls[0][1], "Type any response");
  assert.equal(harness.inputCalls[0][2].signal, signal);
  assert.equal(result.content[0].text, "User wrote: Combine the first two approaches");
  assert.equal(result.details.custom, true);
});

test("cancellation and missing UI terminate without guessing", async () => {
  const cancelled = createHarness({ select: async () => undefined });
  const cancelledResult = await execute(cancelled);
  assert.equal(cancelledResult.details.cancelled, true);
  assert.equal(cancelledResult.terminate, true);

  const headless = createHarness({ mode: "print", hasUI: false });
  const headlessResult = await execute(headless);
  assert.equal(headless.selectCalls.length, 0);
  assert.equal(headlessResult.details.mode, "unavailable");
  assert.equal(headlessResult.terminate, true);
});

test("a connected TUI GUI mirror prints all choices and settles for a free-form reply", async () => {
  const harness = createHarness({ mode: "tui" });
  harness.emitBus(GUI_CONTROL_STATE_EVENT, { state: "connected", connected: true });
  const result = await execute(harness);
  assert.equal(harness.selectCalls.length, 0);
  assert.equal(result.details.mode, "bridged-freeform");
  assert.equal(result.details.waitingForUserReply, true);
  assert.equal(result.terminate, undefined);
  assert.match(result.content[0].text, /In your next assistant response, print the following question and choices verbatim/);
  assert.ok(result.content[0].text.includes([
    "Which implementation should we use?",
    "",
    "1. Small patch (Recommended) — Change only the extension",
    "2. Shared protocol — Add a cross-surface request",
    "3. Defer — Keep the current behavior",
    "",
    "Reply with 1, 2, or 3, or type any other direction.",
  ].join("\n")));
  assert.deepEqual(await harness.emit("tool_call", { toolName: "write" }), {
    block: true,
    reason: "A bridged question is waiting for the user's reply; print the choices and stop without calling tools.",
  });
  await harness.emit("input", { source: "extension", text: "Use option 1 with changes" });
  assert.equal(await harness.emit("tool_call", { toolName: "write" }), undefined);

  harness.emitBus(GUI_CONTROL_STATE_EVENT, { state: "backoff", connected: false });
  await execute(harness);
  assert.equal(harness.selectCalls.length, 1);
});

test("session replacement clears stale bridge state", async () => {
  const harness = createHarness({ mode: "tui" });
  harness.emitBus(GUI_CONTROL_STATE_EVENT, { state: "connected", connected: true });
  await harness.emit("session_start");
  await execute(harness);
  assert.equal(harness.selectCalls.length, 1);
});
