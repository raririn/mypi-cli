import { constants } from "node:fs";
import { realpathSync } from "node:fs";
import { access, copyFile, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";

const PI_CODING_AGENT_MODULE = "@earendil-works/pi-coding-agent";

export interface ChatPaths {
  readonly root: string;
  readonly activeHistory: string;
  readonly activeAssets: string;
  readonly archiveHistory: string;
  readonly archiveAssets: string;
}

export interface ChatStorageRecord {
  readonly state: "active" | "archived";
  readonly session: SessionInfo;
  readonly historyBytes: number;
  readonly assetBytes: number;
  readonly attachmentCount: number;
  readonly assetDirectory?: string;
}

/** Proof supplied by a caller that already owns the authoritative writer lock. */
export interface ChatMutationOwnership {
  readonly ownerId: string;
}

export function resolveChatPaths(agentDir = process.env.MYPI_AGENT_DIR || process.env.MYPI_CODING_AGENT_DIR || join(homedir(), ".mypi", "agent")): ChatPaths {
  const configuredRoot = resolve(process.env.PI_GUI_CHAT_ROOT || join(agentDir, "chat-sessions"));
  const root = canonicalizePath(configuredRoot);
  return {
    root,
    activeHistory: join(root, "history"),
    activeAssets: join(root, "assets"),
    archiveHistory: join(root, "archive", "history"),
    archiveAssets: join(root, "archive", "assets"),
  };
}

export async function ensureChatRoots(paths = resolveChatPaths()): Promise<void> {
  await Promise.all([
    mkdir(paths.activeHistory, { recursive: true }),
    mkdir(paths.activeAssets, { recursive: true }),
    mkdir(paths.archiveHistory, { recursive: true }),
    mkdir(paths.archiveAssets, { recursive: true }),
  ]);
}

export async function listChats(state: "active" | "archived" | "all" = "all", paths = resolveChatPaths()): Promise<ChatStorageRecord[]> {
  await ensureChatRoots(paths);
  const groups = await Promise.all([
    state === "archived" ? Promise.resolve([]) : listChatState("active", paths.activeHistory, paths),
    state === "active" ? Promise.resolve([]) : listChatState("archived", paths.archiveHistory, paths),
  ]);
  return groups.flat().sort((left, right) => right.session.modified.getTime() - left.session.modified.getTime());
}

async function listChatState(state: "active" | "archived", historyRoot: string, paths: ChatPaths): Promise<ChatStorageRecord[]> {
  const { SessionManager } = await import(/* @vite-ignore */ PI_CODING_AGENT_MODULE);
  const sessions: SessionInfo[] = await SessionManager.listAll(historyRoot).catch((error: unknown) => {
    if (isErrorCode(error, "ENOENT")) return [];
    throw error;
  });
  return Promise.all(sessions.map(async (session) => {
    const assetDirectory = chatAssetDirectory(session, state, paths);
    const [historyBytes, assetStats] = await Promise.all([
      fileSize(session.path),
      assetDirectory ? inspectAssets(assetDirectory) : Promise.resolve({ bytes: 0, attachments: 0 }),
    ]);
    return {
      state,
      session,
      historyBytes,
      assetBytes: assetStats.bytes,
      attachmentCount: assetStats.attachments,
      ...(assetDirectory ? { assetDirectory } : {}),
    };
  }));
}

export function chatAssetDirectory(session: SessionInfo, state: "active" | "archived", paths = resolveChatPaths()): string | undefined {
  const cwd = canonicalizePath(session.cwd);
  const relativeAsset = containedRelative(cwd, paths.activeAssets);
  if (!relativeAsset) return undefined;
  return state === "active" ? cwd : join(paths.archiveAssets, relativeAsset);
}

function canonicalizePath(path: string): string {
  const resolvedPath = resolve(path);
  const missing: string[] = [];
  let current = resolvedPath;
  while (true) {
    try { return join(realpathSync.native(current), ...missing.reverse()); }
    catch {
      const parent = dirname(current);
      if (parent === current) return resolvedPath;
      missing.push(basename(current));
      current = parent;
    }
  }
}

export async function archiveChat(
  sessionId: string,
  paths = resolveChatPaths(),
  ownership?: ChatMutationOwnership,
): Promise<{ source: string; destination: string }> {
  const record = requireUnique(await listChats("active", paths), sessionId, "active");
  await assertMutationOwnership(record.session.path, ownership);
  const destination = join(paths.archiveHistory, record.session.path.split(/[\\/]/).at(-1)!);
  const activeAsset = record.assetDirectory;
  const archivedAsset = activeAsset ? join(paths.archiveAssets, containedRelative(activeAsset, paths.activeAssets)!) : undefined;
  await moveFile(record.session.path, destination);
  try {
    if (activeAsset && archivedAsset && await exists(activeAsset)) await moveDirectory(activeAsset, archivedAsset);
  } catch (error) {
    await moveFile(destination, record.session.path).catch(() => undefined);
    throw error;
  }
  return { source: record.session.path, destination };
}

export async function restoreChat(sessionId: string, paths = resolveChatPaths()): Promise<{ source: string; destination: string }> {
  const record = requireUnique(await listChats("archived", paths), sessionId, "archived");
  const destination = join(paths.activeHistory, record.session.path.split(/[\\/]/).at(-1)!);
  const activeAsset = resolve(record.session.cwd);
  const archivedAsset = record.assetDirectory;
  assertContained(activeAsset, paths.activeAssets, "active Chat assets");
  await moveFile(record.session.path, destination);
  try {
    if (archivedAsset && await exists(archivedAsset)) await moveDirectory(archivedAsset, activeAsset);
  } catch (error) {
    await moveFile(destination, record.session.path).catch(() => undefined);
    throw error;
  }
  return { source: record.session.path, destination };
}

/**
 * Remove the exact placeholder created by New chat after its caller has
 * acquired the authoritative writer lock. Any evidence of user intent makes
 * this a no-op: extra JSONL entries, a renamed session, canvas content,
 * attachments, unexpected asset files, or changed lock ownership.
 */
export async function discardUntouchedChat(
  sessionId: string,
  paths = resolveChatPaths(),
  ownership?: ChatMutationOwnership,
): Promise<boolean> {
  const record = requireUnique(await listChats("active", paths), sessionId, "active");
  await assertMutationOwnership(record.session.path, ownership, "discard");
  if (!record.assetDirectory) return false;
  if (!await isUntouchedChatHistory(record.session.path, sessionId)) return false;
  if (!await isUntouchedChatAssets(record.assetDirectory, paths)) return false;

  await rm(record.assetDirectory, { recursive: true, force: true });
  await rm(record.session.path);
  return true;
}

export async function eraseChatAssets(sessionId: string, paths = resolveChatPaths()): Promise<string> {
  const record = requireUnique(await listChats("all", paths), sessionId, "Chat");
  if (record.state === "active") await assertNotLeased(record.session.path);
  const directory = record.assetDirectory ?? (record.state === "active" ? resolve(record.session.cwd) : undefined);
  if (!directory) throw new Error(`Chat ${sessionId} has no managed asset directory.`);
  assertContained(directory, record.state === "active" ? paths.activeAssets : paths.archiveAssets, "Chat assets");
  await rm(directory, { recursive: true, force: true });
  if (record.state === "active") {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "canvas.md"), "", { encoding: "utf8", flag: "wx" });
  }
  return directory;
}

