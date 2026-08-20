#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const provenance = JSON.parse(readFileSync(join(root, "PI_UPSTREAM_PROVENANCE.json"), "utf8"));
const packages = [
  ["@earendil-works/pi-tui", "build"],
  ["@earendil-works/pi-ai", "build:offline"],
  ["@earendil-works/pi-agent-core", "build"],
  ["@earendil-works/pi-coding-agent", "build"],
];

function packageDirectory(packageName) {
  if (packageName === "@earendil-works/pi-agent-core") return "agent";
  if (packageName === "@earendil-works/pi-coding-agent") return "runtime";
  return packageName.slice("@earendil-works/pi-".length);
}

if (typeof provenance.upstreamVersion !== "string") {
  throw new Error("Pi upstream provenance is missing upstreamVersion.");
}

for (const [packageName] of packages) {
  const directory = packageDirectory(packageName);
  const manifest = JSON.parse(
    readFileSync(join(root, "packages", directory, "package.json"), "utf8"),
  );
  if (manifest.name !== packageName || manifest.version !== provenance.upstreamVersion) {
    throw new Error(
      `Forked ${packageName} must match provenance version ${provenance.upstreamVersion}; found ${manifest.name}@${manifest.version}.`,
    );
  }
}

// Never let removed product modules or generated files survive into a package.
for (const [packageName] of packages) {
  rmSync(join(root, "packages", packageDirectory(packageName), "dist"), { recursive: true, force: true });
}

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
for (const [packageName, script] of packages) {
  const result = spawnSync(pnpm, ["--filter", packageName, "run", script], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Failed to build ${packageName} with status ${result.status ?? "unknown"}.`);
  }
}

console.log(`Built MyPi runtime packages from Pi ${provenance.upstreamVersion} source.`);
