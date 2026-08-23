import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { readMyPiRepositoryVersionContract } from "../scripts/mypi-version-contract.mjs";

const root = resolve(import.meta.dirname, "..");

test("CLI SemVer major matches the MyPi protocol generation and stable chronicle", () => {
  const contract = readMyPiRepositoryVersionContract(root);
  assert.equal(Number(contract.productVersion.split(".", 1)[0]), contract.protocolGeneration);
  assert.equal(contract.productVersion, "2.0.0-beta.3");
  assert.equal(contract.protocolGeneration, 2);
  assert.equal(contract.releaseName, "Roma");
  assert.equal(contract.releaseChronicle, 1);
  assert.equal(contract.displayVersion, "2.0.0-beta.3 (Roma; pi-core 0.82.1)");
});

test("public npm documentation uses the scoped package and isolated profile", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  assert.match(readme, /npm install --global @raririn\/mypi(?:\s|$)/m);
  assert.match(readme, /npm prefix --global/);
  assert.match(readme, /npm exec --yes --package=@raririn\/mypi -- mypi/);
  assert.match(readme, /~\/\.mypi\/agent/);
  assert.doesNotMatch(readme, /@raririn\/mypi@beta|npm install --global mypi(?:@|\s)/);
});

test("MyPi and Pi MIT notices are both present and distinct", () => {
  const mypiLicense = readFileSync(join(root, "LICENSE"), "utf8");
  const piLicense = readFileSync(join(root, "LICENSES", "pi-MIT.txt"), "utf8");
  assert.match(mypiLicense, /Copyright \(c\) 2026 raririn/);
  assert.match(piLicense, /Copyright \(c\) 2025 Mario Zechner/);
  assert.notEqual(mypiLicense, piLicense);
});

test("remote host metadata advertises the workspace index implemented by the helper", () => {
  const fixture = mkdtempSync(join(tmpdir(), "mypi-remote-info-test-"));
  const result = spawnSync(
    process.execPath,
    [join(root, "scripts", "mypi.mjs"), "__remote-info"],
    {
      encoding: "utf8",
      env: { ...process.env, HOME: fixture, MYPI_AGENT_DIR: join(fixture, "agent") },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const info = JSON.parse(result.stdout);
  assert.equal(info.application, "mypi-remote-host");
  assert.equal(info.bridgeProtocol, 2);
	assert.equal(info.metadataProtocol, 1);
	assert.equal(info.protocol, 1, "legacy discovery-schema alias remains compatible");
  assert.equal(info.releaseName, "Roma");
  assert.equal(info.workspaceProtocol, 2);
  assert.ok(info.workspaceCapabilities.includes("workspace-index"));
});

test("profile convergence leaves unrelated settings unchanged", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "mypi-profile-test-"));
  const agentDir = join(fixture, "agent");
  const settingsPath = join(agentDir, "settings.json");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify({
    theme: "dark",
    packages: ["npm:someone/extension"],
    unknown: { retained: true },
  })}\n`);
  const modulePath = `${join(root, "npm", "lib", "converge-profile.mjs")}?test=${Date.now()}`;
  const { convergeLegacyProfile } = await import(modulePath);
  const first = await convergeLegacyProfile({ env: { MYPI_AGENT_DIR: agentDir } });
  const second = await convergeLegacyProfile({ env: { MYPI_AGENT_DIR: agentDir } });
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.equal(first.changed, false);
  assert.equal(second.changed, false);
  assert.equal(settings.theme, "dark");
  assert.deepEqual(settings.unknown, { retained: true });
  assert.equal(settings.packages[0], "npm:someone/extension");
  assert.equal(settings.packages.length, 1);
});

test("normal profile convergence removes only superseded MyPi-managed entries", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "mypi-profile-replace-test-"));
  const agentDir = join(fixture, "agent");
  const formerCore = join(agentDir, "packages", "mypi-core");
  const formerWeb = join(agentDir, "packages", "web-search");
  const settingsPath = join(agentDir, "settings.json");
  mkdirSync(formerCore, { recursive: true });
  mkdirSync(formerWeb, { recursive: true });
  writeFileSync(join(formerCore, "package.json"), '{"name":"@mypi/core","version":"0.0.1"}\n');
  writeFileSync(join(formerWeb, "package.json"), '{"name":"@mypi/web-search","version":"0.1.0"}\n');
  writeFileSync(settingsPath, `${JSON.stringify({
    packages: ["packages/mypi-core", "packages/web-search", "npm:someone/extension"],
    preserved: true,
  })}\n`);
  const modulePath = `${join(root, "npm", "lib", "converge-profile.mjs")}?replace=${Date.now()}`;
  const { convergeLegacyProfile } = await import(modulePath);
  await convergeLegacyProfile({ env: { MYPI_AGENT_DIR: agentDir } });
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.equal(settings.packages[0], "npm:someone/extension");
  assert.equal(settings.packages.length, 1);
  assert.equal(settings.preserved, true);
});
