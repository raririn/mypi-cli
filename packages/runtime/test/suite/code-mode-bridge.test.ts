/*
 * FEAT-087 Phase 2 acceptance + pressure suite: the code-mode tool bridge
 * (spec R2/R3) — nested calls run the model path (validation/coercion,
 * beforeToolCall gates, tagged tool_execution_* events), results stay out of
 * model context, and the host-side parallel() primitive honors per-tool
 * execution modes.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { buildCodeModeBridge, normalizeCodeModeIdentifier, type CodeModeToolExecutor } from "../../src/core/code-mode/bridge.ts";
import { runCodeCell } from "../../src/core/code-mode/isolate.ts";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { createHarness, type Harness } from "./harness.ts";

function textOf(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => (block && typeof block === "object" && (block as { type?: string }).type === "text" ? String((block as { text?: unknown }).text ?? "") : ""))
		.filter(Boolean)
		.join("\n");
}

/** What Phase 3's exec_code tool will do: session → executor → bridge. */
function sessionExecutor(session: AgentSession, parentToolCallId: string): CodeModeToolExecutor {
	return {
		listTools: () => session.listCodeModeTools(),
		execute: async (name, args, signal) => {
			const outcome = await session.executeToolForCodeMode(name, args, { parentToolCallId, signal });
			return {
				output: textOf(outcome.message.content),
				details: outcome.message.details,
				isError: outcome.isError,
			};
		},
	};
}

/** Tool that runs a code cell against the live session — the Phase 3 shape. */
function makeRunCellTool(getSession: () => AgentSession, log: { events: unknown[] }): AgentTool {
	return {
		name: "run_cell",
		label: "Run cell",
		description: "Execute JavaScript with tools",
		parameters: Type.Object({ code: Type.String() }),
		executionMode: "sequential",
		execute: async (toolCallId, params) => {
			const session = getSession();
			const bridge = buildCodeModeBridge(sessionExecutor(session, toolCallId));
			const result = await runCodeCell((params as { code: string }).code, { tools: bridge.tools, timeoutMs: 10_000 });
			log.events.push({ cell: result.status });
			return {
				content: [{ type: "text", text: result.emitted.map((item) => item.text).join("\n") || `status:${result.status}${result.error ? `:${result.error.message}` : ""}` }],
				details: { status: result.status },
			};
		},
	};
}

