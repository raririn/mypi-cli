#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const rootManifest = readJson(join(root, "package.json"));
const reportPath = join(root, "dist", "npm", "npm-package-report.json");
assert(existsSync(reportPath), "npm package report is missing; run pnpm package");

const report = readJson(reportPath);
const artifact = join(root, "dist", "npm", report.filename);
assert(existsSync(artifact), `npm artifact is missing: ${report.filename}`);
assert(report.version === rootManifest.version, "npm report has product-version drift");
assert(report.piCoreVersion === "0.82.1", "npm report has Pi-version drift");
assert(statSync(artifact).size === report.packageSize, "npm report has artifact-size drift");
assert(sha256(artifact) === report.sha256, "npm report has artifact-digest drift");
assert(report.packageSize <= 80 * 1024 * 1024, "npm artifact exceeds the 80 MiB size budget");
assert(report.entryCount <= 2_000, "npm artifact exceeds the 2,000-entry content budget");

const packageJson = JSON.parse(execFileSync(
  "tar",
  ["-xOzf", artifact, "package/package.json"],
  { encoding: "utf8" },
));
assert(packageJson.name === "@raririn/mypi", "publishable package has unexpected npm identity");
assert(packageJson.author === "raririn", "publishable package has unexpected author");
assert(packageJson.version === rootManifest.version, "publishable package has version drift");
assert(packageJson.license === "MIT", "publishable package must declare MIT");
assert(
  packageJson.scripts?.preinstall === "node lib/check-node-version.mjs",
  "publishable package must fail installation under an unsupported Node.js runtime",
);
assert(packageJson.repository?.url === "git+https://github.com/raririn/mypi-cli.git",
  "publishable package has unexpected repository URL");
assert(packageJson.publishConfig?.access === "public", "scoped package must publish with public access");
assert(packageJson.publishConfig?.tag === "beta", "prerelease package must publish on the beta tag");
assert(packageJson.publishConfig?.provenance === true, "npm provenance must be requested by default");
assert(packageJson.bundledDependencies?.length === 4, "publishable package must bundle four customized Pi workspaces");

const entries = execFileSync("tar", ["-tzf", artifact], {
  encoding: "utf8",
  maxBuffer: 100 * 1024 * 1024,
}).split("\n").filter(Boolean);
for (const required of [
  "package/LICENSE",
  "package/LICENSES/pi-MIT.txt",
  "package/THIRD_PARTY_NOTICES.md",
  "package/SOURCE_PROVENANCE.json",
  "package/MYPI_PROVENANCE.json",
  "package/bin/mypi.mjs",
]) {
  assert(entries.includes(required), `npm artifact is missing ${required}`);
}

console.log(`Verified ${basename(artifact)} (${report.entryCount} entries, ${report.sha256}).`);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