export async function deleteArchivedChat(
  sessionId: string,
  paths = resolveChatPaths(),
  ownership?: ChatMutationOwnership,
): Promise<void> {
  const record = requireUnique(await listChats("archived", paths), sessionId, "archived");
  assertContained(record.session.path, paths.archiveHistory, "archived Chat history");
  await assertMutationOwnership(record.session.path, ownership, "delete");
  const stagingRoot = join(paths.root, "delete-staging", crypto.randomUUID());
  const stagedHistory = join(stagingRoot, "history.jsonl");
  const stagedAssets = record.assetDirectory ? join(stagingRoot, "assets") : undefined;
  await mkdir(stagingRoot, { recursive: true });
  await rename(record.session.path, stagedHistory);
  try {
    if (record.assetDirectory && stagedAssets) {
      assertContained(record.assetDirectory, paths.archiveAssets, "archived Chat assets");
      await rename(record.assetDirectory, stagedAssets);
    }
  } catch (error) {
    await rename(stagedHistory, record.session.path).catch(() => undefined);
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  // Crossing this rename boundary commits deletion. Cleanup is best effort;
  // an interrupted cleanup leaves data only in the unscanned staging root.
  await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
}

export async function importChatAttachment(chatDirectory: string, sourcePath: string, displayName: string): Promise<{ id: string; name: string; path: string; sizeBytes: number }> {
  const directory = resolve(chatDirectory);
  const source = resolve(sourcePath);
  const manifestPath = join(directory, "attachments.json");
  const existingManifest = await readAttachmentManifest(manifestPath);
  const existingRelative = containedRelative(source, directory);
  const existing = existingRelative
    ? existingManifest.find((entry) => resolve(directory, entry.path) === source)
    : undefined;
  if (existing) return { ...existing, path: source };
  const stats = await stat(source);
  if (!stats.isFile()) throw new Error("Only regular files can be attached to Chat.");
  const id = crypto.randomUUID();
  const safeName = displayName.replace(/[^a-zA-Z0-9._ -]+/g, "_").slice(0, 120) || "attachment";
  const attachments = join(directory, "attachments");
  await ensureAttachmentDirectory(attachments);
  const destination = join(attachments, `${id}-${safeName}`);
  await copyFile(source, destination, constants.COPYFILE_EXCL);
  const manifest = existingManifest;
  manifest.push({ id, name: safeName, path: relative(directory, destination), sizeBytes: stats.size });
  await atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { id, name: safeName, path: destination, sizeBytes: stats.size };
}

export async function importChatAttachmentBytes(chatDirectory: string, data: Uint8Array, displayName: string): Promise<{ id: string; name: string; path: string; sizeBytes: number }> {
  const directory = resolve(chatDirectory);
  const id = crypto.randomUUID();
  const safeName = displayName.replace(/[^a-zA-Z0-9._ -]+/g, "_").slice(0, 120) || "attachment";
  const attachments = join(directory, "attachments");
  await ensureAttachmentDirectory(attachments);
  const destination = join(attachments, `${id}-${safeName}`);
  await writeFile(destination, data, { flag: "wx" });
  const manifestPath = join(directory, "attachments.json");
  const manifest = await readAttachmentManifest(manifestPath);
  manifest.push({ id, name: safeName, path: relative(directory, destination), sizeBytes: data.byteLength });
  await atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { id, name: safeName, path: destination, sizeBytes: data.byteLength };
}

async function ensureAttachmentDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("Chat attachments directory must be a regular directory, not a symbolic link.");
  }
}

