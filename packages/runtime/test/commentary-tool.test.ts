import { describe, expect, test } from "vitest";
import {
	allToolNames,
	createAllToolDefinitions,
	createCommentaryToolDefinition,
	normalizeLegacyToolNames,
} from "../src/core/tools/index.ts";
import { createHarness } from "./suite/harness.ts";

describe("commentary tool", () => {
	test("is the sole canonical user-update built-in", () => {
		const definition = createCommentaryToolDefinition();
		const allDefinitions = createAllToolDefinitions(process.cwd()) as Record<string, unknown>;

		expect(definition.name).toBe("commentary");
		expect(definition.label).toBe("commentary");
		expect(definition.description).toContain("user-visible update");
		expect(allToolNames.has("commentary")).toBe(true);
		expect((allDefinitions.commentary as { name?: string }).name).toBe("commentary");
		expect(allDefinitions.deep_thinking).toBeUndefined();
	});

	test("normalizes the former name without exposing duplicate active tools", () => {
		expect(normalizeLegacyToolNames(["read", "deep_thinking", "commentary", "write"])).toEqual([
			"read",
			"commentary",
			"write",
		]);
	});

	test("maps a legacy active-tool selection onto the canonical schema", async () => {
		const harness = await createHarness({ initialActiveToolNames: ["deep_thinking"] });
		try {
			expect(harness.session.getActiveToolNames()).toEqual(["commentary", "exec_code"]);
			expect(harness.session.systemPrompt).toContain("use the `commentary` tool");
			expect(harness.session.systemPrompt).not.toContain("deep_thinking");
		} finally {
			harness.cleanup();
		}
	});
});
