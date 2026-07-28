#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(scriptsDirectory, "..");
const semanticVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*)|(?:\d*[A-Za-z-][0-9A-Za-z-]*))(?:\.(?:(?:0|[1-9]\d*)|(?:\d*[A-Za-z-][0-9A-Za-z-]*)))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function readManifest(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function assertSemanticVersion(value, label) {
  const exactValue = typeof value === "string" && value.startsWith("workspace:")
    ? value.slice("workspace:".length)
    : value;
  if (typeof exactValue !== "string" || !semanticVersionPattern.test(exactValue)) {
    throw new Error(`${label} must be an exact valid SemVer; found ${JSON.stringify(value)}.`);
  }
  return exactValue;
}

export function formatMyPiVersion(productVersion, piCoreVersion) {
  return `${productVersion} (pi-core ${piCoreVersion})`;
}

export function readMyPiRuntimeVersion(root = defaultRoot) {
  const manifest = readManifest(join(root, "package.json"));
  const productVersion = assertSemanticVersion(manifest.version, "MyPi package.json version");
  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
  const piCoreVersion = assertSemanticVersion(
    dependencies["@earendil-works/pi-coding-agent"],
    "MyPi @earendil-works/pi-coding-agent dependency",
  );

  return {
    productVersion,
    piCoreVersion,
    displayVersion: formatMyPiVersion(productVersion, piCoreVersion),
  };
}

export function readMyPiRepositoryVersionContract(root = defaultRoot) {
  const contract = readMyPiRuntimeVersion(root);
  for (const relativePath of ["resources/mypi-core-package/package.json"]) {
    const manifest = readManifest(join(root, relativePath));
    if (manifest.version !== contract.productVersion) {
      throw new Error(
        `${relativePath} version must equal MyPi ${contract.productVersion}; found ${JSON.stringify(manifest.version)}.`,
      );
    }
  }
  return contract;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const contract = readMyPiRepositoryVersionContract();
  const field = process.argv[2] ?? "--display";
  if (field === "--display") console.log(contract.displayVersion);
  else if (field === "--product") console.log(contract.productVersion);
  else if (field === "--pi") console.log(contract.piCoreVersion);
  else if (field === "--json") console.log(JSON.stringify(contract));
  else throw new Error(`Unknown version-contract field: ${field}`);
}
