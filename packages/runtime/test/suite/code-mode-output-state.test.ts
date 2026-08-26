/*
 * FEAT-087 Phase 4 acceptance suite: output/state + audit split (R5, R8) —
 * nested results persist as transcript audit entries but never enter model
 * context; nested outputs are bounded before crossing the membrane; the
 * scratchpad survives across exec_code calls in one session.
 */
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { EXEC_CODE_TOOL_NAME } from "../../src/core/code-mode/exec-code-tool.ts";
import { createHarness, type Harness } from "./harness.ts";

function textOf(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => (block && typeof block === "object" && (block as { type?: string }).type === "text" ? String((block as { text?: unknown }).text ?? "") : ""))
		.filter(Boolean)
		.join("\n");
}

const bigTool: AgentTool = {
	name: "big_output",
	label: "Big",
	description: "Returns a huge payload",
	parameters: Type.Object({}),
	execute: async () => ({
		content: [{ type: "text", text: "y".repeat(1024 * 1024) }],
		details: {},
	}),
};

describe("code-mode output/state (Phase 4)", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function runCell(harness: Harness, code: string) {
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall(EXEC_CODE_TOOL_NAME, { code }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
	}

	it("R5/audit: nested calls persist as custom transcript entries, not context messages", async () => {
		const harness = await createHarness({
			tools: [
				{
					name: "probe",
					label: "Probe",
					description: "probe",
					parameters: Type.Object({ value: Type.Number() }),
					execute: async (_id, params) => ({
						content: [{ type: "text", text: `probe:${(params as { value: number }).value}` }],
						details: {},
					}),
				},
			],
		});
		harnesses.push(harness);
		await runCell(harness, `const r = await tools.probe({ value: 7 }); text("saw:" + r.output);`);

		// Context: exactly one toolResult (the exec_code cell).
		expect(harness.session.messages.filter((message) => message.role === "toolResult")).toHaveLength(1);
		// Transcript: the nested call is a durable custom audit entry.
		const entries = harness.sessionManager.getEntries() as { type?: string; customType?: string; data?: unknown }[];
		const audit = entries.filter((entry) => entry.customType === "mypi-code-mode-call");
		expect(audit).toHaveLength(1);
		const record = audit[0]!.data as { toolName: string; output: string; parentToolCallId: string; isError: boolean };
		expect(record.toolName).toBe("probe");
		expect(record.output).toBe("probe:7");
		expect(record.isError).toBe(false);
		expect(record.parentToolCallId).toBeTruthy();
	});

	it("R5: nested outputs are bounded before crossing the membrane; audit stays bounded too", async () => {
		const harness = await createHarness({ tools: [bigTool] });
		harnesses.push(harness);
		await runCell(harness, `const r = await tools.big_output({}); text("len:" + r.output.length + ":" + (r.output.includes("truncated by code mode") ? "cut" : "full"));`);
		const cellResult = harness.session.messages.find((message) => message.role === "toolResult");
		const body = textOf((cellResult as { content?: unknown })?.content);
		expect(body).toContain("Exit: ok");
		expect(body).toContain(":cut");
		const entries = harness.sessionManager.getEntries() as { customType?: string; data?: unknown }[];
		const audit = entries.find((entry) => entry.customType === "mypi-code-mode-call")!;
		expect(Buffer.byteLength((audit.data as { output: string }).output, "utf8")).toBeLessThan(20_000);
	});

	it("R8: the scratchpad persists across exec_code calls within the session", async () => {
		const harness = await createHarness({ tools: [] });
		harnesses.push(harness);
		await runCell(harness, `store("plan", { files: ["a.ts", "b.ts"] }); text("stored");`);
		await runCell(harness, `const plan = load("plan"); text("loaded:" + plan.files.join("+"));`);
		const results = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(textOf((results.at(-1) as { content?: unknown })?.content)).toContain("loaded:a.ts+b.ts");
	});

	it("R5: exec_code aggregate output honors max_output_tokens", async () => {
		const harness = await createHarness({ tools: [] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall(EXEC_CODE_TOOL_NAME, {
					code: `try { for (let i = 0; i < 10_000; i += 1) text("x".repeat(100)); } catch (e) { /* budget hit */ }`,
					max_output_tokens: 100,
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		const cellResult = harness.session.messages.find((message) => message.role === "toolResult");
		const body = textOf((cellResult as { content?: unknown })?.content);
		expect(Buffer.byteLength(body, "utf8")).toBeLessThan(10_000);
	});
});
