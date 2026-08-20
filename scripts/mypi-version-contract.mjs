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

function assertReleaseName(value) {
  if (typeof value !== "string" || !/^[A-Z][A-Za-z]{1,31}$/.test(value)) {
    throw new Error(`MyPi release name must be a bounded Roman-city identifier; found ${JSON.stringify(value)}.`);
  }
  return value;
}

function assertReleaseChronicle(value) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`MyPi release chronicle must be a positive integer; found ${JSON.stringify(value)}.`);
  }
  return value;
}

function assertProtocolGeneration(value) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`MyPi protocol generation must be a positive integer; found ${JSON.stringify(value)}.`);
  }
  return value;
}

export function formatMyPiVersion(productVersion, releaseName, piCoreVersion) {
  return `${productVersion} (${releaseName}; pi-core ${piCoreVersion})`;
}

export function readMyPiRuntimeVersion(root = defaultRoot) {
  const manifest = readManifest(join(root, "package.json"));
  const productVersion = assertSemanticVersion(manifest.version, "MyPi package.json version");
  const releaseName = assertReleaseName(manifest.mypiRelease?.name);
  const releaseChronicle = assertReleaseChronicle(manifest.mypiRelease?.chronicle);
  const protocolGeneration = assertProtocolGeneration(manifest.mypiRelease?.protocol);
  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
  const piCoreVersion = assertSemanticVersion(
    dependencies["@earendil-works/pi-coding-agent"],
    "MyPi @earendil-works/pi-coding-agent dependency",
  );

  return {
    productVersion,
    releaseName,
    releaseChronicle,
    protocolGeneration,
    piCoreVersion,
    displayVersion: formatMyPiVersion(productVersion, releaseName, piCoreVersion),
  };
}

export function readMyPiRepositoryVersionContract(root = defaultRoot) {
  const contract = readMyPiRuntimeVersion(root);
  const protocolSource = readFileSync(join(root, "extensions/gui-control/protocol.ts"), "utf8");
  const protocolMatch = protocolSource.match(/^export const MYPI_CONTROL_PROTOCOL = ([1-9]\d*)$/m);
  if (!protocolMatch) {
    throw new Error("extensions/gui-control/protocol.ts must declare a positive integer MYPI_CONTROL_PROTOCOL.");
  }
  const sourceProtocolGeneration = Number(protocolMatch[1]);
  if (sourceProtocolGeneration !== contract.protocolGeneration) {
    throw new Error(
      `MyPi package protocol generation ${contract.protocolGeneration} does not match source protocol ${sourceProtocolGeneration}.`,
    );
  }
  const productMajor = Number(contract.productVersion.split(".", 1)[0]);
  if (productMajor !== contract.protocolGeneration) {
    throw new Error(
      `MyPi CLI major version ${productMajor} must equal MyPi protocol generation ${contract.protocolGeneration}.`,
    );
  }
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
  else if (field === "--protocol") console.log(contract.protocolGeneration);
  else if (field === "--json") console.log(JSON.stringify(contract));
  else throw new Error(`Unknown version-contract field: ${field}`);
}
