/*
 * FEAT-087 Phase 3 acceptance suite: schema→TS rendering (R4), exec_code
 * registration, and the tools.mode projection (flat | code | code-only).
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { EXEC_CODE_TOOL_NAME } from "../../src/core/code-mode/exec-code-tool.ts";
import {
	firstSentence,
	renderToolDeclaration,
	renderToolsDeclarationBlock,
} from "../../src/core/code-mode/ts-declarations.ts";
import { createHarness, type Harness } from "./harness.ts";

function textOf(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => (block && typeof block === "object" && (block as { type?: string }).type === "text" ? String((block as { text?: unknown }).text ?? "") : ""))
		.filter(Boolean)
		.join("\n");
}

describe("schema→TS declaration rendering (R4)", () => {
	it("renders realistic tool schemas compactly", () => {
		const read = renderToolDeclaration("read", "Read file contents from the workspace.", {
			type: "object",
			properties: {
				path: { type: "string", description: "Path to the file to read (relative or absolute)" },
				offset: { type: "number", description: "Line number to start reading from (1-indexed)" },
				limit: { type: "number", description: "Maximum number of lines to read" },
			},
			required: ["path"],
		});
		expect(read.degraded).toBe(false);
		expect(read.declaration).toContain("/** Read file contents from the workspace. */");
		expect(read.declaration).toMatch(/read\(args: \{ .*path: string; .*offset\?: number; .*limit\?: number \}\): Promise<ToolResult>;/);
	});

	it("renders enums, unions, arrays and nested objects", () => {
		const rendered = renderToolDeclaration("edit", undefined, {
			type: "object",
			properties: {
				mode: { enum: ["replace", "append"] },
				edits: {
					type: "array",
					items: {
						type: "object",
						properties: { oldText: { type: "string" }, newText: { type: "string" } },
						required: ["oldText", "newText"],
					},
				},
			},
			required: ["edits"],
		});
		expect(rendered.declaration).toContain('mode?: "replace" | "append"');
		expect(rendered.declaration).toContain("edits: ({ oldText: string; newText: string })[]");
	});

	it("degrades pathological schemas to unknown instead of inflating the prompt", () => {
		const cyclic: Record<string, unknown> = {
			type: "object",
			$defs: { node: { type: "object", properties: { next: { $ref: "#/$defs/node" }, value: { type: "string" } } } },
			properties: { root: { $ref: "#/$defs/node" } },
		};
		const rendered = renderToolDeclaration("walker", undefined, cyclic);
		// Cycle bounded: expansion happens a bounded number of times, then unknown.
		expect(rendered.declaration.length).toBeLessThan(2_000);

		const hugeEnum = renderToolDeclaration("langs", undefined, {
			type: "object",
			properties: { lang: { type: "string", enum: Array.from({ length: 200 }, (_v, index) => `lang-${index}`) } },
		});
		expect(hugeEnum.declaration).toContain("lang?: string");

		const bomb: Record<string, unknown> = { type: "object", properties: {} };
		let cursor = bomb;
		for (let index = 0; index < 64; index += 1) {
			const child: Record<string, unknown> = { type: "object", properties: {} };
			(cursor.properties as Record<string, unknown>)[`level${index}`] = child;
			cursor = child;
		}
		const deep = renderToolDeclaration("deep", undefined, bomb);
		expect(deep.declaration).toContain("unknown");
	});

	it("firstSentence compacts descriptions for JSDoc", () => {
		expect(firstSentence("Reads a file. Supports offsets.\nMore detail.")).toBe("Reads a file.");
		expect(firstSentence(`${"x".repeat(400)}`).length).toBeLessThanOrEqual(160);
	});
});