describe("code-mode bridge (Phase 2)", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function driveCell(code: string, extraTools: AgentTool[], gate?: (harness: Harness) => void) {
		const log = { events: [] as unknown[] };
		let sessionRef: AgentSession | null = null;
		const harness = await createHarness({ tools: [...extraTools, makeRunCellTool(() => sessionRef!, log)] });
		harnesses.push(harness);
		sessionRef = harness.session;
		gate?.(harness);
		const seen: { type: string; toolName?: string; callSource?: string; parentToolCallId?: string; toolCallId?: string }[] = [];
		const unsubscribe = harness.session.subscribe(async (event) => {
			const record = event as { type: string; toolName?: string; callSource?: string; parentToolCallId?: string; toolCallId?: string };
			if (record.type.startsWith("tool_execution")) seen.push(record);
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("run_cell", { code }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		unsubscribe();
		return { harness, seen };
	}

	it("R2/R3: nested calls execute real tools with schema coercion and tagged events", async () => {
		const received: unknown[] = [];
		const doubler: AgentTool = {
			name: "double",
			label: "Double",
			description: "Doubles a number",
			parameters: Type.Object({ value: Type.Number() }),
			execute: async (_id, params) => {
				received.push((params as { value: unknown }).value);
				return { content: [{ type: "text", text: String((params as { value: number }).value * 2) }], details: {} };
			},
		};
		const { harness, seen } = await driveCell(
			// "21" as a string: the model-path validator must coerce it.
			`const r = await tools.double({ value: "21" }); text("got:" + r.output);`,
			[doubler],
		);

		expect(received).toEqual([21]);
		const cellResult = harness.session.messages.find((message) => message.role === "toolResult");
		expect(textOf((cellResult as { content?: unknown })?.content)).toBe("got:42");
		// Model context contains ONLY the outer cell's toolResult — the nested
		// double call never becomes a context message.
		expect(harness.session.messages.filter((message) => message.role === "toolResult")).toHaveLength(1);

		const nestedStart = seen.find((event) => event.type === "tool_execution_start" && event.toolName === "double");
		const nestedEnd = seen.find((event) => event.type === "tool_execution_end" && event.toolName === "double");
		const outerStart = seen.find((event) => event.type === "tool_execution_start" && event.toolName === "run_cell");
		expect(nestedStart?.callSource).toBe("code_mode");
		expect(nestedEnd?.callSource).toBe("code_mode");
		expect(nestedStart?.parentToolCallId).toBe(outerStart?.toolCallId);
		expect(outerStart?.callSource).toBeUndefined();
	});

	it("R3: beforeToolCall gates (extension tool_call handlers) block nested calls with a catchable error", async () => {
		const forbidden: AgentTool = {
			name: "forbidden_op",
			label: "Forbidden",
			description: "Always blocked by policy",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "should never run" }], details: {} }),
		};
		const { harness } = await driveCell(
			`
			try {
				await tools.forbidden_op({});
				text("ran");
			} catch (error) {
				text("blocked:" + error.message);
			}
			`,
			[forbidden],
			(h) => {
				h.session.agent.beforeToolCall = (async (context: { toolCall: { name: string } }) => {
					if (context.toolCall.name === "forbidden_op") return { block: true, reason: "Denied by policy gate." };
					return undefined;
				}) as typeof h.session.agent.beforeToolCall;
			},
		);
		const cellResult = harness.session.messages.find((message) => message.role === "toolResult");
		expect(textOf((cellResult as { content?: unknown })?.content)).toContain("blocked:");
		expect(textOf((cellResult as { content?: unknown })?.content)).toContain("Denied by policy gate.");
	});

	it("R3: invalid nested arguments are rejected by the model-path validator", async () => {
		const strict: AgentTool = {
			name: "strict_tool",
			label: "Strict",
			description: "Requires a string",
			parameters: Type.Object({ path: Type.String() }),
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		};
		const { harness } = await driveCell(
			`
			try {
				await tools.strict_tool({ wrong_field: 1 });
				text("ran");
			} catch (error) {
				text("invalid:" + error.name);
			}
			`,
			[strict],
		);
		const cellResult = harness.session.messages.find((message) => message.role === "toolResult");
		expect(textOf((cellResult as { content?: unknown })?.content)).toContain("invalid:ToolError");
	});

	it("parallel(): parallel-safe tools overlap; a sequential tool serializes the batch", async () => {
		const timeline: string[] = [];
		const makeTimed = (name: string, mode: "sequential" | undefined): AgentTool => ({
			name,
			label: name,
			description: `${name} timed`,
			parameters: Type.Object({}),
			...(mode ? { executionMode: mode } : {}),
			execute: async () => {
				timeline.push(`${name}:start`);
				await new Promise((resolvePromise) => setTimeout(resolvePromise, 60));
				timeline.push(`${name}:end`);
				return { content: [{ type: "text", text: name }], details: {} };
			},
		});
		const { harness } = await driveCell(
			`
			const par = await parallel([{ tool: "p_one" }, { tool: "p_two" }]);
			const seq = await parallel([{ tool: "p_one" }, { tool: "s_one" }]);
			text(JSON.stringify({ par: par.map(r => r.ok), seq: seq.map(r => r.ok) }));
			`,
			[makeTimed("p_one", undefined), makeTimed("p_two", undefined), makeTimed("s_one", "sequential")],
		);
		const cellResult = harness.session.messages.find((message) => message.role === "toolResult");
		expect(textOf((cellResult as { content?: unknown })?.content)).toContain('{"par":[true,true],"seq":[true,true]}');
		// Concurrent batch interleaves; sequential batch strictly orders.
		const parSlice = timeline.slice(0, 4);
		expect(parSlice[0]).toBe("p_one:start");
		expect(parSlice[1]).toBe("p_two:start"); // overlap: second starts before first ends
		const seqSlice = timeline.slice(4);
		expect(seqSlice).toEqual(["p_one:start", "p_one:end", "s_one:start", "s_one:end"]);
	});

	it("parallel(): item failures are item results, not batch failures", async () => {
		const okTool: AgentTool = {
			name: "ok_tool",
			label: "ok",
			description: "succeeds",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "fine" }], details: {} }),
		};
		const badTool: AgentTool = {
			name: "bad_tool",
			label: "bad",
			description: "fails",
			parameters: Type.Object({}),
			execute: async () => {
				throw new Error("boom");
			},
		};
		const { harness } = await driveCell(
			`
			const results = await parallel([{ tool: "bad_tool" }, { tool: "ok_tool" }]);
			text(JSON.stringify(results.map(r => r.ok ? r.output : "ERR:" + r.error)));
			`,
			[okTool, badTool],
		);
		const cellResult = harness.session.messages.find((message) => message.role === "toolResult");
		const body = textOf((cellResult as { content?: unknown })?.content);
		expect(body).toContain("ERR:");
		expect(body).toContain("fine");
	});

	it("abort: user abort mid-cell unwinds the nested call and the run ends aborted", async () => {
		let sessionRef: AgentSession | null = null;
		const log = { events: [] as unknown[] };
		const hanging: AgentTool = {
			name: "hang_tool",
			label: "hang",
			description: "waits for signal",
			parameters: Type.Object({}),
			execute: async (_id, _params, signal) =>
				new Promise((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(new Error("aborted by user")), { once: true });
				}),
		};
		const harness = await createHarness({ tools: [hanging, makeRunCellTool(() => sessionRef!, log)] });
		harnesses.push(harness);
		sessionRef = harness.session;
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("run_cell", { code: `await tools.hang_tool({}); text("never");` }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const run = harness.session.prompt("go");
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
		harness.session.abort();
		await run;
		// The cell completed with an error (nested call unwound); no hang.
		expect(log.events.length).toBe(1);
	});
});

