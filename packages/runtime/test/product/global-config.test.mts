import assert from "node:assert/strict";
import { chmod, lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { parse } from "yaml";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import globalConfigExtension from "../../src/product/global-config.ts";
import sessionMaintenanceExtension from "../../src/product/session-maintenance.ts";
import {
  DEFAULT_GLOBAL_CONFIG,
	loadConfiguredServiceTier,
	loadGlobalConfig,
	migrateGuiConfig,
  resetGlobalConfig,
	updateAdvisorModel,
	updateDefaultModel,
	updateSubagentRequirement,
	updateHistoryConfig,
	updateGlobalConfigField,
	updateServiceTier,
	resolveConfiguredDefaultModel,
} from "../../src/product/global-config.ts";

test("global YAML config defaults without creating a file and preserves unrelated configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "mypi-global-config-"));
  const path = join(root, "config.yaml");
  try {
    const missing = await loadGlobalConfig(path);
    assert.deepEqual(missing.config, DEFAULT_GLOBAL_CONFIG);
	assert.equal(missing.defaultModelConfigured, false);
    await assert.rejects(lstat(path), (error: NodeJS.ErrnoException) => error.code === "ENOENT");

    await writeFile(path, `version: 1\nfuture:\n  enabled: true\nhistory:\n  maxActive: 17\n`, { mode: 0o600 });
    const updated = await updateHistoryConfig("maxArchived", 23, path);
    assert.equal(updated.history.maxActive, 17);
    assert.equal(updated.history.maxArchived, 23);
	assert.deepEqual(updated.tracking, {
		maxSessionCheckpoints: 3,
		maxDetachedCheckpoints: 1,
		warningFiles: 10_000,
		warningBytes: 1024 * 1024 * 1024,
	});
    const source = parse(await readFile(path, "utf8"));
    assert.deepEqual(source.future, { enabled: true });
    assert.equal(source.history.maxActive, 17);
    assert.equal(source.history.maxArchived, 23);
	const tierUpdate = updateServiceTier("priority", path);
	assert.equal(await loadConfiguredServiceTier(path), "priority", "turn-boundary read waits for an in-flight settings write");
	const tier = await tierUpdate;
	assert.equal(tier.serviceTier, "priority");
	assert.equal(parse(await readFile(path, "utf8")).serviceTier, "priority");
	await updateAdvisorModel("anthropic/claude-haiku-4-5", path);
	await updateDefaultModel("openai/gpt-5.5", path);
	await updateSubagentRequirement("requireAdvisor", true, path);
	const advisor = await loadGlobalConfig(path);
	assert.equal(advisor.config.subagents.advisorModel, "anthropic/claude-haiku-4-5");
	assert.equal(advisor.config.subagents.requireAdvisor, true);
	assert.equal(advisor.config.subagents.requireReviewer, false);
	assert.equal(advisor.config.defaultModel, "openai/gpt-5.5");
	assert.equal(advisor.defaultModelConfigured, true);
	assert.deepEqual(parse(await readFile(path, "utf8")).future, { enabled: true });
    if (process.platform !== "win32") assert.equal((await lstat(path)).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy settings model migrates once while explicit config null remains authoritative", async () => {
  const root = await mkdtemp(join(tmpdir(), "mypi-global-config-model-"));
  const path = join(root, "config.yaml");
  try {
    assert.equal(await resolveConfiguredDefaultModel({
      path,
      legacyProvider: "anthropic",
      legacyModelId: "claude-sonnet",
    }), "anthropic/claude-sonnet");
    assert.equal(parse(await readFile(path, "utf8")).defaultModel, "anthropic/claude-sonnet");

    await updateDefaultModel(null, path);
    assert.equal(await resolveConfiguredDefaultModel({
      path,
      legacyProvider: "openai",
      legacyModelId: "gpt-5.5",
    }), null);
    assert.equal(parse(await readFile(path, "utf8")).defaultModel, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed, unsupported, and partially invalid YAML use complete defaults and warn", async () => {
  const root = await mkdtemp(join(tmpdir(), "mypi-global-config-invalid-"));
  const path = join(root, "config.yaml");
  try {
    for (const content of [
      "version: 1\nhistory: [\n",
      "version: 99\nhistory:\n  maxActive: 42\n",
      "version: 1\nhistory:\n  maxActive: 42\n  maxArchived: zero\n",
	  "version: 1\nhistory:\n  maxActive: 42\nsubagents:\n  advisorModel: invalid\n",
      "version: 1\nhistory:\n  maxActive: 42\nsubagents:\n  requireAdvisor: yes\n",
	  "version: 1\nserviceTier: fastest\n",
	  "version: 1\ndefaultModel: provider-only\n",
	  "version: 1\ntracking:\n  maxSessionCheckpoints: 2\n  maxDetachedCheckpoints: 3\n",
      `version: 1\nfuture: ${"x".repeat(1024 * 1024)}\n`,
    ]) {
      await writeFile(path, content, { mode: 0o600 });
      const loaded = await loadGlobalConfig(path);
      assert.deepEqual(loaded.config, DEFAULT_GLOBAL_CONFIG);
      assert.ok(loaded.diagnostic);
      await assert.rejects(updateHistoryConfig("maxActive", 12, path), /not changed|malformed|invalid|unsupported/i);
      assert.equal(await readFile(path, "utf8"), content, "invalid source remains byte-identical");
    }
    const reset = await resetGlobalConfig(path);
    assert.deepEqual(reset, DEFAULT_GLOBAL_CONFIG);
    assert.equal((await loadGlobalConfig(path)).diagnostic, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("global config rejects symlinks and serializes concurrent field updates", async () => {
  const root = await mkdtemp(join(tmpdir(), "mypi-global-config-safety-"));
  const path = join(root, "config.yaml");
  const outside = join(root, "outside.yaml");
  try {
    await writeFile(outside, "version: 1\n", { mode: 0o600 });
    await symlink(outside, path);
    const unsafe = await loadGlobalConfig(path);
    assert.deepEqual(unsafe.config, DEFAULT_GLOBAL_CONFIG);
    assert.equal(unsafe.diagnostic?.code, "unsafe-file");
    await assert.rejects(resetGlobalConfig(path), /unsafe/i);
    await rm(path);

    await Promise.all([
      updateHistoryConfig("maxActive", 31, path),
      updateHistoryConfig("maxArchived", 37, path),
      updateHistoryConfig("shortTestMaxWords", 7, path),
      updateHistoryConfig("autoArchive", false, path),
    ]);
    const loaded = await loadGlobalConfig(path);
    assert.deepEqual(loaded.config.history, {
      autoArchive: false,
      shortTestMaxWords: 7,
      maxActive: 31,
      maxArchived: 37,
    });
    if (process.platform !== "win32") await chmod(path, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("GUI config validates, preserves unrelated YAML, and migrates absent fields only", async () => {
	const root = await mkdtemp(join(tmpdir(), "mypi-global-config-gui-"));
	const path = join(root, "config.yaml");
	try {
		await writeFile(path, "version: 1\nfuture:\n  retained: true\nmcp:\n  servers:\n    private:\n      tokenEnv: SECRET\ngui:\n  theme:\n    mode: light\n", { mode: 0o600 });
		await migrateGuiConfig({
			appMode: "chat",
			theme: { mode: "dark", preset: "nord" },
			layout: { railWidth: 300, workbenchWidth: 600 },
			shortcuts: { commandPalette: "Ctrl+Alt+K" },
			remoteHosts: [],
		}, path);
		let loaded = await loadGlobalConfig(path);
		assert.equal(loaded.config.gui.appMode, "chat");
		assert.equal(loaded.config.gui.theme.mode, "light", "existing config wins migration");
		assert.equal(loaded.config.gui.theme.preset, "nord");
		assert.equal(loaded.config.gui.shortcuts.commandPalette, "Ctrl+Alt+K");
		assert.equal(loaded.config.gui.shortcuts.globalSearch, "CmdOrCtrl+Shift+F");

		assert.equal(loaded.config.gui.favouritePi, "rotate", "decorative identity defaults to rotate");

		await Promise.all([
			updateGlobalConfigField("gui.layout.railWidth", 320, path),
			updateGlobalConfigField("gui.layout.workbenchWidth", 640, path),
			updateGlobalConfigField("history.maxActive", 44, path),
			updateGlobalConfigField("gui.shortcuts.threadSearch", "Ctrl+Alt+T", path),
			updateGlobalConfigField("gui.favouritePi", "moonpi", path),
		]);
		loaded = await loadGlobalConfig(path);
		assert.equal(loaded.config.gui.layout.railWidth, 320);
		assert.equal(loaded.config.gui.layout.workbenchWidth, 640);
		assert.equal(loaded.config.history.maxActive, 44);
		assert.equal(loaded.config.gui.shortcuts.threadSearch, "Ctrl+Alt+T");
		assert.equal(loaded.config.gui.favouritePi, "moonpi");
		const source = parse(await readFile(path, "utf8"));
		assert.deepEqual(source.future, { retained: true });
		assert.equal(source.mcp.servers.private.tokenEnv, "SECRET");

		await assert.rejects(updateGlobalConfigField("gui.shortcuts.commandPalette", "P", path), /invalid|configuration/i);
		await assert.rejects(updateGlobalConfigField("gui.layout.railWidth", 999, path), /invalid|configuration/i);
		await assert.rejects(updateGlobalConfigField("gui.favouritePi", "Not A Slug!", path), /invalid|configuration/i);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("config reset and archive cleanup remain user command authority, not extension-message hooks", () => {
  const commands = new Map<string, unknown>();
  const handlers = new Map<string, unknown[]>();
  const pi = {
    registerCommand(name: string, command: unknown) { commands.set(name, command); },
    on(name: string, handler: unknown) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
  } as unknown as ExtensionAPI;
  globalConfigExtension(pi);
  sessionMaintenanceExtension(pi);
  assert.ok(commands.has("config"));
  assert.ok(commands.has("archive-cleanup"));
  assert.equal(handlers.has("input"), false, "arbitrary extensions cannot inject destructive slash commands");
});
