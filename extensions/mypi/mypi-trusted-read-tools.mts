import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BUILTIN_READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const MYPI_WEB_READ_TOOLS = new Set(["web_search", "web_fetch"]);
const MYPI_SESSION_READ_TOOLS = new Set(["recall_compacted_history"]);
const MYPI_BUILTIN_CORE_PATH = "<builtin:mypi-core>";
const MYPI_CORE_PACKAGE_NAME = "@mypi/core";
const MYPI_USER_INTERACTION_TOOLS = new Set(["ask_user"]);

interface ToolSourceInfo {
  path: string;
  source: string;
  scope: "user" | "project" | "temporary";
  origin: "package" | "top-level";
  baseDir?: string;
}

function isWithin(path: string, parent: string): boolean {
  const rel = relative(parent, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function findPackageRoot(entryPath: string, baseDir?: string): string | undefined {
  let directory = dirname(entryPath);
  const boundary = baseDir ? realpathSync(resolve(baseDir)) : undefined;
  while (true) {
    const manifest = join(directory, "package.json");
    if (existsSync(manifest)) return directory;
    if (directory === dirname(directory) || (boundary && !isWithin(directory, boundary))) return undefined;
    directory = dirname(directory);
  }
}

function isTrustedPackageExtension(sourceInfo: ToolSourceInfo, packageName: string): boolean {
  if (sourceInfo.origin !== "package" || sourceInfo.path.startsWith("<")) return false;
  try {
    const entryPath = realpathSync(resolve(sourceInfo.path));
    const packageRoot = findPackageRoot(entryPath, sourceInfo.baseDir);
    if (!packageRoot) return false;
    const canonicalRoot = realpathSync(packageRoot);
    if (!isWithin(entryPath, canonicalRoot)) return false;

    const manifestPath = join(canonicalRoot, "package.json");
    const stat = lstatSync(manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      name?: unknown;
      pi?: { extensions?: unknown };
    };
    if (manifest.name !== packageName || !Array.isArray(manifest.pi?.extensions)) return false;
    return manifest.pi.extensions.some((candidate) => {
      if (typeof candidate !== "string") return false;
      try { return realpathSync(resolve(canonicalRoot, candidate)) === entryPath; }
      catch { return false; }
    });
  } catch {
    return false;
  }
}

export function isTrustedWebReadTool(pi: ExtensionAPI, toolName: string): boolean {
  if (!MYPI_WEB_READ_TOOLS.has(toolName)) return false;
  const tool = pi.getAllTools().find((candidate) => candidate.name === toolName);
  return tool
    ? tool.sourceInfo.source === "builtin" && tool.sourceInfo.path === MYPI_BUILTIN_CORE_PATH
    : false;
}

export function isTrustedUserInteractionTool(pi: ExtensionAPI, toolName: string): boolean {
  if (!MYPI_USER_INTERACTION_TOOLS.has(toolName)) return false;
  const tool = pi.getAllTools().find((candidate) => candidate.name === toolName);
  return tool ? isTrustedPackageExtension(tool.sourceInfo as ToolSourceInfo, MYPI_CORE_PACKAGE_NAME) : false;
}

export function isTrustedReadOnlyTool(pi: ExtensionAPI, toolName: string): boolean {
  const tool = pi.getAllTools().find((candidate) => candidate.name === toolName);
  if (!tool) return false;
  if (BUILTIN_READ_TOOLS.has(toolName)) return tool.sourceInfo.source === "builtin";
  if (MYPI_SESSION_READ_TOOLS.has(toolName)) {
    return tool.sourceInfo.source === "builtin" && tool.sourceInfo.path === MYPI_BUILTIN_CORE_PATH;
  }
  return isTrustedWebReadTool(pi, toolName) || isTrustedUserInteractionTool(pi, toolName);
}