describe("code-mode bridge unit behavior", () => {
	it("normalizes identifiers and fails loudly on collisions", () => {
		expect(normalizeCodeModeIdentifier("mcp_srv_tool")).toBe("mcp_srv_tool");
		expect(normalizeCodeModeIdentifier("weird-name.v2")).toBe("weird_name_v2");
		expect(normalizeCodeModeIdentifier("1st")).toBe("_1st");
		const executor: CodeModeToolExecutor = {
			listTools: () => [{ name: "a-b" }, { name: "a.b" }],
			execute: async () => ({ output: "", isError: false }),
		};
		expect(() => buildCodeModeBridge(executor)).toThrow(/collision/);
	});

	it("sanitizes non-JSON-serializable details instead of crashing the cell", async () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		const executor: CodeModeToolExecutor = {
			listTools: () => [{ name: "weird" }],
			execute: async () => ({ output: "ok", details: cyclic, isError: false }),
		};
		const bridge = buildCodeModeBridge(executor);
		const result = await runCodeCell(`const r = await tools.weird({}); text(r.output + ":" + (r.details === undefined));`, {
			tools: bridge.tools,
		});
		expect(result.status).toBe("ok");
		expect(result.emitted[0]?.text).toBe("ok:true");
	});

	it("exposes ALL_TOOLS metadata with normalized names", () => {
		const executor: CodeModeToolExecutor = {
			listTools: () => [{ name: "read", description: "Read a file" }, { name: "weird-name", description: "odd" }],
			execute: async () => ({ output: "", isError: false }),
		};
		const bridge = buildCodeModeBridge(executor);
		expect(bridge.allTools).toEqual([
			{ name: "read", description: "Read a file" },
			{ name: "weird_name", description: "odd" },
		]);
	});
});
