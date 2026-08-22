#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
let files = execFileSync(
  "git",
  ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard"],
  { encoding: "utf8", maxBuffer: 100 * 1024 * 1024 },
)
  .split("\n")
  .filter(Boolean);

if (files.includes("node_modules")) {
  const dependencyBridge = lstatSync(join(root, "node_modules"));
  assert(
    dependencyBridge.isSymbolicLink() && readlinkSync(join(root, "node_modules")) === "../node_modules",
    "untracked root node_modules must be the GUI-managed dependency bridge",
  );
  files = files.filter((path) => path !== "node_modules");
}

const forbiddenPaths = files.filter((path) => (
  /(^|\/)(AGENTS\.md|CLAUDE\.md|PLAN\.md|ISSUES\.md|PREFLIGHT\.md|SYNC\.md|HANDOFF[^/]*\.md)$/i.test(path)
  || /(^|\/)(\.agents|\.codex|node_modules|coverage|playwright-report|test-results)(\/|$)/i.test(path)
  || /(^|\/)\.env(?:\.|$)/i.test(path)
  || /^(?:vendor\/pi|extensions\/(?:mypi|gui-control)|resources\/mypi-core-package)(?:\/|$)/i.test(path)
  || /(^|\/)\.npmrc$/i.test(path)
  || /(^|\/)(id_(?:rsa|dsa|ecdsa|ed25519)|credentials?)(?:\.|$)/i.test(path)
  || /\.(?:pem|p12|pfx)$/i.test(path)
  || (
    /(^|\/)(?:package-lock\.json|npm-shrinkwrap\.json)$/.test(path)
    && !path.startsWith("packages/runtime/")
  )
));
assert(forbiddenPaths.length === 0,
  `public tree contains forbidden paths:\n${forbiddenPaths.join("\n")}`);

const symlinks = files.filter((path) => lstatSync(join(root, path)).isSymbolicLink());
assert(symlinks.length === 0, `public tree contains symlinks:\n${symlinks.join("\n")}`);

const privateMarkers = [
  ["private source repository", /raririn\/myPi-dev/iu],
  ["private Duke host", /(?:danfeng-\d+|\.cs\.duke\.edu)/iu],
  ["private macOS home path", /\/Users\/raririn(?:\/|$)/u],
  ["private Linux home path", /\/winhomes(?:\/|$)/u],
];
const credentialMarkers = [
  ["private key", /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/u],
  ["npm token", /(?:^|[^A-Za-z0-9])npm_[A-Za-z0-9]{32,}/u],
  ["GitHub token", /(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/u],
  ["AWS access key", /(?:^|[^A-Z0-9])AKIA[A-Z0-9]{16}(?:[^A-Z0-9]|$)/u],
  ["API secret", /(?:^|[^A-Za-z0-9])sk-(?:proj-)?[A-Za-z0-9_-]{24,}/u],
];
const findings = [];
for (const path of files) {
  const bytes = readFileSync(join(root, path));
  if (bytes.includes(0)) continue;
  const content = bytes.toString("utf8");
  for (const [kind, pattern] of [...privateMarkers, ...credentialMarkers]) {
    if (pattern.test(content)) findings.push(`${path}: ${kind}`);
  }
}
assert(findings.length === 0, `public tree contains sensitive markers:\n${findings.join("\n")}`);

const manifest = readJson("package.json");
assert(manifest.private === true, "repository root must remain private to prevent accidental npm publication");
assert(manifest.name === "@raririn/mypi-source", "repository root has unexpected identity");
assert(manifest.version === "1.10.0-beta.5", "repository root has unexpected version");
assert(manifest.mypiRelease?.name === "Roma", "repository root has unexpected release name");
assert(manifest.mypiRelease?.chronicle === 1, "repository root has unexpected release chronicle");
assert(manifest.mypiRelease?.protocol === 1, "repository root has unexpected protocol generation");

const sourceProvenance = readJson("SOURCE_PROVENANCE.json");
const piProvenance = readJson("PI_UPSTREAM_PROVENANCE.json");
assert(sourceProvenance.version === manifest.version, "source provenance has product-version drift");
assert(sourceProvenance.releaseName === manifest.mypiRelease.name, "source provenance has release-name drift");
assert(sourceProvenance.releaseChronicle === manifest.mypiRelease.chronicle,
  "source provenance has release-chronicle drift");
assert(sourceProvenance.protocolGeneration === manifest.mypiRelease.protocol,
  "source provenance has protocol-generation drift");
assert(
  sourceProvenance.includedUpstreams?.[0]?.commit === piProvenance.upstreamCommit,
  "source provenance has Pi commit drift",
);
assert(
  sourceProvenance.acknowledgments?.[0]?.commit
    === "f8a5fd16d7e1bc95541aa5091f6417218b68ccb9",
  "pi-gui acknowledgment does not pin the requested commit",
);
assert(sourceProvenance.acknowledgments?.[0]?.sourceIncluded === false,
  "pi-gui must remain an acknowledgment, not an included source component");

assert(readFileSync(join(root, "LICENSES", "pi-MIT.txt"), "utf8").includes("Copyright (c) 2025 Mario Zechner"),
  "the distributed Pi MIT notice is missing its upstream copyright");
assert(readFileSync(join(root, "LICENSE"), "utf8").includes("Copyright (c) 2026 raririn"),
  "MyPi license does not name raririn as the copyright owner");

console.log(`Verified ${files.length} public source files: no private operating docs, local-host markers, or credential signatures.`);

function readJson(path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
