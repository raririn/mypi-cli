#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readMyPiRepositoryVersionContract } from "./mypi-version-contract.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const options = parseArgs(process.argv.slice(2));
const sourceRoot = options.source;
const productRoot = sourceRoot;
const outputRoot = options.output;
const stageRoot = join(repositoryRoot, "build", "npm-stage");
const npmCache = join(repositoryRoot, ".cache", "npm");

const customPackageDirectories = [
  "vendor/pi/packages/tui",
  "vendor/pi/packages/ai",
  "vendor/pi/packages/agent",
  "vendor/pi/packages/coding-agent",
];
const productManifest = readJson(join(productRoot, "package.json"));
const coreManifest = readJson(join(productRoot, "resources", "mypi-core-package", "package.json"));
const provenance = readJson(join(productRoot, "vendor", "pi", "MYPI_PROVENANCE.json"));
const version = productManifest.version;
const versionContract = readMyPiRepositoryVersionContract(productRoot);

assert(version === versionContract.productVersion, "MyPi version contract does not match the CLI");
assert(version === coreManifest.version, "@mypi/core version does not match the CLI");
assert(
  normalizeVersion(productManifest.devDependencies?.["@earendil-works/pi-coding-agent"])
    === provenance.upstreamVersion,
  "product Pi pin does not match vendored provenance",
);
assert(existsSync(join(productRoot, "vendor", "pi", "packages", "coding-agent", "dist", "cli.js")),
  "vendored Pi must be built before staging the npm package");

rmSync(stageRoot, { recursive: true, force: true });
mkdirSync(stageRoot, { recursive: true });
mkdirSync(outputRoot, { recursive: true });
mkdirSync(npmCache, { recursive: true });

copyTemplateTree();
copyRuntimeLaunchers();
copyChatRuntime();
copyProfilePackage();
copyFile(join(productRoot, "LICENSE"), join(stageRoot, "LICENSE"));
copyFile(join(productRoot, "LICENSES", "pi-MIT.txt"), join(stageRoot, "LICENSES", "pi-MIT.txt"));
copyFile(join(productRoot, "SOURCE_PROVENANCE.json"), join(stageRoot, "SOURCE_PROVENANCE.json"));

const packageManifests = customPackageDirectories.map((path) => ({
  path,
  manifest: readJson(join(productRoot, path, "package.json")),
}));
const customVersions = new Map(
  packageManifests.map(({ manifest }) => [manifest.name, normalizeVersion(manifest.version)]),
);
for (const [name, packageVersion] of customVersions) {
  assert(packageVersion === provenance.upstreamVersion, `${name} does not match Pi ${provenance.upstreamVersion}`);
}

const requiredDependencies = new Map();
const optionalDependencies = new Map();
for (const { manifest } of packageManifests) {
  mergeDependencies(requiredDependencies, manifest.dependencies ?? {}, customVersions);
  mergeDependencies(optionalDependencies, manifest.optionalDependencies ?? {}, customVersions);
}
for (const name of requiredDependencies.keys()) optionalDependencies.delete(name);
for (const [name, packageVersion] of customVersions) requiredDependencies.set(name, packageVersion);

const finalManifest = {
  name: "@raririn/mypi",
  version,
  description: "MyPi agentic coding CLI with an isolated, customized Pi runtime",
  license: "MIT",
  author: "raririn",
  type: "module",
  bin: { mypi: "bin/mypi.mjs" },
  scripts: { preinstall: "node lib/check-node-version.mjs" },
  files: [
    "bin",
    "lib",
    "scripts",
    "extensions",
    "resources",
    "README.md",
    "LICENSE",
    "LICENSES",
    "THIRD_PARTY_NOTICES.md",
    "MYPI_PROVENANCE.json",
    "SOURCE_PROVENANCE.json",
  ],
  engines: { node: ">=22.19.0" },
  os: ["darwin", "linux"],
  cpu: ["arm64", "x64"],
  repository: {
    type: "git",
    url: "git+https://github.com/raririn/mypi-cli.git",
  },
  homepage: "https://github.com/raririn/mypi-cli",
  bugs: { url: "https://github.com/raririn/mypi-cli/issues" },
  keywords: ["ai", "agent", "coding-agent", "cli", "mypi"],
  publishConfig: {
    access: "public",
    tag: version.includes("-") ? "beta" : "latest",
    provenance: true,
  },
  dependencies: Object.fromEntries([...requiredDependencies].sort(compareEntries)),
  optionalDependencies: Object.fromEntries([...optionalDependencies].sort(compareEntries)),
  bundledDependencies: [...customVersions.keys()].sort(),
};

