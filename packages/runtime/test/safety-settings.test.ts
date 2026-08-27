import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("safety settings", () => {
	let root: string;
	let agentDir: string;

	beforeEach(() => {
		root = join(tmpdir(), `mypi-safety-settings-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("defaults to Full Access when no old or new preference exists", () => {
		expect(SettingsManager.create(root, agentDir).getDefaultSafetyMode()).toBe("full");
	});

	it("migrates an enabled legacy sandbox preference into the global new-session default", async () => {
		writeFileSync(join(agentDir, "sandbox-config.json"), JSON.stringify({ version: 1, enabled: true }));
		const settings = SettingsManager.create(root, agentDir);
		expect(settings.getDefaultSafetyMode()).toBe("sandbox");
		await settings.flush();

		// The unified config.yaml is the authority for the safety default.
		expect(parse(readFileSync(join(agentDir, "config.yaml"), "utf8"))).toMatchObject({
			shared: { safety: { defaultMode: "sandbox" } },
		});
	});

	it("writes a global preset without mutating the project settings layer", async () => {
		const settings = SettingsManager.create(root, agentDir);
		settings.setDefaultSafetyMode("ask");
		await settings.flush();
		expect(settings.getDefaultSafetyMode()).toBe("ask");
		expect(parse(readFileSync(join(agentDir, "config.yaml"), "utf8"))).toMatchObject({
			shared: { safety: { defaultMode: "ask" } },
		});
	});
});
