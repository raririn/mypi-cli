import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";
import type { BashOperations } from "../../src/core/tools/bash.ts";
import safetyExtension from "../../src/product/safety.ts";
import { productModules } from "../../src/product/index.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("AgentSession turn-scoped safety", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("keeps a requested change pending until the next user-run boundary", async () => {
		const harness = await createHarness({ settings: { safety: { defaultMode: "safe" } } });
		harnesses.push(harness);
		expect(harness.session.safetyMode).toBe("safe");
		expect(harness.session.getActiveToolNames()).toEqual(["read_workspace", "write_workspace", "commentary"]);
		expect(() => harness.session.requestSafetyMode("invalid" as never)).toThrow(/Invalid safety mode/);

		harness.session.requestSafetyMode("full");
		expect(harness.session.safetyMode).toBe("safe");
		expect(harness.session.pendingSafetyMode).toBe("full");
		expect(harness.session.getActiveToolNames()).toEqual(["read_workspace", "write_workspace", "commentary"]);

		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.prompt("apply on this turn");

		expect(harness.session.safetyMode).toBe("full");
		expect(harness.session.pendingSafetyMode).toBeUndefined();
		expect(harness.session.getActiveToolNames()).toEqual(["read", "bash", "edit", "write", "commentary"]);
		expect(harness.eventsOfType("safety_mode_changed").at(-1)).toMatchObject({ effective: "full" });
	});

	it("hides unknown extension tools in Safe and reveals them in Sandbox + Approval", async () => {
		const harness = await createHarness({
			settings: { safety: { defaultMode: "safe" } },
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "unclassified",
						label: "Unclassified",
						description: "Test extension tool",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					});
				},
			],
		});
		harnesses.push(harness);

		expect(harness.session.getActiveToolNames()).not.toContain("unclassified");
		harness.session.requestSafetyMode("sandbox-ask");
		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.prompt("next turn");
		expect(harness.session.getActiveToolNames()).toContain("unclassified");
	});

	it("keeps provenance-verified set_status available and executable in Safe", async () => {
		const harness = await createHarness({
			settings: { safety: { defaultMode: "safe" } },
			extensionFactories: [productModules.find((module) => module.name === "agent-signals")!],
		});
		harnesses.push(harness);
		expect(harness.session.getActiveToolNames()).toContain("set_status");

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("set_status", { status: "Testing FEAT-070" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("report progress");
		expect(harness.eventsOfType("tool_execution_end").find((event) => event.toolName === "set_status")?.result.details)
			.toEqual({ status: "Testing FEAT-070" });
	});

	it.each([
		{ mode: "safe", bash: false, broadFiles: false, unknown: false },
		{ mode: "sandbox", bash: true, broadFiles: false, unknown: false },
		{ mode: "sandbox-ask", bash: true, broadFiles: false, unknown: true },
		{ mode: "ask", bash: true, broadFiles: true, unknown: true },
		{ mode: "full", bash: true, broadFiles: true, unknown: true },
	] as const)("projects the $mode model tool inventory", async ({ mode, bash, broadFiles, unknown }) => {
		const harness = await createHarness({
			settings: { safety: { defaultMode: mode } },
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "unclassified",
						label: "Unclassified",
						description: "Test extension tool",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					});
				},
			],
		});
		harnesses.push(harness);
		const active = harness.session.getActiveToolNames();
		expect(active.includes("commentary")).toBe(true);
		expect(active.includes("bash")).toBe(bash);
		expect(active.includes("read")).toBe(broadFiles);
		expect(active.includes("write")).toBe(broadFiles);
		expect(active.includes("unclassified")).toBe(unknown);
		expect(active.includes("read_workspace")).toBe(!broadFiles);
		expect(active.includes("write_workspace")).toBe(!broadFiles);
	});

	it.each(["safe", "sandbox", "sandbox-ask", "ask", "full"] as const)(
		"keeps the complete Goal lifecycle tool set in $mode",
		async (mode) => {
			const harness = await createHarness({
				settings: { safety: { defaultMode: mode } },
				extensionFactories: [productModules.find((module) => module.name === "goal")!],
			});
			harnesses.push(harness);
			const active = harness.session.getActiveToolNames();
			for (const name of ["get_goal", "get_goal_plan", "create_goal", "set_goal_plan", "update_goal_plan", "update_goal"]) {
				expect(active, `${name} in ${mode}`).toContain(name);
			}
			harness.session.setActiveToolsByName(["get_goal", "get_goal_plan", "set_goal_plan"]);
			expect(harness.session.getActiveToolNames()).toEqual(["get_goal", "get_goal_plan", "set_goal_plan"]);
		},
	);

	it("persists the initial default and pending selection in session history", async () => {
		const harness = await createHarness({ settings: { safety: { defaultMode: "sandbox" } } });
		harnesses.push(harness);
		harness.session.requestSafetyMode("ask");

		const entries = harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === "mypi-safety-mode");
		expect(entries).toHaveLength(2);
		expect(entries.at(-1)).toMatchObject({
			data: { version: 1, effective: "sandbox", pending: "ask" },
		});
	});

	it("blocks direct shell execution in Safe and custom shell backends in bounded modes", async () => {
		const safeHarness = await createHarness({ settings: { safety: { defaultMode: "safe" } } });
		harnesses.push(safeHarness);
		await expect(safeHarness.session.executeBash("printf 'not run'")).rejects.toThrow(/Safe mode hides shell/);

		let customBackendCalled = false;
		const operations: BashOperations = {
			exec: async () => {
				customBackendCalled = true;
				return { exitCode: 0 };
			},
		};
		const sandboxHarness = await createHarness({ settings: { safety: { defaultMode: "sandbox" } } });
		harnesses.push(sandboxHarness);
		await expect(
			sandboxHarness.session.executeBash("printf 'not run'", undefined, { operations }),
		).rejects.toThrow(/Custom shell operations are unavailable/);
		expect(customBackendCalled).toBe(false);
	});

	it("offers safety and model-aware reasoning argument completions", async () => {
		const harness = await createHarness({ extensionFactories: [safetyExtension] });
		harnesses.push(harness);
		const safety = harness.session.extensionRunner.getCommand("safety");
		const reasoning = harness.session.extensionRunner.getCommand("reasoning");

		expect((await safety?.getArgumentCompletions?.("--global sand"))?.map((item) => item.value)).toEqual([
			"--global sandbox",
			"--global sandbox-ask",
		]);
		expect((await reasoning?.getArgumentCompletions?.(""))?.map((item) => item.value)).toEqual(
			harness.session.getAvailableThinkingLevels(),
		);
		expect(harness.session.extensionRunner.getCommand("sandbox")).toBeUndefined();
	});

	it("projects a selected mode without a safety-change notification", async () => {
		const harness = await createHarness({ extensionFactories: [safetyExtension] });
		harnesses.push(harness);
		const safety = harness.session.extensionRunner.getCommand("safety");
		const notify = vi.fn();
		const setStatus = vi.fn();
		const context = {
			mode: "rpc",
			ui: { notify, setStatus },
		} as unknown as ExtensionContext;

		await safety?.handler("sandbox", context);

		expect(harness.session.pendingSafetyMode).toBe("sandbox");
		expect(notify).not.toHaveBeenCalled();
		expect(setStatus).toHaveBeenLastCalledWith("safety", "▣ Sandboxed");
	});
});
