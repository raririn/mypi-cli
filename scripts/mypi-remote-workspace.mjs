#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import lockfile from "@bybrave/proper-lockfile2";

// Product entry points accept MYPI_AGENT_DIR. The pinned upstream runtime
// derives MYPI_CODING_AGENT_DIR from its patched MyPi package identity.
if (process.env.MYPI_AGENT_DIR) process.env.MYPI_CODING_AGENT_DIR = process.env.MYPI_AGENT_DIR;
delete process.env.PI_CODING_AGENT_DIR;

// A 256 KiB attachment chunk expands to roughly 342 KiB in base64 before the
// bounded JSON envelope is added. Keep the request cap above that negotiated
// maximum while remaining far below an unbounded stdin protocol.
const MAX_INPUT = 512 * 1024;
const MAX_ENTRIES = 2_000;
const MAX_FILE_BYTES = 200 * 1024;
const MAX_COMMAND_BYTES = 20 * 1024;
const MAX_COMMAND_OUTPUT = 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENT_CHUNK = 256 * 1024;
const MAX_GIT_OUTPUT = 2 * 1024 * 1024;
const MAX_INDEXED_DIRECTORIES = 5_000;
const MAX_INDEX_DEPTH = 5;
const MAX_WORKSPACE_FILES = 5_000;
const MAX_WORKSPACE_DEPTH = 64;
const MAX_WORKSPACE_FILE_INDEX_BYTES = 1_500_000;
const CAPABILITIES = ["files", "changes", "worktrees", "attachments", "session-lifecycle", "project-resources", "workspace-index"];

const chunks = [];
let inputBytes = 0;
for await (const chunk of process.stdin) {
  inputBytes += chunk.length;
  if (inputBytes > MAX_INPUT) throw new Error("Remote workspace request is too large.");
  chunks.push(chunk);
}
const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const root = await privateRoot(request.root);
let data;
if (request.operation === "capabilities") data = { protocol: 2, capabilities: CAPABILITIES };
else if (request.operation === "workspace_index") data = await workspaceIndex(root);
else if (request.operation === "file_index") data = await fileIndex(root);
else if (request.operation === "list") data = await list(root, request.path);
else if (request.operation === "read") data = await read(root, request.path);
else if (request.operation === "run") data = await run(root, request.command);
else if (request.operation === "git_status") data = await gitStatus(root);
else if (request.operation === "git_diff") data = await gitDiff(root, request.path, request.layer);
else if (request.operation === "git_stage") data = await gitStage(root, request.path, true);
else if (request.operation === "git_unstage") data = await gitStage(root, request.path, false);
else if (request.operation === "git_stage_all") data = await gitStageAll(root, true);
else if (request.operation === "git_unstage_all") data = await gitStageAll(root, false);
else if (request.operation === "worktree_list") data = await worktreeList(root);
else if (request.operation === "worktree_create") data = await worktreeCreate(root, request.branch, request.baseRef);
else if (request.operation === "worktree_remove") data = await worktreeRemove(root, request.path, request.force === true);
else if (request.operation === "attachment_init") data = await attachmentInit(request);
else if (request.operation === "attachment_chunk") data = await attachmentChunk(request);
else if (request.operation === "attachment_finish") data = await attachmentFinish(request);
else if (request.operation === "attachment_abort") data = await attachmentAbort(request);
else if (request.operation === "session_writer_status") data = await sessionWriterStatus(request.sessionFile, request.sessionId);
else if (request.operation === "session_archive") data = await moveSession(root, request.sessionFile, "active", "archived", request.sessionId);
else if (request.operation === "session_restore") data = await moveSession(root, request.sessionFile, "archived", "active", request.sessionId);
else if (request.operation === "session_delete") data = await deleteArchivedSession(request.sessionFile, request.sessionId, request.confirm === true);
else if (request.operation === "session_fork") data = await forkSession(request.sessionFile, request.targetRoot, request.targetLeafId);
else if (request.operation === "project_environment") data = await projectEnvironment(root);
else if (request.operation === "project_settings_write") data = await writeProjectSettings(root, request.settings);
else throw new Error("Unknown remote workspace operation.");
process.stdout.write(`${JSON.stringify({ application: "mypi-remote-workspace", protocol: 2, data })}\n`);

async function privateRoot(value) {
  if (typeof value !== "string" || !isAbsolute(value) || value.length > 4096 || /[\0\r\n]/.test(value) || resolve(value) !== value) {
    throw new Error("Remote workspace root must be a normalized absolute path.");
  }
  const canonical = await realpath(value);
  if (!(await lstat(canonical)).isDirectory()) throw new Error("Remote workspace root is not a directory.");
  return canonical;
}

async function contained(root, value, requireFile = false) {
  if (typeof value !== "string" || isAbsolute(value) || value.length > 4096 || /[\0\r\n]/.test(value)) {
    throw new Error("Remote workspace path must be relative.");
  }
  const candidate = resolve(root, value || ".");
  const rel = relative(root, candidate);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Remote workspace path escapes its root.");
  const info = await lstat(candidate);
  if (info.isSymbolicLink()) throw new Error("Remote workspace paths cannot traverse symbolic links.");
  const canonical = await realpath(candidate);
  if (canonical !== root && !canonical.startsWith(`${root}${sep}`)) throw new Error("Remote workspace path escapes its root.");
  if (requireFile && !info.isFile()) throw new Error("Remote preview target is not a regular file.");
  return { candidate: canonical, info, relativePath: relative(root, canonical) || "." };
}