const installManifest = structuredClone(finalManifest);
for (const { manifest, path } of packageManifests) {
  installManifest.dependencies[manifest.name] = `file:${join(productRoot, path)}`;
}
writeJson(join(stageRoot, "package.json"), installManifest);

runNpm([
  "install",
  "--omit=dev",
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
  "--install-links",
], stageRoot);

writeJson(join(stageRoot, "package.json"), finalManifest);
pruneBundledPackages(packageManifests.map(({ manifest }) => manifest.name), customVersions);
removeUnbundledInstallTree(new Set(customVersions.keys()));
rmSync(join(stageRoot, "package-lock.json"), { force: true });
rmSync(join(stageRoot, "node_modules", ".package-lock.json"), { force: true });

const sourceStatus = gitStatus(sourceRoot);
const sourceCommit = gitMaybe(sourceRoot, ["rev-parse", "HEAD"])?.trim() || null;
const generatedAt = sourceCommit
  ? git(sourceRoot, ["show", "-s", "--format=%cI", sourceCommit]).trim()
  : null;
writeJson(join(stageRoot, "MYPI_PROVENANCE.json"), {
  schemaVersion: 1,
  product: "MyPi",
  productVersion: version,
  piCoreVersion: provenance.upstreamVersion,
  piSource: provenance,
  sourceCommit,
  sourceDirty: Boolean(sourceStatus),
  npmPackage: "@raririn/mypi",
  generatedAt,
});

const packResult = runNpm([
  "pack",
  "--json",
  "--pack-destination",
  outputRoot,
], stageRoot, true);
const report = JSON.parse(packResult);
assert(Array.isArray(report) && report.length === 1, "npm pack returned an unexpected report");
const artifact = join(outputRoot, report[0].filename);
const entries = listArchive(artifact);
assertCleanTarball(entries);

const result = {
  schemaVersion: 1,
  artifact: report[0].filename,
  filename: report[0].filename,
  version,
  piCoreVersion: provenance.upstreamVersion,
  packageSize: statSync(artifact).size,
  unpackedSize: report[0].unpackedSize,
  entryCount: entries.length,
  sha256: sha256File(artifact),
  sourceDirty: Boolean(sourceStatus),
};
writeJson(join(outputRoot, "npm-package-report.json"), result);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

