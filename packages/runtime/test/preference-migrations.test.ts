import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("legacy preference migrations (websearch-config.json, readonly.json)", () => {
	let root: string;
	let agentDir: string;

	beforeEach(() => {
		root = join(tmpdir(), `mypi-pref-migrations-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("defaults without any legacy files", () => {
		const settings = SettingsManager.create(root, agentDir);
		expect(settings.getWebSearchProvider()).toBe("brave");
		expect(settings.getReadonlyPreference()).toBe("never");
	});

	it("absorbs websearch-config.json into shared.webSearch once", async () => {
		writeFileSync(join(agentDir, "websearch-config.json"), JSON.stringify({ version: 1, provider: "curl" }));
		const settings = SettingsManager.create(root, agentDir);
		expect(settings.getWebSearchProvider()).toBe("curl");
		await settings.flush();
		expect(parse(readFileSync(join(agentDir, "config.yaml"), "utf8"))).toMatchObject({
			shared: { webSearch: { provider: "curl" } },
		});
	});

	it("a configured shared.webSearch beats a stale legacy file", async () => {
		const first = SettingsManager.create(root, agentDir);
		first.setWebSearchProvider("brave");
		await first.flush();
		writeFileSync(join(agentDir, "websearch-config.json"), JSON.stringify({ version: 1, provider: "curl" }));
		expect(SettingsManager.create(root, agentDir).getWebSearchProvider()).toBe("brave");
	});

	it("absorbs readonly.json v2 into shared.readonly", async () => {
		writeFileSync(join(agentDir, "readonly.json"), JSON.stringify({ version: 2, preference: "noread" }));
		const settings = SettingsManager.create(root, agentDir);
		expect(settings.getReadonlyPreference()).toBe("noread");
		await settings.flush();
		expect(parse(readFileSync(join(agentDir, "config.yaml"), "utf8"))).toMatchObject({
			shared: { readonly: { preference: "noread" } },
		});
	});

	it("absorbs readonly.json v1 'always' as the readonly preference", () => {
		writeFileSync(join(agentDir, "readonly.json"), JSON.stringify({ version: 1, preference: "always" }));
		expect(SettingsManager.create(root, agentDir).getReadonlyPreference()).toBe("readonly");
	});

	it("malformed legacy files never wedge creation and fall back to defaults", () => {
		writeFileSync(join(agentDir, "websearch-config.json"), "{nonsense");
		writeFileSync(join(agentDir, "readonly.json"), JSON.stringify({ version: 9, preference: "?" }));
		const settings = SettingsManager.create(root, agentDir);
		expect(settings.getWebSearchProvider()).toBe("brave");
		expect(settings.getReadonlyPreference()).toBe("never");
	});

	it("setters persist to the unified file and round-trip", async () => {
		const settings = SettingsManager.create(root, agentDir);
		settings.setWebSearchProvider("curl");
		settings.setReadonlyPreference("readonly");
		await settings.flush();
		const reread = SettingsManager.create(root, agentDir);
		expect(reread.getWebSearchProvider()).toBe("curl");
		expect(reread.getReadonlyPreference()).toBe("readonly");
	});
});