async function list(root, value) {
  const target = await contained(root, value || ".");
  if (!target.info.isDirectory()) throw new Error("Remote list target is not a directory.");
  const entries = await readdir(target.candidate, { withFileTypes: true });
  if (entries.length > MAX_ENTRIES) throw new Error(`Remote directory has more than ${MAX_ENTRIES} entries.`);
  const output = [];
  for (const entry of entries) {
    if (/[\0\r\n/]/.test(entry.name)) continue;
    const info = await lstat(resolve(target.candidate, entry.name));
    output.push({
      name: entry.name,
      kind: info.isDirectory() ? "directory" : info.isFile() ? "file" : info.isSymbolicLink() ? "symlink" : "other",
      size: info.size,
      modifiedAt: info.mtime.toISOString(),
    });
  }
  output.sort((left, right) => left.kind === right.kind ? left.name.localeCompare(right.name) : left.kind === "directory" ? -1 : 1);
  return { path: target.relativePath, entries: output };
}

async function fileIndex(root) {
  const files = [];
  const ordinaryQueue = [{ directory: root, prefix: "", depth: 0, deferred: false }];
  const deferredQueue = [];
  const vcsMetadata = new Set([".git", ".hg", ".svn"]);
  const deferredLargeDirectories = new Set(["node_modules", "vendor", ".cache"]);
  let ordinaryIndex = 0;
  let deferredIndex = 0;
  let unreadableDirectories = 0;
  let outputBytes = 0;
  let truncated = false;

  while ((ordinaryIndex < ordinaryQueue.length || deferredIndex < deferredQueue.length) && !truncated) {
    const current = ordinaryQueue[ordinaryIndex] ?? deferredQueue[deferredIndex];
    if (ordinaryIndex < ordinaryQueue.length) ordinaryIndex += 1;
    else deferredIndex += 1;
    if (!current) continue;

    let entries;
    let traversedDirectory;
    try {
      const info = await lstat(current.directory);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Remote file index encountered an unsafe directory.");
      const canonicalDirectory = await realpath(current.directory);
      const rootRelative = relative(root, canonicalDirectory);
      if (rootRelative === ".." || rootRelative.startsWith(`..${sep}`) || isAbsolute(rootRelative)) {
        throw new Error("Remote file index escaped its workspace root.");
      }
      entries = await readdir(canonicalDirectory, { withFileTypes: true });
      traversedDirectory = canonicalDirectory;
    } catch (error) {
      if (current.depth === 0) throw error;
      if (["EACCES", "ENOENT", "EPERM"].includes(error?.code)) {
        unreadableDirectories += 1;
        continue;
      }
      throw error;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));

    if (entries.length > MAX_ENTRIES) {
      entries = entries.slice(0, MAX_ENTRIES);
      truncated = true;
    }
    for (const entry of entries) {
      if (/[/\0\r\n]/.test(entry.name) || entry.isSymbolicLink()) continue;
      const relativePath = current.prefix ? `${current.prefix}/${entry.name}` : entry.name;
      if (entry.isFile()) {
        const nextBytes = Buffer.byteLength(relativePath, "utf8") + 4;
        if (files.length >= MAX_WORKSPACE_FILES || outputBytes + nextBytes > MAX_WORKSPACE_FILE_INDEX_BYTES) {
          truncated = true;
          break;
        }
        files.push(relativePath);
        outputBytes += nextBytes;
        continue;
      }
      if (!entry.isDirectory() || vcsMetadata.has(entry.name)) continue;
      if (current.depth >= MAX_WORKSPACE_DEPTH) {
        truncated = true;
        continue;
      }
      const next = {
        directory: join(traversedDirectory, entry.name),
        prefix: relativePath,
        depth: current.depth + 1,
        deferred: current.deferred || deferredLargeDirectories.has(entry.name),
      };
      (next.deferred ? deferredQueue : ordinaryQueue).push(next);
    }
  }

  if (ordinaryIndex < ordinaryQueue.length || deferredIndex < deferredQueue.length) truncated = true;
  return { files: files.sort(), truncated, unreadableDirectories };
}

async function workspaceIndex(root) {
  if (root !== resolve("/")) throw new Error("Remote workspace indexing must use the filesystem root.");
  const home = await realpath(homedir());
  const homeInfo = await lstat(home);
  if (!homeInfo.isDirectory() || homeInfo.isSymbolicLink()) throw new Error("Remote home is not a safe directory.");
  const directories = [home];
  const queue = [{ path: home, depth: 0 }];
  const excluded = new Set([".cache", ".git", ".hg", ".svn", ".Trash", "Library", "node_modules", "vendor"]);
  while (queue.length > 0 && directories.length < MAX_INDEXED_DIRECTORIES) {
    const current = queue.shift();
    if (!current || current.depth >= MAX_INDEX_DEPTH) continue;
    let entries;
    try {
      entries = await readdir(current.path, { withFileTypes: true });
    } catch (error) {
      if (["EACCES", "ENOENT", "EPERM"].includes(error?.code)) continue;
      throw error;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (directories.length >= MAX_INDEXED_DIRECTORIES) break;
      if (!entry.isDirectory() || entry.isSymbolicLink() || excluded.has(entry.name) || entry.name.startsWith(".")) continue;
      if (/[/\0\r\n]/.test(entry.name)) continue;
      const candidate = join(current.path, entry.name);
      directories.push(candidate);
      queue.push({ path: candidate, depth: current.depth + 1 });
    }
  }
  return { home, directories, truncated: queue.length > 0 };
}