describe("tools.mode projection", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	const echoTool: AgentTool = {
		name: "echo",
		label: "Echo",
		description: "Echo text back. Extra sentence that must not appear in JSDoc.",
		parameters: Type.Object({ text: Type.String({ description: "Text to echo" }) }),
		execute: async (_id, params) => ({
			content: [{ type: "text", text: `echo:${(params as { text: string }).text}` }],
			details: {},
		}),
	};

	it('dev default is "code": exec_code registered ALONGSIDE flat schemas, contract-only description', async () => {
		const harness = await createHarness({ tools: [echoTool] });
		harnesses.push(harness);
		const names = (harness.session.agent.state.tools ?? []).map((tool) => tool.name);
		expect(names).toContain(EXEC_CODE_TOOL_NAME);
		expect(names).toContain("echo");
		const execTool = harness.session.agent.state.tools!.find((tool) => tool.name === EXEC_CODE_TOOL_NAME)!;
		expect(execTool.description).toContain("Execute JavaScript");
		expect(execTool.description).toContain("tools.* mirrors the visible tool list");
		expect(execTool.description).not.toContain("declare const tools");
	});

	it('"code-only" collapses the visible list and embeds declarations; callable surface stays full', async () => {
		const harness = await createHarness({ tools: [echoTool], settings: { tools: { mode: "code-only" } } });
		harnesses.push(harness);
		const names = (harness.session.agent.state.tools ?? []).map((tool) => tool.name);
		expect(names).toContain(EXEC_CODE_TOOL_NAME);
		expect(names).not.toContain("echo");
		const callable = harness.session.listCodeModeTools().map((tool) => tool.name);
		expect(callable).toContain("echo");
		const execTool = harness.session.agent.state.tools!.find((tool) => tool.name === EXEC_CODE_TOOL_NAME)!;
		expect(execTool.description).toContain("declare const tools");
		expect(execTool.description).toContain("echo(args: {");
		expect(execTool.description).toContain("/** Echo text back. */");
	});

	it('"flat" disables code mode entirely', async () => {
		const harness = await createHarness({ tools: [echoTool], settings: { tools: { mode: "flat" } } });
		harnesses.push(harness);
		const names = (harness.session.agent.state.tools ?? []).map((tool) => tool.name);
		expect(names).not.toContain(EXEC_CODE_TOOL_NAME);
		expect(harness.session.listCodeModeTools()).toEqual([]);
	});

	it("end-to-end: the model drives exec_code as a registered tool", async () => {
		const harness = await createHarness({ tools: [echoTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall(EXEC_CODE_TOOL_NAME, {
					code: `const r = await tools.echo({ text: "from-cell" }); text(r.output.toUpperCase());`,
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		const cellResult = harness.session.messages.find((message) => message.role === "toolResult");
		const body = textOf((cellResult as { content?: unknown })?.content);
		expect(body).toContain("Exit: ok");
		expect(body).toContain("ECHO:FROM-CELL");
		// Nested echo emitted tagged events but no context message.
		expect(harness.session.messages.filter((message) => message.role === "toolResult")).toHaveLength(1);
		const nested = harness.events.find(
			(event) => event.type === "tool_execution_start" && (event as { toolName?: string }).toolName === "echo",
		) as { callSource?: string } | undefined;
		expect(nested?.callSource).toBe("code_mode");
	});

	it("R4 benchmark: declarations are ≥60% smaller than JSON schemas for a 20-tool inventory", async () => {
		const manyTools: AgentTool[] = Array.from({ length: 20 }, (_v, index) => ({
			name: `svc_tool_${index}`,
			label: `Service tool ${index}`,
			description: `Performs service operation ${index} against the workspace. Second sentence with more detail that inflates the schema description but not the JSDoc line.`,
			parameters: Type.Object({
				path: Type.String({ description: "Target path for the operation (relative or absolute)" }),
				mode: Type.Optional(Type.Union([Type.Literal("fast"), Type.Literal("safe"), Type.Literal("dry-run")])),
				limit: Type.Optional(Type.Number({ description: "Bound on the number of results returned" })),
				filters: Type.Optional(
					Type.Array(Type.Object({ field: Type.String(), value: Type.String() }), {
						description: "Field/value filters applied before returning results",
					}),
				),
			}),
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		}));
		const harness = await createHarness({ tools: manyTools });
		harnesses.push(harness);
		const inventory = harness.session
			.listCodeModeTools()
			.filter((tool) => tool.name.startsWith("svc_tool_"))
			.map((tool) => {
				const registered = harness.session.agent.state.tools!.find((candidate) => candidate.name === tool.name)!;
				return { name: tool.name, description: tool.description, parameters: registered.parameters };
			});
		expect(inventory).toHaveLength(20);
		// What flat injection ships per tool (name + description + JSON Schema)…
		const flatBytes = Buffer.byteLength(JSON.stringify(inventory), "utf8");
		// …vs the rendered declaration block.
		const rendered = renderToolsDeclarationBlock(
			inventory.map((tool) => ({
				name: tool.name,
				...(tool.description ? { description: tool.description } : {}),
				parametersSchema: tool.parameters,
			})),
		);
		expect(rendered.degradedTools).toEqual([]);
		const reduction = 1 - rendered.bytes / flatBytes;
		expect(reduction).toBeGreaterThanOrEqual(0.6);
	});
});
