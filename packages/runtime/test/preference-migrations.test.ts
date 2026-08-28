import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { SettingsManager, UnifiedSettingsStorage } from "../src/core/settings-manager.ts";

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

describe("project-scope unified config (.mypi/config.yaml)", () => {
	let root: string;
	let agentDir: string;

	beforeEach(() => {
		root = join(tmpdir(), `mypi-project-unified-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("legacy flat project settings.json stays effective; reading never creates files", () => {
		const projectDir = join(root, ".mypi");
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(join(projectDir, "settings.json"), JSON.stringify({ theme: "project-theme", quietStartup: true }));
		const settings = SettingsManager.create(root, agentDir);
		expect(settings.getThemeSetting()).toBe("project-theme");
		expect(existsSync(join(projectDir, "config.yaml"))).toBe(false);
	});

	it("a project-scoped write routes preferences into .mypi/config.yaml and leaves resource lists in settings.json", () => {
		const projectDir = join(root, ".mypi");
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(join(projectDir, "settings.json"), JSON.stringify({ theme: "old-theme", extensions: ["./ext.ts"] }));
		const storage = new UnifiedSettingsStorage(root, agentDir);
		storage.withLock("project", (current) => {
			const flat = JSON.parse(current ?? "{}") as Record<string, unknown>;
			return JSON.stringify({ ...flat, theme: "new-theme" });
		});
		const config = parse(readFileSync(join(projectDir, "config.yaml"), "utf8")) as Record<string, any>;
		expect(config.cli.theme).toBe("new-theme");
		const registry = JSON.parse(readFileSync(join(projectDir, "settings.json"), "utf8")) as Record<string, unknown>;
		expect(registry.extensions).toEqual(["./ext.ts"]);
		expect("theme" in registry).toBe(false);
		// The unified value wins on the next read.
		const reread = SettingsManager.create(root, agentDir);
		expect(reread.getThemeSetting()).toBe("new-theme");
	});

	it("a registry-only project write does not materialize an empty config.yaml", () => {
		const storage = new UnifiedSettingsStorage(root, agentDir);
		storage.withLock("project", () => JSON.stringify({ extensions: ["./only.ts"] }));
		expect(existsSync(join(root, ".mypi", "config.yaml"))).toBe(false);
		const registry = JSON.parse(readFileSync(join(root, ".mypi", "settings.json"), "utf8")) as Record<string, unknown>;
		expect(registry.extensions).toEqual(["./only.ts"]);
	});
});

describe("changelog stamp rename (pi-core version)", () => {
	let root: string;
	let agentDir: string;

	beforeEach(() => {
		root = join(tmpdir(), `mypi-changelog-stamp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("reads the legacy key and retires it on the next stamp", async () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ lastChangelogVersion: "0.82.1" }));
		const settings = SettingsManager.create(root, agentDir);
		expect(settings.getLastPiCoreChangelogVersion()).toBe("0.82.1");
		settings.setLastPiCoreChangelogVersion("0.83.0");
		await settings.flush();
		const registry = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as Record<string, unknown>;
		expect(registry.lastPiCoreChangelogVersion).toBe("0.83.0");
		expect("lastChangelogVersion" in registry).toBe(false);
	});
});