async function read(root, value) {
  const target = await contained(root, value, true);
  const bytes = await readFile(target.candidate);
  const truncated = bytes.length > MAX_FILE_BYTES;
  const content = bytes.subarray(0, MAX_FILE_BYTES);
  if (content.includes(0)) return { path: target.relativePath, binary: true, truncated, size: bytes.length };
  return { path: target.relativePath, binary: false, truncated, size: bytes.length, text: content.toString("utf8") };
}

async function projectEnvironment(root) {
  const configRoot = await projectConfigRoot(root, false);
  if (!configRoot) return { configPath: join(root, ".mypi"), settings: {}, resources: [] };
  const settingsPath = join(configRoot, "settings.json");
  let settings = {};
  try {
    const info = await lstat(settingsPath);
    if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_FILE_BYTES) throw new Error("Remote project settings must be a bounded regular file.");
    settings = JSON.parse(await readFile(settingsPath, "utf8"));
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("Remote project settings must contain a JSON object.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const resources = [];
  for (const kind of ["skills", "extensions", "prompts", "themes"]) {
    const directory = join(configRoot, kind);
    let entries;
    try {
      const info = await lstat(directory);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Remote project ${kind} path must be a directory.`);
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (entries.length > MAX_ENTRIES) throw new Error(`Remote project has more than ${MAX_ENTRIES} ${kind}.`);
    for (const entry of entries) {
      if (/[/\0\r\n]/.test(entry.name) || entry.isSymbolicLink()) continue;
      const relativePath = join(".mypi", kind, entry.name);
      if (entry.isFile()) resources.push({ kind, name: entry.name, path: relativePath });
      if (entry.isDirectory() && kind === "skills") {
        const skillPath = join(directory, entry.name, "SKILL.md");
        try {
          const skillInfo = await lstat(skillPath);
          if (skillInfo.isFile() && !skillInfo.isSymbolicLink()) resources.push({ kind, name: entry.name, path: join(relativePath, "SKILL.md") });
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      }
    }
  }
  resources.sort((left, right) => left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name));
  return { configPath: configRoot, settings, resources };
}

async function writeProjectSettings(root, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Remote project settings must be a JSON object.");
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_FILE_BYTES) throw new Error("Remote project settings exceed 200 KiB.");
  const configRoot = await projectConfigRoot(root, true);
  const settingsPath = join(configRoot, "settings.json");
  try {
    const info = await lstat(settingsPath);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("Remote project settings target must be a regular file.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const temporary = join(configRoot, `.settings-${process.pid}-${randomUUID()}.tmp`);
  await writeFile(temporary, serialized, { flag: "wx", mode: 0o600 });
  try {
    await rename(temporary, settingsPath);
  } finally {
    await rm(temporary, { force: true });
  }
  return projectEnvironment(root);
}

async function projectConfigRoot(root, create) {
  const candidate = join(root, ".mypi");
  try {
    const info = await lstat(candidate);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Remote .mypi project path must be a directory, not a symlink.");
    const canonical = await realpath(candidate);
    if (canonical !== root && !canonical.startsWith(`${root}${sep}`)) throw new Error("Remote .mypi project path escaped its workspace.");
    return canonical;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    if (!create) return undefined;
    await mkdir(candidate, { recursive: false, mode: 0o700 });
    return realpath(candidate);
  }
}

async function run(root, command) {
  if (typeof command !== "string" || !command.trim() || Buffer.byteLength(command) > MAX_COMMAND_BYTES || command.includes("\0")) {
    throw new Error("Remote command is empty or too large.");
  }
  return new Promise((resolvePromise, reject) => {
    const child = spawn("/bin/sh", ["-lc", command], { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let truncated = false;
    const append = (current, chunk) => {
      const combined = Buffer.concat([current, chunk]);
      if (combined.length <= MAX_COMMAND_OUTPUT) return combined;
      truncated = true;
      return combined.subarray(0, MAX_COMMAND_OUTPUT);
    };
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.once("error", reject);
    const timeout = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolvePromise({
        exitCode: code,
        signal,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        truncated,
      });
    });
  });
}

async function gitRoot(root) {
  const result = await execBounded("git", ["rev-parse", "--show-toplevel"], root, 20_000, 64 * 1024);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Remote workspace is not in a Git repository.");
  const candidate = result.stdout.trim();
  if (!isAbsolute(candidate) || /[\0\r\n]/.test(candidate)) throw new Error("Git returned an invalid repository root.");
  const canonical = await realpath(candidate);
  if (!(await lstat(canonical)).isDirectory()) throw new Error("Git repository root is not a directory.");
  return canonical;
}

async function gitStatus(root) {
  const repositoryRoot = await gitRoot(root);
  const result = await execBounded("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], repositoryRoot, 30_000, MAX_GIT_OUTPUT);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "git status failed.");
  const fields = result.stdout.split("\0");
  const entries = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field) continue;
    if (field.length < 4) throw new Error("git status returned malformed output.");
    const indexStatus = field[0];
    const worktreeStatus = field[1];
    let path = field.slice(3);
    let originalPath;
    if (indexStatus === "R" || indexStatus === "C") {
      originalPath = fields[++index];
      if (!originalPath) throw new Error("git status returned a malformed rename.");
    }
    path = safeGitPath(path);
    entries.push({ path, indexStatus, worktreeStatus, ...(originalPath ? { originalPath: safeGitPath(originalPath) } : {}) });
    if (entries.length > 5_000) throw new Error("Remote repository has more than 5000 changed files.");
  }
  const [unstagedStats, stagedStats] = await Promise.all([
    gitNumstat(repositoryRoot, false),
    gitNumstat(repositoryRoot, true),
  ]);
  const enriched = await Promise.all(entries.map(async (entry) => {
    const status = gitChangeStatus(entry.indexStatus, entry.worktreeStatus);
    const layers = gitChangeLayers(entry.indexStatus, entry.worktreeStatus);
    const unstaged = unstagedStats.get(entry.path) ?? { added: 0, removed: 0 };
    const staged = stagedStats.get(entry.path) ?? { added: 0, removed: 0 };
    const groups = status === "conflict" ? ["conflict"] : layers;
    const diffEntries = await Promise.all(groups.map(async (group) => {
      const result = await gitDiff(repositoryRoot, entry.path, group === "conflict" ? undefined : group)
        .catch(() => ({ diff: "" }));
      return { group, diff: result.diff, fingerprint: createHash("sha256")
        .update(`${group}\0${entry.indexStatus}${entry.worktreeStatus}\0${result.diff}`)
        .digest("hex") };
    }));
    const fingerprints = Object.fromEntries(diffEntries.map(({ group, fingerprint }) => [group, fingerprint]));
    const untrackedStats = status === "untracked"
      ? countGitDiffLines(diffEntries.find(({ group }) => group === "unstaged")?.diff ?? "")
      : undefined;
    const effectiveUnstaged = untrackedStats ?? unstaged;
    return {
      ...entry,
      status,
      layers,
      added: staged.added + effectiveUnstaged.added,
      removed: staged.removed + effectiveUnstaged.removed,
      layerStats: {
        ...(layers.includes("staged") ? { staged } : {}),
        ...(layers.includes("unstaged") ? { unstaged: effectiveUnstaged } : {}),
      },
      fingerprints,
    };
  }));
  return { repositoryRoot, entries: enriched };
}

async function gitDiff(root, pathValue, layerValue) {
  const repositoryRoot = await gitRoot(root);
  const path = safeGitPath(pathValue);
  const layer = layerValue === undefined || layerValue === "staged" || layerValue === "unstaged"
    ? layerValue
    : (() => { throw new Error("Remote Git diff layer is invalid."); })();
  if (layer === "staged") {
    const staged = await execBounded("git", ["diff", "--cached", "--no-ext-diff", "--no-color", "--", path], repositoryRoot, 30_000, MAX_GIT_OUTPUT);
    if (staged.exitCode !== 0) throw new Error(staged.stderr.trim() || "git staged diff failed.");
    return { repositoryRoot, path, diff: staged.stdout, truncated: staged.truncated, layer };
  }
  const tracked = await execBounded("git", ["ls-files", "--error-unmatch", "--", path], repositoryRoot, 20_000, 64 * 1024);
  if (tracked.exitCode !== 0) {
    const target = await contained(repositoryRoot, path, true);
    const untracked = await execBounded(
      "git",
      ["diff", "--no-index", "--no-ext-diff", "--no-color", "--", "/dev/null", target.relativePath],
      repositoryRoot,
      30_000,
      MAX_GIT_OUTPUT,
    );
    if (untracked.exitCode !== 0 && untracked.exitCode !== 1) {
      throw new Error(untracked.stderr.trim() || "git diff failed for the untracked file.");
    }
    return { repositoryRoot, path, diff: untracked.stdout, truncated: untracked.truncated, ...(layer ? { layer } : {}) };
  }
  const result = await execBounded(
    "git",
    ["diff", "--no-ext-diff", "--no-color", ...(layer === "unstaged" ? [] : ["HEAD"]), "--", path],
    repositoryRoot,
    30_000,
    MAX_GIT_OUTPUT,
  );
  if (result.exitCode !== 0) {
    const fallback = await execBounded("git", ["diff", "--no-ext-diff", "--no-color", "--", path], repositoryRoot, 30_000, MAX_GIT_OUTPUT);
    if (fallback.exitCode !== 0) throw new Error(fallback.stderr.trim() || result.stderr.trim() || "git diff failed.");
    return { repositoryRoot, path, diff: fallback.stdout, truncated: fallback.truncated, ...(layer ? { layer } : {}) };
  }
  return { repositoryRoot, path, diff: result.stdout, truncated: result.truncated, ...(layer ? { layer } : {}) };
}

async function gitStage(root, pathValue, stage) {
  const repositoryRoot = await gitRoot(root);
  const path = safeGitPath(pathValue);
  const args = stage ? ["add", "--", path] : ["restore", "--staged", "--", path];
  let result = await execBounded("git", args, repositoryRoot, 30_000, 256 * 1024);
  if (!stage && result.exitCode !== 0) result = await execBounded("git", ["reset", "--", path], repositoryRoot, 30_000, 256 * 1024);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `git ${stage ? "add" : "unstage"} failed.`);
  return { repositoryRoot, path, staged: stage };
}

async function gitStageAll(root, stage) {
  const repositoryRoot = await gitRoot(root);
  const args = stage ? ["add", "-A"] : ["reset", "-q", "HEAD", "--", "."];
  const result = await execBounded("git", args, repositoryRoot, 30_000, 256 * 1024);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `git ${stage ? "add all" : "unstage all"} failed.`);
  return { repositoryRoot, staged: stage };
}

async function gitNumstat(repositoryRoot, staged) {
  const result = await execBounded(
    "git",
    ["diff", ...(staged ? ["--cached"] : []), "--numstat"],
    repositoryRoot,
    30_000,
    MAX_GIT_OUTPUT,
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "git diff --numstat failed.");
  const stats = new Map();
  for (const line of result.stdout.split("\n")) {
    const [addedText, removedText, ...pathParts] = line.split("\t");
    if (!addedText || !removedText || pathParts.length === 0) continue;
    const path = pathParts.at(-1);
    if (!path) continue;
    stats.set(path, {
      added: /^\d+$/.test(addedText) ? Number(addedText) : 0,
      removed: /^\d+$/.test(removedText) ? Number(removedText) : 0,
    });
  }
  return stats;
}

function gitChangeStatus(indexStatus, worktreeStatus) {
  const xy = `${indexStatus}${worktreeStatus}`;
  if (["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(xy)) return "conflict";
  if (indexStatus === "R" || worktreeStatus === "R") return "renamed";
  if (indexStatus === "?" && worktreeStatus === "?") return "untracked";
  if (indexStatus === "A" || worktreeStatus === "A") return "added";
  if (indexStatus === "D" || worktreeStatus === "D") return "deleted";
  return "modified";
}

function gitChangeLayers(indexStatus, worktreeStatus) {
  if (gitChangeStatus(indexStatus, worktreeStatus) === "conflict") return [];
  const layers = [];
  if (indexStatus !== " " && indexStatus !== "?") layers.push("staged");
  if (worktreeStatus !== " " || indexStatus === "?") layers.push("unstaged");
  return layers;
}

function countGitDiffLines(diff) {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  }
  return { added, removed };
}

async function worktreeList(root) {
  const repositoryRoot = await gitRoot(root);
  const result = await execBounded("git", ["worktree", "list", "--porcelain", "-z"], repositoryRoot, 30_000, MAX_GIT_OUTPUT);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "git worktree list failed.");
  const records = result.stdout.split("\0\0").map((record) => record.split("\0").filter(Boolean)).filter((record) => record.length);
  const worktrees = records.map((record) => {
    const values = new Map(record.map((line) => {
      const split = line.indexOf(" ");
      return split < 0 ? [line, ""] : [line.slice(0, split), line.slice(split + 1)];
    }));
    const path = values.get("worktree");
    if (!path || !isAbsolute(path) || /[\0\r\n]/.test(path)) throw new Error("git worktree returned an invalid path.");
    return {
      path,
      head: values.get("HEAD") ?? "",
      ...(values.get("branch") ? { branch: values.get("branch").replace(/^refs\/heads\//, "") } : {}),
      detached: values.has("detached"),
      locked: values.has("locked"),
      prunable: values.has("prunable"),
      main: resolve(path) === resolve(repositoryRoot),
    };
  });
  return { repositoryRoot, worktrees };
}

async function worktreeCreate(root, branchValue, baseRefValue) {
  const repositoryRoot = await gitRoot(root);
  const branch = requireGitRef(branchValue, "Remote worktree branch");
  const baseRef = baseRefValue === undefined ? "HEAD" : requireGitRef(baseRefValue, "Remote worktree base ref");
  const check = await execBounded("git", ["check-ref-format", "--branch", branch], repositoryRoot, 10_000, 64 * 1024);
  if (check.exitCode !== 0) throw new Error("Remote worktree branch name is invalid.");
  const container = join(dirname(repositoryRoot), ".mypi-worktrees", basename(repositoryRoot));
  await mkdir(container, { recursive: true, mode: 0o700 });
  const canonicalContainer = await realpath(container);
  const destination = join(canonicalContainer, branch.replaceAll("/", "--"));
  if (resolve(destination) !== destination || relative(canonicalContainer, destination).startsWith("..")) throw new Error("Remote worktree destination is invalid.");
  const result = await execBounded("git", ["worktree", "add", "-b", branch, destination, baseRef], repositoryRoot, 60_000, MAX_GIT_OUTPUT);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "git worktree add failed.");
  return { repositoryRoot, path: await realpath(destination), branch };
}

async function worktreeRemove(root, pathValue, force) {
  const { repositoryRoot, worktrees } = await worktreeList(root);
  if (typeof pathValue !== "string" || !isAbsolute(pathValue) || /[\0\r\n]/.test(pathValue)) throw new Error("Remote worktree path is invalid.");
  const selected = worktrees.find((worktree) => worktree.path === pathValue);
  if (!selected || selected.main) throw new Error("Only a listed non-main remote worktree can be removed.");
  const args = ["worktree", "remove", ...(force ? ["--force"] : []), "--", selected.path];
  const result = await execBounded("git", args, repositoryRoot, 60_000, MAX_GIT_OUTPUT);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "git worktree remove failed.");
  return { repositoryRoot, path: selected.path, removed: true };
}

async function attachmentInit(request) {
  await cleanupOldUploads();
  const sessionId = requireSafeId(request.sessionId, "Remote session identity");
  const name = safeAttachmentName(request.name);
  const kind = request.kind === "image" || request.kind === "file" ? request.kind : undefined;
  const mimeType = typeof request.mimeType === "string" && /^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/.test(request.mimeType) ? request.mimeType : undefined;
  const size = Number(request.size);
  const sha256 = typeof request.sha256 === "string" && /^[a-f0-9]{64}$/.test(request.sha256) ? request.sha256 : undefined;
  if (!kind || !mimeType || !Number.isInteger(size) || size <= 0 || size > MAX_ATTACHMENT_BYTES || !sha256) throw new Error("Remote attachment metadata is invalid.");
  const sessionDirectory = await attachmentSessionDirectory(sessionId);
  const incoming = join(sessionDirectory, ".incoming");
  await mkdir(incoming, { recursive: true, mode: 0o700 });
  const transferId = randomUUID();
  const partPath = join(incoming, `${transferId}.part`);
  const metadataPath = join(incoming, `${transferId}.json`);
  await writeFile(partPath, Buffer.alloc(0), { flag: "wx", mode: 0o600 });
  await writeFile(metadataPath, JSON.stringify({ sessionId, name, kind, mimeType, size, sha256, createdAt: Date.now(), partPath }), { flag: "wx", mode: 0o600 });
  return { transferId, chunkBytes: MAX_ATTACHMENT_CHUNK };
}

async function attachmentChunk(request) {
  const { metadata, metadataPath } = await attachmentMetadata(request.transferId);
  const offset = Number(request.offset);
  if (!Number.isInteger(offset) || offset < 0 || offset > metadata.size) throw new Error("Remote attachment offset is invalid.");
  const encoded = typeof request.data === "string" ? request.data : "";
  if (!encoded || encoded.length > Math.ceil(MAX_ATTACHMENT_CHUNK * 4 / 3) + 8) throw new Error("Remote attachment chunk is invalid.");
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes.length > MAX_ATTACHMENT_CHUNK || bytes.toString("base64").replace(/=+$/, "") !== encoded.replace(/\s+/g, "").replace(/=+$/, "")) {
    throw new Error("Remote attachment chunk is not valid bounded base64.");
  }
  const current = await stat(metadata.partPath);
  if (!current.isFile() || current.size !== offset || current.size + bytes.length > metadata.size) throw new Error("Remote attachment chunk offset does not match acknowledged bytes.");
  await appendFile(metadata.partPath, bytes);
  await writeFile(metadataPath, JSON.stringify({ ...metadata, acknowledged: offset + bytes.length }), { mode: 0o600 });
  return { acknowledged: offset + bytes.length };
}

async function attachmentFinish(request) {
  const { metadata, metadataPath } = await attachmentMetadata(request.transferId);
  const bytes = await readFile(metadata.partPath);
  if (bytes.length !== metadata.size || createHash("sha256").update(bytes).digest("hex") !== metadata.sha256) {
    await Promise.allSettled([rm(metadata.partPath, { force: true }), rm(metadataPath, { force: true })]);
    throw new Error("Remote attachment size or hash verification failed.");
  }
  const filesDirectory = join(dirname(dirname(metadata.partPath)), "files");
  await mkdir(filesDirectory, { recursive: true, mode: 0o700 });
  const destination = join(filesDirectory, `${randomUUID()}-${metadata.name}`);
  await rename(metadata.partPath, destination);
  await rm(metadataPath, { force: true });
  return { kind: metadata.kind, name: metadata.name, mimeType: metadata.mimeType, fsPath: destination, sizeBytes: metadata.size };
}

async function attachmentAbort(request) {
  const { metadata, metadataPath } = await attachmentMetadata(request.transferId);
  await Promise.allSettled([rm(metadata.partPath, { force: true }), rm(metadataPath, { force: true })]);
  return { aborted: true };
}

async function moveSession(workspaceRoot, sessionFileValue, sourceState, destinationState, sessionIdValue) {
  const sessionId = requireSafeId(sessionIdValue, "Remote session identity");
  let source;
  try {
    source = await containedSessionFile(sessionFileValue, sourceState);
  } catch (error) {
    if (sourceState !== "active" || !isMissingFileError(error)) throw error;
    await materializeEmptySessionFile(workspaceRoot, sessionFileValue, sessionId);
    source = await containedSessionFile(sessionFileValue, sourceState);
  }
  const roots = await sessionRoots();
  const destinationRoot = destinationState === "active" ? roots.sessionsRoot : roots.archiveRoot;
  const destination = resolve(destinationRoot, source.relativePath);
  assertPathBelow(destination, destinationRoot, "Remote session destination");
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await assertPathMissing(destination);
  const release = await acquireSessionMutationLock(source.path);
  try {
    await assertNoBlockingWriterLease(source.path, true);
    await rename(source.path, destination);
  } finally {
    await release();
  }
  if (destinationState === "archived") await removeSessionAttachments(sessionId);
  await removeEmptySessionParent(source.path, source.root);
  return { sessionFile: destination, state: destinationState };
}

async function materializeEmptySessionFile(workspaceRoot, sessionFileValue, sessionId) {
  const { path: canonical } = await missingSessionLocation(sessionFileValue, true);
  const header = {
    type: "session",
    version: 3,
    id: sessionId,
    timestamp: new Date().toISOString(),
    cwd: workspaceRoot,
  };
  await writeFile(canonical, `${JSON.stringify(header)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

async function missingSessionLocation(sessionFileValue, createParent) {
  if (
    typeof sessionFileValue !== "string" ||
    !isAbsolute(sessionFileValue) ||
    resolve(sessionFileValue) !== sessionFileValue ||
    !sessionFileValue.endsWith(".jsonl") ||
    sessionFileValue.length > 4096 ||
    /[\0\r\n]/.test(sessionFileValue)
  ) {
    throw new Error("Missing remote session path is invalid.");
  }
  const roots = await sessionRoots();
  const relativePath = relative(roots.sessionsRootInput, sessionFileValue);
  const parts = relativePath.split(sep);
  if (
    parts.length !== 2 ||
    parts.some((part) => !part || part === "." || part === "..") ||
    isAbsolute(relativePath)
  ) {
    throw new Error("Missing remote session path is outside the canonical session layout.");
  }
  const expectedParent = join(roots.sessionsRoot, parts[0]);
  if (createParent) {
    try {
      await mkdir(expectedParent, { recursive: false, mode: 0o700 });
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "EEXIST") throw error;
    }
  }
  const parentInfo = await lstat(expectedParent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new Error("Empty remote session parent is unsafe.");
  const parent = await realpath(expectedParent);
  assertPathBelow(parent, roots.sessionsRoot, "Empty remote session parent");
  const canonical = join(parent, basename(sessionFileValue));
  if (canonical !== join(roots.sessionsRoot, ...parts)) throw new Error("Missing remote session path is not canonical.");
  return { path: canonical, root: roots.sessionsRoot, relativePath: parts.join(sep) };
}

async function deleteArchivedSession(sessionFileValue, sessionIdValue, confirmed) {
  if (!confirmed) throw new Error("Permanent remote session deletion requires explicit confirmation.");
  const sessionId = requireSafeId(sessionIdValue, "Remote session identity");
  const source = await containedSessionFile(sessionFileValue, "archived");
  const release = await acquireSessionMutationLock(source.path);
  try {
    await assertNoBlockingWriterLease(source.path, true);
    await removeRemoteSubagentChildren(sessionId);
    await rm(source.path);
  } finally {
    await release();
  }
  await removeSessionAttachments(sessionId);
  await removeEmptySessionParent(source.path, source.root);
  return { deleted: true };
}

async function removeRemoteSubagentChildren(sessionId) {
  const agentDir = process.env.MYPI_AGENT_DIR || process.env.MYPI_CODING_AGENT_DIR;
  if (!agentDir || !isAbsolute(agentDir)) throw new Error("MyPi agent directory is unavailable.");
  const root = resolve(agentDir, "subagents", "by-parent");
  const target = resolve(root, requireSafeId(sessionId, "Remote session identity"));
  assertPathBelow(target, root, "Remote subagent parent storage");
  try {
    const info = await lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Remote subagent parent storage is unsafe.");
    await rm(target, { recursive: true, force: false });
  } catch (error) {
    if (!error || typeof error !== "object" || error.code !== "ENOENT") throw error;
  }
}

async function forkSession(sessionFileValue, targetRootValue, targetLeafIdValue) {
  const targetRoot = await privateRoot(targetRootValue);
  const targetLeafId = targetLeafIdValue === null
    ? null
    : requireSafeId(targetLeafIdValue, "Remote fork entry");
  let source;
  try {
    source = await containedSessionFile(sessionFileValue, "active");
  } catch (error) {
    if (targetLeafId !== null || !isMissingFileError(error)) throw error;
    source = await missingSessionLocation(sessionFileValue, true);
  }
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  let manager;
  if (targetLeafId === null) {
    manager = SessionManager.create(targetRoot);
    manager.newSession({ parentSession: source.path });
  } else {
    const sourceManager = SessionManager.open(source.path);
    if (!sourceManager.getEntry(targetLeafId)) throw new Error("Remote fork entry is not in the selected session.");
    if (resolve(sourceManager.getCwd()) === resolve(targetRoot)) {
      const forkedPath = sourceManager.createBranchedSession(targetLeafId);
      if (!forkedPath) throw new Error("Remote session fork did not create a durable file.");
      manager = sourceManager;
    } else {
      manager = SessionManager.forkFrom(source.path, targetRoot);
      const intermediate = manager.getSessionFile();
      let forkedPath;
      try {
        forkedPath = manager.createBranchedSession(targetLeafId);
        if (!forkedPath) throw new Error("Remote session fork did not create a durable file.");
      } catch (error) {
        if (intermediate) await rm(intermediate, { force: true });
        throw error;
      }
      if (intermediate && resolve(intermediate) !== resolve(forkedPath)) await rm(intermediate, { force: true });
    }
  }
  forcePersistSession(manager);
  const sessionFile = manager.getSessionFile();
  if (!sessionFile) throw new Error("Remote session fork is not durable.");
  const verified = await containedSessionFile(sessionFile, "active");
  return { sessionFile: verified.path, sessionId: manager.getSessionId(), cwd: targetRoot };
}

function forcePersistSession(manager) {
  if (typeof manager?._rewriteFile === "function") {
    manager._rewriteFile();
    manager.flushed = true;
  }
}

async function sessionRoots() {
  const agentDir = process.env.MYPI_AGENT_DIR || process.env.MYPI_CODING_AGENT_DIR;
  if (!agentDir || !isAbsolute(agentDir) || /[\0\r\n]/.test(agentDir)) throw new Error("MyPi agent directory is unavailable.");
  const resolvedAgentDir = resolve(agentDir);
  const sessionsRoot = resolve(resolvedAgentDir, "sessions");
  const archiveRoot = resolve(resolvedAgentDir, "session-archive");
  await mkdir(sessionsRoot, { recursive: true, mode: 0o700 });
  await mkdir(archiveRoot, { recursive: true, mode: 0o700 });
  return {
    sessionsRootInput: sessionsRoot,
    sessionsRoot: await realpath(sessionsRoot),
    archiveRoot: await realpath(archiveRoot),
  };
}

async function containedSessionFile(value, state) {
  if (typeof value !== "string" || !isAbsolute(value) || value.length > 4096 || /[\0\r\n]/.test(value) || resolve(value) !== value) {
    throw new Error("Remote session file must be a normalized absolute path.");
  }
  const roots = await sessionRoots();
  const root = state === "active" ? roots.sessionsRoot : roots.archiveRoot;
  const info = await lstat(value);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Remote session target is not a regular file.");
  const canonical = await realpath(value);
  const relativePath = relative(root, canonical);
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath) || !relativePath.endsWith(".jsonl")) {
    throw new Error(`Remote session file is not in the ${state} MyPi store.`);
  }
  assertPathBelow(canonical, root, "Remote session file");
  return { path: canonical, root, relativePath: relative(root, canonical) };
}

async function sessionWriterStatus(sessionFileValue, sessionIdValue) {
  requireSafeId(sessionIdValue, "Remote session identity");
  const session = await containedSessionFile(sessionFileValue, "active");
  let release;
  try {
    release = await acquireSessionMutationLock(session.path);
  } catch (error) {
    if (/active writer/i.test(error instanceof Error ? error.message : String(error))) {
      return { state: "held" };
    }
    return { state: "unverifiable" };
  }
  try {
    await assertNoBlockingWriterLease(session.path);
    return { state: "free" };
  } catch {
    return { state: "unverifiable" };
  } finally {
    await release().catch(() => undefined);
  }
}

async function acquireSessionMutationLock(sessionFile) {
  try {
    return await lockfile.lock(sessionFile, {
      lockfilePath: `${sessionFile}.lock`,
      realpath: false,
      retries: 0,
      stale: 30_000,
    });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ELOCKED") {
      throw new Error("Remote session still has an active writer.");
    }
    throw error;
  }
}

async function assertNoBlockingWriterLease(sessionFile, removeModern = false) {
  let raw;
  try {
    raw = await readFile(`${sessionFile}.lease`, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return;
    throw error;
  }
  try {
    const diagnostic = JSON.parse(raw);
    if (diagnostic && typeof diagnostic === "object" && typeof diagnostic.ownerId === "string" && diagnostic.ownerId) {
      if (removeModern) await rm(`${sessionFile}.lease`, { force: true });
      return;
    }
  } catch {
    // Malformed and owner-ID-less leases are legacy migration barriers.
  }
  throw new Error("Remote session still has an active or unverifiable writer lease.");
}

async function assertPathMissing(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error("Remote session destination already exists.");
}

function assertPathBelow(path, root, label) {
  const rel = relative(root, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${label} escapes its managed store.`);
}

async function removeSessionAttachments(sessionId) {
  const directory = join(remoteAttachmentRoot(), createHash("sha256").update(sessionId).digest("hex"));
  await rm(directory, { recursive: true, force: true });
}

async function removeEmptySessionParent(path, root) {
  const parent = dirname(path);
  if (parent === root) return;
  assertPathBelow(parent, root, "Remote session parent");
  await rmdir(parent).catch((error) => {
    if (!error || typeof error !== "object" || !["ENOTEMPTY", "ENOENT"].includes(error.code)) throw error;
  });
}

async function attachmentMetadata(value) {
  const transferId = requireSafeId(value, "Remote attachment transfer");
  const root = remoteAttachmentRoot();
  const matches = await findFiles(root, `${transferId}.json`, 4);
  if (matches.length !== 1) throw new Error("Unknown remote attachment transfer.");
  const metadataPath = matches[0];
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  if (metadata.partPath !== metadataPath.replace(/\.json$/, ".part") || metadata.size > MAX_ATTACHMENT_BYTES) throw new Error("Remote attachment transfer metadata is invalid.");
  return { metadata, metadataPath };
}

async function attachmentSessionDirectory(sessionId) {
  const root = remoteAttachmentRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = join(root, createHash("sha256").update(sessionId).digest("hex"));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function remoteAttachmentRoot() {
  const agentDir = process.env.MYPI_AGENT_DIR || process.env.MYPI_CODING_AGENT_DIR;
  if (!agentDir || !isAbsolute(agentDir)) throw new Error("MyPi agent directory is unavailable.");
  return join(resolve(agentDir), "tui-bridge-attachments");
}

async function cleanupOldUploads() {
  const root = remoteAttachmentRoot();
  const files = await findFiles(root, ".json", 4, true).catch(() => []);
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const path of files) {
    const info = await stat(path).catch(() => undefined);
    if (!info || info.mtimeMs >= cutoff) continue;
    await Promise.allSettled([rm(path, { force: true }), rm(path.replace(/\.json$/, ".part"), { force: true })]);
  }
}

async function findFiles(root, pattern, depth, suffix = false) {
  if (depth < 0) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const output = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) output.push(...await findFiles(path, pattern, depth - 1, suffix));
    else if (entry.isFile() && (suffix ? entry.name.endsWith(pattern) : entry.name === pattern)) output.push(path);
  }
  return output;
}

function safeGitPath(value) {
  if (typeof value !== "string" || !value || isAbsolute(value) || value.length > 4_096 || /[\0\r\n]/.test(value)) throw new Error("Git path is invalid.");
  const normalized = value.replaceAll("\\", "/");
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) throw new Error("Git path escapes the repository.");
  return normalized;
}

function requireGitRef(value, label) {
  if (typeof value !== "string" || !value || value.length > 240 || value.startsWith("-") || /[\0\r\n]/.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function requireSafeId(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9-]{8,512}$/.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function isMissingFileError(error) {
  return Boolean(error && typeof error === "object" && error.code === "ENOENT");
}

function safeAttachmentName(value) {
  if (typeof value !== "string") throw new Error("Remote attachment name is invalid.");
  const name = basename(value.trim()).replace(/[^A-Za-z0-9._ -]/g, "_").slice(0, 160);
  if (!name || name === "." || name === "..") throw new Error("Remote attachment name is invalid.");
  return name;
}

function execBounded(command, args, cwd, timeoutMs, maxBytes) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"], shell: false });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let truncated = false;
    const append = (current, chunk) => {
      const combined = Buffer.concat([current, chunk]);
      if (combined.length <= maxBytes) return combined;
      truncated = true;
      return combined.subarray(0, maxBytes);
    };
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.once("error", reject);
    const timeout = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    timeout.unref();
    child.once("exit", (exitCode, signal) => {
      clearTimeout(timeout);
      resolvePromise({ exitCode, signal, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), truncated });
    });
  });
}
