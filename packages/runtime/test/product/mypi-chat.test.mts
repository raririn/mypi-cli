import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import chatExtension, { CHAT_TOOL_NAMES } from "../../src/product/mypi-chat.ts";
import chatManageExtension from "../../src/product/mypi-chat-manage.ts";
import {
  archiveChat,
  deleteArchivedChat,
  discardUntouchedChat,
  eraseChatAssets,
  importChatAttachment,
  importChatAttachmentBytes,
  listChats,
  resolveChatPaths,
  restoreChat,
} from "../../src/product/mypi-chat-storage.ts";

const MANAGEMENT_TOOLS = [
  "list_chats",
  "inspect_chat_storage",
  "archive_chat",
  "restore_chat",
  "erase_chat_assets",
  "delete_archived_chat",
];

function extensionHarness(actionMethodsRequireRuntime = false) {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const sent: string[] = [];
  let activeTools = ["read", "bash"];
  let runtimeReady = !actionMethodsRequireRuntime;
  const requireRuntime = () => {
    if (!runtimeReady) throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading.");
  };
  const api = {
    registerTool(tool: any) { tools.set(tool.name, tool); activeTools.push(tool.name); },
    registerCommand(name: string, command: any) { commands.set(name, command); },
    on(name: string, handler: (event: any, ctx: any) => any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    getActiveTools() { requireRuntime(); return [...activeTools]; },
    setActiveTools(names: string[]) { requireRuntime(); activeTools = [...names]; },
    sendUserMessage(message: string) { requireRuntime(); sent.push(message); },
  };
  const context = (cwd: string, sessionManager?: SessionManager) => ({
    cwd,
    sessionManager,
    isIdle: () => true,
    ui: { setStatus: () => undefined, notify: () => undefined },
  });
  return {
    api,
    tools,
    commands,
    sent,
    context,
    finishLoading() { runtimeReady = true; },
    activeTools: () => [...activeTools],
    async emit(name: string, event: any, ctx: any) {
      let result;
      for (const handler of handlers.get(name) ?? []) {
        const next = await handler(event, ctx);
        if (next !== undefined) result = next;
      }
      return result;
    },
  };
}

async function execute(tool: any, input: Record<string, unknown>, ctx: any) {
  return tool.execute("test", input, undefined, undefined, ctx);
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

test("Chat exposes only bounded canvas, attachment, calculator, and web tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-tools-"));
  try {
    await writeFile(join(root, "canvas.md"), "# Notes\nold");
    const source = join(root, "source.txt");
    await writeFile(source, "attachment contents");
    const imported = await importChatAttachment(root, source, "notes.txt");
    const harness = extensionHarness();
    chatExtension(harness.api as any);
    const ctx = harness.context(root);

    assert.deepEqual([...harness.tools.keys()].sort(), [...CHAT_TOOL_NAMES].sort());
    assert.equal((await execute(harness.tools.get("read_canvas"), {}, ctx)).content[0].text, "# Notes\nold");
    await execute(harness.tools.get("edit_canvas"), { old_text: "old", new_text: "new" }, ctx);
    assert.equal(await readFile(join(root, "canvas.md"), "utf8"), "# Notes\nnew");
    await execute(harness.tools.get("replace_canvas"), { markdown: "# Draft" }, ctx);
    assert.equal(await readFile(join(root, "canvas.md"), "utf8"), "# Draft");
    assert.match((await execute(harness.tools.get("list_attachments"), {}, ctx)).content[0].text, new RegExp(imported.id));
    assert.equal((await execute(harness.tools.get("read_attachment"), { attachment_id: imported.id }, ctx)).content[0].text, "attachment contents");
    assert.equal((await execute(harness.tools.get("calculate"), { expression: "2^3 + 4*(5-2)" }, ctx)).content[0].text, "2^3 + 4*(5-2) = 20");
    await assert.rejects(execute(harness.tools.get("calculate"), { expression: "process.exit()" }, ctx), /unsupported characters/);

    const prompt = await harness.emit("before_agent_start", { systemPrompt: "unsafe inherited prompt" }, ctx);
    assert.match(prompt.systemPrompt, /focused workspace/);
    assert.equal(prompt.systemPrompt.includes("unsafe inherited prompt"), false);
    assert.match(prompt.systemPrompt, /You are MyPi Chat/);
    assert.match(prompt.systemPrompt, /You are running in MyPi\./);
    assert.deepEqual(await harness.emit("tool_call", { toolName: "bash" }, ctx), { block: true, reason: "MyPi Chat does not allow bash." });
    assert.equal((await harness.emit("user_bash", {}, ctx)).result.exitCode, 126);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Chat rejects a symlinked attachments directory for imports and reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-attachment-symlink-"));
  const chat = join(root, "chat");
  const outside = join(root, "outside");
  try {
    await Promise.all([mkdir(chat), mkdir(outside)]);
    await symlink(outside, join(chat, "attachments"), "dir");
    const source = join(root, "source.txt");
    await writeFile(source, "do not copy outside");

    await assert.rejects(importChatAttachment(chat, source, "source.txt"), /regular directory|symbolic link/);
    await assert.rejects(importChatAttachmentBytes(chat, new TextEncoder().encode("bytes"), "bytes.txt"), /regular directory|symbolic link/);
    assert.deepEqual(await readdir(outside), []);

    await writeFile(join(outside, "escaped.txt"), "escaped contents");
    await writeFile(join(chat, "attachments.json"), `${JSON.stringify([{ id: "escaped", name: "escaped.txt", path: "attachments/escaped.txt", sizeBytes: 16 }])}\n`);
    const harness = extensionHarness();
    chatExtension(harness.api as any);
    await assert.rejects(
      execute(harness.tools.get("read_attachment"), { attachment_id: "escaped" }, harness.context(chat)),
      /escaped Chat storage through a symbolic link/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Chat history, canvas, and attachments move and delete as one managed unit", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-chat-storage-"));
  const previousRoot = process.env.PI_GUI_CHAT_ROOT;
  const paths = resolveChatPaths(agentDir);
  process.env.PI_GUI_CHAT_ROOT = paths.root;
  try {
    const assetDirectory = join(paths.activeAssets, "chat-one");
    await mkdir(assetDirectory, { recursive: true });
    await writeFile(join(assetDirectory, "canvas.md"), "draft", { flag: "wx" });
    const source = join(agentDir, "attachment.txt");
    await writeFile(source, "copied");
    await importChatAttachment(assetDirectory, source, "attachment.txt");
    const session = SessionManager.create(assetDirectory, paths.activeHistory);
    session.appendSessionInfo("Storage test");
    session.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
    (session as any)._rewriteFile();
    (session as any).flushed = true;

    let records = await listChats("active", paths);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.attachmentCount, 1);
    assert.equal(records[0]?.assetDirectory, assetDirectory);

    await archiveChat(session.getSessionId(), paths);
    assert.equal((await listChats("active", paths)).length, 0);
    records = await listChats("archived", paths);
    assert.equal(records.length, 1);
    assert.equal(await exists(assetDirectory), false);

    await restoreChat(session.getSessionId(), paths);
    assert.equal((await listChats("active", paths)).length, 1);
    assert.equal(await readFile(join(assetDirectory, "canvas.md"), "utf8"), "draft");

    await eraseChatAssets(session.getSessionId(), paths);
    assert.equal(await readFile(join(assetDirectory, "canvas.md"), "utf8"), "");
    assert.equal(await exists(join(assetDirectory, "attachments.json")), false);

    await archiveChat(session.getSessionId(), paths);
    await deleteArchivedChat(session.getSessionId(), paths);
    assert.equal((await listChats("all", paths)).length, 0);
  } finally {
    if (previousRoot === undefined) delete process.env.PI_GUI_CHAT_ROOT;
    else process.env.PI_GUI_CHAT_ROOT = previousRoot;
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("Chat archive accepts only the diagnostic lease for the caller's lock acquisition", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-chat-owned-archive-"));
  const paths = resolveChatPaths(agentDir);
  try {
    const assetDirectory = join(paths.activeAssets, "owned-chat");
    await mkdir(assetDirectory, { recursive: true });
    const session = SessionManager.create(assetDirectory, paths.activeHistory);
    session.appendSessionInfo("Owned archive");
    (session as any)._rewriteFile();
    (session as any).flushed = true;
    const sessionFile = session.getSessionFile()!;
    await writeFile(`${sessionFile}.lease`, JSON.stringify({
      pid: process.pid,
      hostname: "test-host",
      startedAt: new Date().toISOString(),
      surface: "mypi-gui",
      ownerId: "owned-acquisition",
    }));

    await assert.rejects(
      archiveChat(session.getSessionId(), paths),
      /attached and cannot be changed safely/,
    );
    await assert.rejects(
      archiveChat(session.getSessionId(), paths, { ownerId: "replaced-acquisition" }),
      /writer ownership changed before archive/,
    );
    await archiveChat(session.getSessionId(), paths, { ownerId: "owned-acquisition" });
    assert.equal((await listChats("active", paths)).length, 0);
    assert.equal((await listChats("archived", paths)).length, 1);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("Chat cleanup removes only the exact untouched New chat placeholder", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-chat-untouched-"));
  const paths = resolveChatPaths(agentDir);
  try {
    const createChat = async (directoryName: string, title = "New chat", canvas = "") => {
      const assetDirectory = join(paths.activeAssets, directoryName);
      await mkdir(assetDirectory, { recursive: true });
      await writeFile(join(assetDirectory, "canvas.md"), canvas, { flag: "wx" });
      const session = SessionManager.create(assetDirectory, paths.activeHistory);
      session.appendSessionInfo(title);
      (session as any)._rewriteFile();
      (session as any).flushed = true;
      const sessionFile = session.getSessionFile()!;
      await writeFile(`${sessionFile}.lease`, JSON.stringify({ ownerId: `${directoryName}-owner` }));
      return { assetDirectory, session, sessionFile, ownerId: `${directoryName}-owner` };
    };

    const untouched = await createChat("untouched");
    assert.equal(
      await discardUntouchedChat(untouched.session.getSessionId(), paths, { ownerId: untouched.ownerId }),
      true,
    );
    assert.equal(await exists(untouched.sessionFile), false);
    assert.equal(await exists(untouched.assetDirectory), false);

    const renamed = await createChat("renamed", "Keep this chat");
    assert.equal(await discardUntouchedChat(renamed.session.getSessionId(), paths, { ownerId: renamed.ownerId }), false);

    const canvas = await createChat("canvas", "New chat", "user notes");
    assert.equal(await discardUntouchedChat(canvas.session.getSessionId(), paths, { ownerId: canvas.ownerId }), false);

    const messaged = await createChat("messaged");
    messaged.session.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
    (messaged.session as any)._rewriteFile();
    (messaged.session as any).flushed = true;
    assert.equal(await discardUntouchedChat(messaged.session.getSessionId(), paths, { ownerId: messaged.ownerId }), false);

    const extraAsset = await createChat("extra-asset");
    await writeFile(join(extraAsset.assetDirectory, "draft.txt"), "keep me");
    assert.equal(await discardUntouchedChat(extraAsset.session.getSessionId(), paths, { ownerId: extraAsset.ownerId }), false);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("/chat-manage is a kickoff over plainly registered tools (grant retired)", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-manage-"));
  try {
    const harness = extensionHarness(true);
    assert.doesNotThrow(() => chatManageExtension(harness.api as any));
    assert.deepEqual(harness.activeTools(), ["read", "bash", ...MANAGEMENT_TOOLS]);
    harness.finishLoading();
    // Explicit session dir: default resolution would write the transcript into
    // the real ~/.mypi/agent sessions tree (ghost sessions in every client).
    const manager = SessionManager.create(root, join(root, "sessions"));
    const ctx = harness.context(root, manager);
    await harness.emit("session_start", {}, ctx);
    // Presence is governed by Settings → Tools ("chat-manage" group); no
    // per-turn grant, no tool_call gate, no restore on agent_end.
    assert.deepEqual(harness.activeTools(), ["read", "bash", ...MANAGEMENT_TOOLS]);
    assert.equal((await harness.emit("tool_call", { toolName: "list_chats" }, ctx))?.block, undefined);

    await harness.commands.get("chat-manage").handler("list chats", ctx);
    assert.deepEqual(harness.sent, ["list chats"]);
    await harness.emit("agent_end", {}, ctx);
    assert.deepEqual(harness.activeTools(), ["read", "bash", ...MANAGEMENT_TOOLS]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