function parseArgs(args) {
  const parsed = {
    source: repositoryRoot,
    output: resolve(repositoryRoot, "dist", "npm"),
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--source" || argument === "--output") {
      const value = args[++index];
      if (!value) throw new Error(`${argument} requires a path`);
      parsed[argument.slice(2)] = resolve(value);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return parsed;
}

function copyTemplateTree() {
  copyTree(join(repositoryRoot, "npm", "bin"), join(stageRoot, "bin"));
  copyTree(join(repositoryRoot, "npm", "lib"), join(stageRoot, "lib"));
  copyFile(join(repositoryRoot, "README.md"), join(stageRoot, "README.md"));
  copyFile(join(repositoryRoot, "THIRD_PARTY_NOTICES.md"), join(stageRoot, "THIRD_PARTY_NOTICES.md"));
  chmodSync(join(stageRoot, "bin", "mypi.mjs"), 0o755);
}

function copyRuntimeLaunchers() {
  for (const name of [
    "mypi.mjs",
    "mypi-version-contract.mjs",
    "mypi-web-search-config.mjs",
    "mypi-remote-workspace.mjs",
    "pi-cli.mjs",
  ]) {
    copyFile(join(productRoot, "scripts", name), join(stageRoot, "scripts", name));
  }
}

function copyChatRuntime() {
  const extensionsRoot = join(stageRoot, "extensions", "mypi");
  mkdirSync(extensionsRoot, { recursive: true });
  const esbuild = join(productRoot, "node_modules", ".bin", "esbuild");
  assert(existsSync(esbuild), "esbuild is required to compile the npm-safe Chat runtime");
  for (const [source, output] of [
    ["mypi-chat.ts", "mypi-chat.mjs"],
    ["mypi-chat-storage.mts", "mypi-chat-storage.mjs"],
  ]) {
    const result = spawnSync(esbuild, [
      join(productRoot, "extensions", "mypi", source),
      "--bundle",
      "--platform=node",
      "--format=esm",
      "--target=node22",
      "--packages=external",
      `--outfile=${join(extensionsRoot, output)}`,
    ], { stdio: "inherit" });
    if (result.error) throw result.error;
    assert(result.status === 0, `esbuild failed while compiling ${source}`);
  }
  const piCliPath = join(stageRoot, "scripts", "pi-cli.mjs");
  const compiledPiCli = readFileSync(piCliPath, "utf8")
    .replace("../extensions/mypi/mypi-chat-storage.mts", "../extensions/mypi/mypi-chat-storage.mjs")
    .replace('"mypi-chat.ts"', '"mypi-chat.mjs"');
  writeFileSync(piCliPath, compiledPiCli);
}

function copyProfilePackage() {
  const destination = join(stageRoot, "resources", "mypi-core");
  copyFile(
    join(productRoot, "resources", "mypi-core-package", "package.json"),
    join(destination, "package.json"),
  );
  const profileFiles = [
    "mypi-agent-signals.ts",
    "mypi-ask-user.ts",
    "mypi-chat-manage.ts",
    "mypi-chat-storage.mts",
    "mypi-credential-redaction.ts",
    "mypi-exit.ts",
    "mypi-identity.ts",
    "mypi-keyword-skill-router.ts",
    "mypi-progress-briefs.ts",
    "mypi-readonly.ts",
    "mypi-redpanda-provider.ts",
    "mypi-safemode.ts",
    "mypi-trusted-read-tools.mts",
    "mypi-tui-auto-title.ts",
    "mypi-working-timer.ts",
    "redpanda-provider-core.ts",
  ];
  for (const name of profileFiles) {
    copyFile(
      join(productRoot, "extensions", "mypi", name),
      join(destination, "extensions", name),
    );
  }
  copyTree(
    join(productRoot, "extensions", "gui-control"),
    join(destination, "extensions", "gui-control"),
    (path) => (
      !path.includes("/node_modules/")
      && !path.endsWith("package-lock.json")
      && !path.includes(".test.")
    ),
  );
}

function mergeDependencies(target, values, customVersions) {
  for (const [name, rawVersion] of Object.entries(values)) {
    if (customVersions.has(name)) continue;
    const packageVersion = normalizeVersion(rawVersion);
    const existing = target.get(name);
    assert(!existing || existing === packageVersion,
      `dependency version skew for ${name}: ${existing} versus ${packageVersion}`);
    target.set(name, packageVersion);
  }
}

function normalizeVersion(value) {
  return typeof value === "string" && value.startsWith("workspace:")
    ? value.slice("workspace:".length)
    : value;
}

function pruneBundledPackages(packageNames, customVersions) {
  for (const name of packageNames) {
    const root = join(stageRoot, "node_modules", ...name.split("/"));
    assert(existsSync(root), `npm did not install bundled runtime ${name}`);
    const manifestPath = join(root, "package.json");
    const manifest = readJson(manifestPath);
    manifest.dependencies = Object.fromEntries(
      Object.entries(manifest.dependencies ?? {})
        .filter(([dependency]) => customVersions.has(dependency))
        .map(([dependency]) => [dependency, customVersions.get(dependency)]),
    );
    delete manifest.optionalDependencies;
    delete manifest.devDependencies;
    delete manifest.peerDependencies;
    delete manifest.peerDependenciesMeta;
    writeJson(manifestPath, manifest);
    const candidates = [
      "AGENTS.md",
      "CLAUDE.md",
      "CHANGELOG.md",
      "examples",
      "src",
      "test",
      "tests",
      "npm-shrinkwrap.json",
      "package-lock.json",
    ];
    if (name !== "@earendil-works/pi-coding-agent") {
      candidates.push("README.md", "docs");
    }
    for (const candidate of candidates) {
      rmSync(join(root, candidate), { recursive: true, force: true });
    }
  }
}

function removeUnbundledInstallTree(customNames) {
  const modulesRoot = join(stageRoot, "node_modules");
  for (const entry of readdirSync(modulesRoot, { withFileTypes: true })) {
    if (entry.name === ".bin") {
      rmSync(join(modulesRoot, entry.name), { recursive: true, force: true });
      continue;
    }
    const path = join(modulesRoot, entry.name);
    if (!entry.name.startsWith("@")) {
      if (!customNames.has(entry.name)) rmSync(path, { recursive: true, force: true });
      continue;
    }
    for (const child of readdirSync(path, { withFileTypes: true })) {
      const name = `${entry.name}/${child.name}`;
      if (!customNames.has(name)) {
        rmSync(join(path, child.name), { recursive: true, force: true });
      }
    }
    if (readdirSync(path).length === 0) rmSync(path, { recursive: true, force: true });
  }
}

function assertCleanTarball(entries) {
  const forbidden = entries.filter((entry) => (
    /(^|\/)(AGENTS\.md|CLAUDE\.md|PLAN\.md|ISSUES\.md|PREFLIGHT\.md|SYNC\.md|HANDOFF[^/]*\.md)$/.test(entry)
    || (
      /(^|\/)(docs|examples|plans|tests?|coverage|playwright-report|test-results)(\/|$)/.test(entry)
      && !entry.startsWith("package/node_modules/@earendil-works/pi-coding-agent/docs/")
    )
    || entry.startsWith("package/node_modules/@earendil-works/pi-coding-agent/skills/")
    || /(^|\/)(package-lock\.json|npm-shrinkwrap\.json)$/.test(entry)
    || /(^|\/)\.DS_Store$/.test(entry)
  ));
  assert(forbidden.length === 0, `npm tarball contains forbidden files:\n${forbidden.join("\n")}`);
  assert(entries.includes("package/bin/mypi.mjs"), "npm tarball is missing the MyPi entry point");
  assert(entries.includes("package/LICENSE"), "npm tarball is missing the MyPi MIT license");
  assert(entries.includes("package/LICENSES/pi-MIT.txt"), "npm tarball is missing Pi's MIT license");
  assert(entries.includes("package/THIRD_PARTY_NOTICES.md"), "npm tarball is missing third-party notices");
  assert(entries.includes("package/SOURCE_PROVENANCE.json"), "npm tarball is missing source provenance");
  assert(
    entries.some((entry) => entry.endsWith("/@earendil-works/pi-coding-agent/dist/cli.js")),
    "npm tarball is missing the customized Pi CLI",
  );
  assert(entries.includes("package/MYPI_PROVENANCE.json"), "npm tarball is missing provenance");
}

function runNpm(args, cwd, capture = false) {
  const result = spawnSync("npm", args, {
    cwd,
    env: {
      ...process.env,
      npm_config_cache: npmCache,
      NPM_CONFIG_CACHE: npmCache,
    },
    encoding: capture ? "utf8" : undefined,
    maxBuffer: capture ? 100 * 1024 * 1024 : undefined,
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm ${args.join(" ")} exited with ${result.status}`);
  return capture ? result.stdout : "";
}

function copyTree(source, destination, filter = () => true) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    if (!filter(sourcePath, entry)) continue;
    const destinationPath = join(destination, entry.name);
    if (entry.isDirectory()) copyTree(sourcePath, destinationPath, filter);
    else if (entry.isFile()) copyFile(sourcePath, destinationPath);
  }
}

function copyFile(source, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { preserveTimestamps: false });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

function gitMaybe(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout : undefined;
}

function gitStatus(root) {
  return git(root, ["status", "--porcelain=v1", "--untracked-files=all"]).trim();
}

function listArchive(path) {
  return execFileSync("tar", ["-tzf", path], { encoding: "utf8", maxBuffer: 100 * 1024 * 1024 })
    .split("\n")
    .filter(Boolean);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function compareEntries([left], [right]) {
  return left.localeCompare(right);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
