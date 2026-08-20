import { describe, expect, it } from "vitest";
import {
	cycleSafetyMode,
	DEFAULT_SAFETY_MODE,
	isTrustedSafetyTool,
	latestSafetySessionState,
	parseSafetyMode,
	safetyModeFooterText,
} from "../src/core/safety-mode.ts";

describe("safety modes", () => {
	it("keeps backward-compatible Full Access as the unset default", () => {
		expect(DEFAULT_SAFETY_MODE).toBe("full");
	});

	it("parses aliases and cycles through the complete ladder", () => {
		expect(parseSafetyMode("sandbox + approval")).toBe("sandbox-ask");
		expect(parseSafetyMode("ask first")).toBe("ask");
		expect(cycleSafetyMode("full")).toBe("safe");
	});

	it("restores the latest session-owned effective and pending values", () => {
		const entries = [
			{ type: "custom", customType: "mypi-safety-mode", data: { version: 1, effective: "safe" } },
			{
				type: "custom",
				customType: "mypi-safety-mode",
				data: { version: 1, effective: "sandbox", pending: "ask" },
			},
		];
		expect(latestSafetySessionState(entries)).toEqual({ version: 1, effective: "sandbox", pending: "ask" });
		expect(safetyModeFooterText("sandbox", "ask")).toBe("? Ask First");
		expect(safetyModeFooterText("safe")).toBe("✓ Safe");
		expect(safetyModeFooterText("sandbox")).toBe("▣ Sandboxed");
		expect(safetyModeFooterText("sandbox-ask")).toBe("◈ Sandbox + Approval");
		expect(safetyModeFooterText("full")).toBe("! Full Access");
	});

	it("accepts web tools only from the exact built-in MyPi core provenance", () => {
		const builtin = { path: "<builtin:mypi-core>", source: "builtin", scope: "temporary", origin: "top-level" } as const;
		expect(isTrustedSafetyTool("web_search", builtin)).toBe(true);
		expect(isTrustedSafetyTool("web_search", { ...builtin, path: "/tmp/spoof.ts", source: "extension" })).toBe(false);
	});

	it("keeps every Goal lifecycle tool only for exact built-in MyPi core provenance", () => {
		const builtin = { path: "<builtin:mypi-core>", source: "builtin", scope: "temporary", origin: "top-level" } as const;
		const goalTools = ["get_goal", "get_goal_plan", "create_goal", "set_goal_plan", "update_goal_plan", "update_goal"];
		for (const name of goalTools) {
			expect(isTrustedSafetyTool(name, builtin), name).toBe(true);
			expect(isTrustedSafetyTool(name, { ...builtin, path: "/tmp/spoof.ts", source: "extension" }), name).toBe(false);
		}
	});
});