export async function readAttachmentManifest(path: string): Promise<Array<{ id: string; name: string; path: string; sizeBytes: number }>> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return Array.isArray(parsed) ? parsed.filter((entry) => entry && typeof entry.id === "string" && typeof entry.name === "string" && typeof entry.path === "string") : [];
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return [];
    throw error;
  }
}

export function requireUnique(records: readonly ChatStorageRecord[], sessionId: string, state: string): ChatStorageRecord {
  const matches = records.filter((record) => record.session.id === sessionId);
  if (matches.length === 0) throw new Error(`No ${state} Chat found with ID ${sessionId}.`);
  if (matches.length > 1) throw new Error(`Multiple ${state} Chats have ID ${sessionId}.`);
  return matches[0]!;
}

async function inspectAssets(root: string): Promise<{ bytes: number; attachments: number }> {
  let bytes = 0;
  let attachments = 0;
  async function visit(directory: string): Promise<void> {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (isErrorCode(error, "ENOENT")) return; throw error; }
    await Promise.all(entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return visit(path);
      if (!entry.isFile() || entry.isSymbolicLink()) return;
      bytes += (await stat(path)).size;
      if (containedRelative(path, join(root, "attachments"))) attachments += 1;
    }));
  }
  await visit(root);
  return { bytes, attachments };
}

async function fileSize(path: string): Promise<number> {
  try { return (await stat(path)).size; } catch { return 0; }
}

async function assertNotLeased(sessionFile: string): Promise<void> {
  if (await exists(`${sessionFile}.lease`)) throw new Error(`Chat is attached and cannot be changed safely: ${sessionFile}`);
}

async function assertMutationOwnership(
  sessionFile: string,
  ownership: ChatMutationOwnership | undefined,
  operation = "archive",
): Promise<void> {
  if (!ownership) {
    await assertNotLeased(sessionFile);
    return;
  }

  try {
    const parsed = JSON.parse(await readFile(`${sessionFile}.lease`, "utf8")) as { ownerId?: unknown };
    if (parsed.ownerId === ownership.ownerId) return;
  } catch {
    // A missing, malformed, or replaced diagnostic lease cannot prove that the
    // caller still owns the lock acquisition it claims.
  }
  throw new Error(`Chat writer ownership changed before ${operation}: ${sessionFile}`);
}

async function isUntouchedChatHistory(sessionFile: string, sessionId: string): Promise<boolean> {
  let entries: unknown[];
  try {
    entries = (await readFile(sessionFile, "utf8"))
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as unknown);
  } catch {
    return false;
  }

  if (entries.length !== 2) return false;
  const [header, info] = entries as Array<Record<string, unknown>>;
  return header?.type === "session"
    && header.id === sessionId
    && info?.type === "session_info"
    && info.name === "New chat";
}

async function isUntouchedChatAssets(assetDirectory: string, paths: ChatPaths): Promise<boolean> {
  try {
    assertContained(assetDirectory, paths.activeAssets, "active Chat assets");
    const directoryStats = await lstat(assetDirectory);
    if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) return false;
    const entries = await readdir(assetDirectory, { withFileTypes: true });
    if (entries.length !== 1 || entries[0]?.name !== "canvas.md") return false;
    if (!entries[0].isFile() || entries[0].isSymbolicLink()) return false;
    return (await readFile(join(assetDirectory, "canvas.md"), "utf8")).length === 0;
  } catch {
    return false;
  }
}

async function moveDirectory(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  if (await exists(destination)) throw new Error(`Refusing to overwrite existing Chat assets: ${destination}`);
  await rename(source, destination);
}

async function moveFile(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  if (await exists(destination)) throw new Error(`Refusing to overwrite existing Chat history: ${destination}`);
  try { await rename(source, destination); }
  catch (error) {
    if (!isErrorCode(error, "EXDEV")) throw error;
    await copyFile(source, destination, constants.COPYFILE_EXCL);
    await rm(source);
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, path);
}

export function assertContained(path: string, root: string, label: string): string {
  const child = containedRelative(path, root);
  if (!child) throw new Error(`Path is outside ${label}: ${path}`);
  return child;
}

function containedRelative(path: string, root: string): string | undefined {
  const child = relative(resolve(root), resolve(path));
  return child && child !== ".." && !child.startsWith("../") && !child.startsWith("..\\") && !isAbsolute(child) ? child : undefined;
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

function isErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === code);
}
