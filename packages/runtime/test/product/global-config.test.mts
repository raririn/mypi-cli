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
  loadGlobalConfig,
  resetGlobalConfig,
	updateAdvisorModel,
	updateSubagentRequirement,
  updateHistoryConfig,
} from "../../src/product/global-config.ts";

test("global YAML config defaults without creating a file and preserves unrelated configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "mypi-global-config-"));
  const path = join(root, "config.yaml");
  try {
    const missing = await loadGlobalConfig(path);
    assert.deepEqual(missing.config, DEFAULT_GLOBAL_CONFIG);
    await assert.rejects(lstat(path), (error: NodeJS.ErrnoException) => error.code === "ENOENT");

    await writeFile(path, `version: 1\nfuture:\n  enabled: true\nhistory:\n  maxActive: 17\n`, { mode: 0o600 });
    const updated = await updateHistoryConfig("maxArchived", 23, path);
    assert.equal(updated.history.maxActive, 17);
    assert.equal(updated.history.maxArchived, 23);
    const source = parse(await readFile(path, "utf8"));
    assert.deepEqual(source.future, { enabled: true });
    assert.equal(source.history.maxActive, 17);
    assert.equal(source.history.maxArchived, 23);
	await updateAdvisorModel("anthropic/claude-haiku-4-5", path);
	await updateSubagentRequirement("requireAdvisor", true, path);
	const advisor = await loadGlobalConfig(path);
	assert.equal(advisor.config.subagents.advisorModel, "anthropic/claude-haiku-4-5");
	assert.equal(advisor.config.subagents.requireAdvisor, true);
	assert.equal(advisor.config.subagents.requireReviewer, false);
	assert.deepEqual(parse(await readFile(path, "utf8")).future, { enabled: true });
    if (process.platform !== "win32") assert.equal((await lstat(path)).mode & 0o777, 0o600);
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
