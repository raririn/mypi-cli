import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	__resetExecutionModeForTest,
	cycleExecutionMode,
	getExecutionMode,
	isSafeModeActive,
	isSandboxActive,
	onExecutionModeChange,
	setExecutionMode,
} from "../src/core/mypi-exec-mode.ts";
import { saveMyPiSandboxPreference } from "../src/core/mypi-sandbox.ts";

describe("MyPi execution mode", () => {
	let agentDir: string;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "mypi-exec-mode-"));
		previousAgentDir = process.env.MYPI_CODING_AGENT_DIR;
		process.env.MYPI_CODING_AGENT_DIR = agentDir;
		__resetExecutionModeForTest();
	});

	afterEach(() => {
		if (previousAgentDir === undefined) delete process.env.MYPI_CODING_AGENT_DIR;
		else process.env.MYPI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
		__resetExecutionModeForTest();
	});

	it("defaults to off when no global preference is set", () => {
		expect(getExecutionMode()).toBe("off");
		expect(isSandboxActive()).toBe(false);
		expect(isSafeModeActive()).toBe(false);
	});

	it("seeds sandbox from an enabled global preference", () => {
		saveMyPiSandboxPreference(true, agentDir);
		expect(getExecutionMode()).toBe("sandbox");
		expect(isSandboxActive()).toBe(true);
	});

	it("cycles off -> sandbox -> safe -> off and stays mutually exclusive", () => {
		expect(getExecutionMode()).toBe("off");
		expect(cycleExecutionMode()).toBe("sandbox");
		expect(isSandboxActive()).toBe(true);
		expect(isSafeModeActive()).toBe(false);
		expect(cycleExecutionMode()).toBe("safe");
		expect(isSandboxActive()).toBe(false);
		expect(isSafeModeActive()).toBe(true);
		expect(cycleExecutionMode()).toBe("off");
	});

	it("notifies listeners only on an actual change", () => {
		const seen: string[] = [];
		const unsubscribe = onExecutionModeChange((mode) => seen.push(mode));
		setExecutionMode("safe");
		setExecutionMode("safe"); // no-op, no notification
		setExecutionMode("sandbox");
		unsubscribe();
		setExecutionMode("off"); // not observed after unsubscribe
		expect(seen).toEqual(["safe", "sandbox"]);
	});

	it("coerces unknown modes to off", () => {
		// @ts-expect-error exercising the runtime guard
		expect(setExecutionMode("bogus")).toBe("off");
	});
});
