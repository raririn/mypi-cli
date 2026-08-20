import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import readonlyExtension, {
  loadReadonlyConfig,
  NOREAD_NOTICE,
  parseNoreadCommand,
  parseReadonlyCommand,
  READONLY_NOTICE,
  readonlyConfigPath,
  saveReadonlyConfig,
} from "../../src/product/mypi-readonly.ts";

type Handler = (event: any, ctx: any) => unknown;
type CommandDefinition = {
  getArgumentCompletions?: (prefix: string) => Array<{ value: string }> | null;
  handler: (args: string, ctx: any) => Promise<void>;
};

async function harness(agentDir: string) {
  const previousAgentDir = process.env.MYPI_AGENT_DIR;
  process.env.MYPI_AGENT_DIR = agentDir;
  const commands = new Map<string, CommandDefinition>();
  const handlers = new Map<string, Handler[]>();
  const notifications: Array<{ message: string; level?: string }> = [];
  const statuses: Array<string | undefined> = [];
  const sentPrompts: string[] = [];
  const openedHelp: string[] = [];
  let idle = true;
  let aborts = 0;
  const tools = ["read", "grep", "find", "ls", "write", "edit", "bash"].map((name) => ({
    name,
    sourceInfo: { path: `<builtin:${name}>`, source: "builtin", scope: "temporary", origin: "top-level" },
  }));
  for (const name of ["web_search", "web_fetch"]) {
    tools.push({
      name,
      sourceInfo: {
        path: "<product:capability:web>",
        source: "product",
        scope: "temporary",
        origin: "top-level",
        productClass: "capability",
      },
    });
  }

  const pi = {
    registerCommand(name: string, definition: CommandDefinition) { commands.set(name, definition); },
    on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    getAllTools() { return tools; },
    getCommands() {
      return [
        { name: "local-skill", source: "skill", sourceInfo: { path: "/tmp/SKILL.md", source: "test", scope: "project", origin: "top-level" } },
        { name: "local-template", source: "prompt", sourceInfo: { path: "/tmp/prompt.md", source: "test", scope: "project", origin: "top-level" } },
      ];
    },
    sendUserMessage(prompt: string) { sentPrompts.push(prompt); },
  } as unknown as ExtensionAPI;
  const ctx = {
    isIdle: () => idle,
    waitForIdle: async () => { idle = true; },
    abort: () => { aborts++; idle = true; },
    ui: {
      setStatus: (_key: string, value: string | undefined) => { statuses.push(value); },
      notify: (message: string, level?: string) => { notifications.push({ message, level }); },
      editor: async (_title: string, content: string) => { openedHelp.push(content); return undefined; },
    },
  };

  await readonlyExtension(pi);
  if (previousAgentDir === undefined) delete process.env.MYPI_AGENT_DIR;
  else process.env.MYPI_AGENT_DIR = previousAgentDir;

  return {
    commands,
    ctx,
    handlers,
    notifications,
    statuses,
    sentPrompts,
    openedHelp,
    tools,
    setIdle(value: boolean) { idle = value; },
    get aborts() { return aborts; },
    async emit(name: string, event: unknown = {}) {
      let result: unknown;
      for (const handler of handlers.get(name) ?? []) {
        const next = await handler(event, ctx);
        if (next !== undefined) result = next;
      }
      return result;
    },
  };
}

test("parses the documented readonly and noread grammars", () => {
  assert.deepEqual(parseReadonlyCommand(""), { mode: "once", prompt: "" });
  assert.deepEqual(parseReadonlyCommand("review the auth flow"), { mode: "once", prompt: "review the auth flow" });
  assert.deepEqual(parseReadonlyCommand("--always inspect this"), { mode: "always", prompt: "inspect this" });
  assert.deepEqual(parseReadonlyCommand("--never continue normally"), { mode: "never", prompt: "continue normally" });
  assert.deepEqual(parseReadonlyCommand("help"), { mode: "help", prompt: "" });
  assert.deepEqual(parseReadonlyCommand("--help"), { mode: "help", prompt: "" });
  assert.match((parseReadonlyCommand("--sometimes") as { error: string }).error, /Unknown option/);

  assert.deepEqual(parseNoreadCommand(""), { mode: "once", prompt: "" });
  assert.deepEqual(parseNoreadCommand("discuss this"), { mode: "once", prompt: "discuss this" });
  assert.deepEqual(parseNoreadCommand("--always research this"), { mode: "always", prompt: "research this" });
  assert.deepEqual(parseNoreadCommand("--never continue normally"), { mode: "never", prompt: "continue normally" });
  assert.deepEqual(parseNoreadCommand("help"), { mode: "help", prompt: "" });
  assert.deepEqual(parseNoreadCommand("--help"), { mode: "help", prompt: "" });
  assert.match((parseNoreadCommand("--sometimes") as { error: string }).error, /Unknown option/);
});

test("access config defaults to never, migrates v1, persists atomically, and rejects symlinks", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-readonly-config-"));
  try {
    assert.equal(loadReadonlyConfig(root).config.preference, "never");
    writeFileSync(readonlyConfigPath(root), JSON.stringify({ version: 1, preference: "always" }));
    assert.equal(loadReadonlyConfig(root).config.preference, "readonly");

    saveReadonlyConfig(root, { version: 2, preference: "noread" });
    assert.equal(loadReadonlyConfig(root).config.preference, "noread");
    assert.equal(lstatSync(readonlyConfigPath(root)).mode & 0o777, 0o600);

    const path = readonlyConfigPath(root);
    rmSync(path);
    const target = join(root, "target.json");
    writeFileSync(target, JSON.stringify({ version: 2, preference: "noread" }));
    symlinkSync(target, path);
    assert.equal(loadReadonlyConfig(root).config.preference, "never");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("/readonly [prompt] enforces one settled run and then restores access", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-readonly-once-"));
  try {
    const h = await harness(root);
    await h.emit("session_start");
    await h.commands.get("readonly")!.handler("inspect the project", h.ctx);
    assert.deepEqual(h.sentPrompts, ["inspect the project"]);
    assert.equal(h.statuses.at(-1), "READ ONLY");
    assert.deepEqual(await h.emit("input", { text: "inspect the project", source: "extension" }), { action: "continue" });
    assert.deepEqual(await h.emit("input", { text: "steer elsewhere", source: "interactive" }), { action: "handled" });
    assert.equal(await h.emit("tool_call", { toolName: "read", input: { path: "README.md" } }), undefined);
    assert.equal((await h.emit("tool_call", { toolName: "write", input: { path: "x" } }) as { block: boolean }).block, true);

    const base = { role: "assistant", content: [{ type: "text", text: "Done." }], stopReason: "stop" };
    const result = await h.emit("message_end", { message: base }) as { message: { content: Array<{ text?: string }> } };
    assert.equal(result.message.content.at(-1)?.text, READONLY_NOTICE);
    assert.match(READONLY_NOTICE, /^---\n\n🔒 /);

    await h.emit("agent_settled");
    assert.equal(h.statuses.at(-1), undefined);
    assert.equal(await h.emit("tool_call", { toolName: "write", input: { path: "x" } }), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("allows provenance-verified web reads and blocks a spoofed same-name tool", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-readonly-web-"));
  try {
    const h = await harness(root);
    await h.commands.get("readonly")!.handler("inspect current docs", h.ctx);
    assert.equal(await h.emit("tool_call", { toolName: "web_search", input: { query: "Pi docs" } }), undefined);
    assert.equal(await h.emit("tool_call", { toolName: "web_fetch", input: { url: "https://example.com" } }), undefined);

    const webSearch = h.tools.find((tool) => tool.name === "web_search")!;
    webSearch.sourceInfo = { path: "<sdk:web_search>", source: "sdk", scope: "temporary", origin: "top-level" };
    assert.equal((await h.emit("tool_call", { toolName: "web_search", input: { query: "spoof" } }) as { block: boolean }).block, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("commands without a prompt never dispatch a model message", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-readonly-no-prompt-"));
  try {
    const h = await harness(root);
    const readonly = h.commands.get("readonly")!;
    const noread = h.commands.get("noread")!;

    await readonly.handler("", h.ctx);
    await readonly.handler("--always", h.ctx);
    await readonly.handler("--never", h.ctx);
    await readonly.handler("help", h.ctx);
    await noread.handler("", h.ctx);
    await noread.handler("--always", h.ctx);
    await noread.handler("--never", h.ctx);
    await noread.handler("help", h.ctx);

    assert.deepEqual(h.sentPrompts, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("bare /readonly arms the next prompt only", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-readonly-armed-"));
  try {
    const h = await harness(root);
    await h.commands.get("readonly")!.handler("", h.ctx);
    assert.deepEqual(h.sentPrompts, []);
    assert.equal(h.statuses.at(-1), "READ ONLY NEXT");
    assert.deepEqual(await h.emit("input", { text: "next prompt", source: "interactive" }), { action: "continue" });
    assert.equal(h.statuses.at(-1), "READ ONLY");
    assert.equal((await h.emit("tool_call", { toolName: "bash", input: { command: "pwd" } }) as { block: boolean }).block, true);
    await h.emit("agent_settled");
    assert.equal(h.statuses.at(-1), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("--always and --never persist, accept prompts, and expose the documented completions", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-readonly-persistent-"));
  try {
    const h = await harness(root);
    await h.commands.get("readonly")!.handler("--always inspect forever", h.ctx);
    assert.equal(loadReadonlyConfig(root).config.preference, "readonly");
    assert.deepEqual(h.sentPrompts, ["inspect forever"]);
    assert.equal(h.statuses.at(-1), "READ ONLY");
    await h.emit("agent_settled");
    assert.equal(h.statuses.at(-1), "READ ONLY");

    assert.deepEqual(h.commands.get("readonly")!.getArgumentCompletions!(""), [
      { value: "--always", label: "--always" },
      { value: "--never", label: "--never" },
      { value: "help", label: "help" },
    ]);

    await h.commands.get("readonly")!.handler("--never continue normally", h.ctx);
    assert.equal(loadReadonlyConfig(root).config.preference, "never");
    assert.deepEqual(h.sentPrompts, ["inspect forever", "continue normally"]);
    assert.equal(h.statuses.at(-1), undefined);
    assert.equal(await h.emit("tool_call", { toolName: "write", input: { path: "x" } }), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("/noread --always and --never persist, accept prompts, and preserve remaining read-only status", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-noread-persistent-prompt-"));
  try {
    const h = await harness(root);
    const readonly = h.commands.get("readonly")!;
    const noread = h.commands.get("noread")!;

    await noread.handler("--always discuss forever", h.ctx);
    assert.equal(loadReadonlyConfig(root).config.preference, "noread");
    assert.deepEqual(h.sentPrompts, ["discuss forever"]);
    assert.equal(h.statuses.at(-1), "NO READ");
    assert.equal((await h.emit("tool_call", { toolName: "read", input: { path: "README.md" } }) as { block: boolean }).block, true);
    await h.emit("agent_settled");
    assert.equal(h.statuses.at(-1), "NO READ");

    await noread.handler("--never continue normally", h.ctx);
    assert.equal(loadReadonlyConfig(root).config.preference, "never");
    assert.deepEqual(h.sentPrompts, ["discuss forever", "continue normally"]);
    assert.equal(h.statuses.at(-1), undefined);
    assert.equal(await h.emit("tool_call", { toolName: "read", input: { path: "README.md" } }), undefined);

    await readonly.handler("--always", h.ctx);
    await noread.handler("--never inspect under read-only", h.ctx);
    assert.equal(loadReadonlyConfig(root).config.preference, "readonly");
    assert.deepEqual(h.sentPrompts, ["discuss forever", "continue normally", "inspect under read-only"]);
    assert.equal(h.statuses.at(-1), "READ ONLY");
    assert.equal((await h.emit("tool_call", { toolName: "write", input: { path: "x" } }) as { block: boolean }).block, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("help opens the reference and bridged commands use the shared parser", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-readonly-bridge-"));
  try {
    const h = await harness(root);
    await h.commands.get("readonly")!.handler("help", h.ctx);
    assert.match(h.openedHelp[0]!, /\/readonly \[--always\|--never\|help\] \[prompt\]/);

    assert.deepEqual(await h.emit("input", { text: "/readonly inspect bridge", source: "extension" }), { action: "handled" });
    assert.deepEqual(h.sentPrompts, ["inspect bridge"]);
    assert.equal(h.statuses.at(-1), "READ ONLY");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("persistent enable aborts active work before changing policy", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-readonly-abort-"));
  try {
    const h = await harness(root);
    h.setIdle(false);
    await h.commands.get("readonly")!.handler("--always", h.ctx);
    assert.equal(h.aborts, 1);
    assert.equal(h.statuses.at(-1), "READ ONLY");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("/noread <prompt> immediately runs one contextless web-only prompt", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-noread-prompt-"));
  try {
    const h = await harness(root);
    await h.emit("session_start");
    await h.commands.get("noread")!.handler("Discuss API design", h.ctx);

    assert.deepEqual(h.sentPrompts, ["Discuss API design"]);
    assert.equal(h.statuses.at(-1), "NO READ");
    assert.deepEqual(await h.emit("input", { text: "Discuss API design", source: "extension" }), { action: "continue" });
    assert.equal((await h.emit("tool_call", { toolName: "read", input: { path: "README.md" } }) as { block: boolean }).block, true);
    assert.equal(await h.emit("tool_call", { toolName: "web_search", input: { query: "API design" } }), undefined);

    await h.emit("agent_settled");
    assert.equal(h.statuses.at(-1), undefined);
    assert.equal(await h.emit("tool_call", { toolName: "read", input: { path: "README.md" } }), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("inline /noread rejects local resource expansion without leaving one-shot mode active", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-noread-resource-prompt-"));
  try {
    const h = await harness(root);
    await h.commands.get("noread")!.handler("/local-skill", h.ctx);

    assert.equal(h.statuses.at(-1), "NO READ");
    assert.deepEqual(await h.emit("input", { text: "/local-skill", source: "extension" }), { action: "handled" });
    assert.match(h.notifications.at(-1)!.message, /blocked local skill expansion/);
    assert.equal(h.statuses.at(-1), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("bare /noread arms one contextless web-only prompt and restores normal access", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-noread-once-"));
  try {
    const h = await harness(root);
    await h.emit("session_start");
    const command = h.commands.get("noread")!;
    await command.handler("", h.ctx);
    assert.equal(h.statuses.at(-1), "NO READ NEXT");
    assert.deepEqual(h.sentPrompts, []);

    assert.deepEqual(await h.emit("input", { text: "/local-skill", source: "interactive" }), { action: "handled" });
    assert.equal(h.statuses.at(-1), "NO READ NEXT");
    assert.deepEqual(await h.emit("input", { text: "Discuss API design", source: "interactive" }), { action: "continue" });
    assert.equal(h.statuses.at(-1), "NO READ");

    assert.equal((await h.emit("tool_call", { toolName: "read", input: { path: "README.md" } }) as { block: boolean }).block, true);
    assert.equal((await h.emit("tool_call", { toolName: "write", input: { path: "x" } }) as { block: boolean }).block, true);
    assert.equal(await h.emit("tool_call", { toolName: "web_search", input: { query: "API design" } }), undefined);
    assert.equal(await h.emit("tool_call", { toolName: "web_fetch", input: { url: "https://example.com" } }), undefined);
    const webSearch = h.tools.find((tool) => tool.name === "web_search")!;
    webSearch.sourceInfo = { path: "<sdk:web_search>", source: "sdk", scope: "temporary", origin: "top-level" };
    assert.equal((await h.emit("tool_call", { toolName: "web_search", input: { query: "spoof" } }) as { block: boolean }).block, true);

    const promptResult = await h.emit("before_agent_start", {
      systemPrompt: "SECRET LOCAL PROJECT CONTEXT",
      systemPromptOptions: { cwd: "/secret/project", contextFiles: [{ path: "AGENTS.md", content: "SECRET" }] },
    }) as { systemPrompt: string };
    assert.doesNotMatch(promptResult.systemPrompt, /SECRET|\/secret\/project|AGENTS\.md/);
    assert.match(promptResult.systemPrompt, /contextless discussion/);
    assert.match(promptResult.systemPrompt, /You are running in MyPi\./);
    assert.match(promptResult.systemPrompt, /accessed through MyPi/);

    const base = { role: "assistant", content: [{ type: "text", text: "Done." }], stopReason: "stop" };
    const result = await h.emit("message_end", { message: base }) as { message: { content: Array<{ text?: string }> } };
    assert.equal(result.message.content.at(-1)?.text, NOREAD_NOTICE);
    assert.match(NOREAD_NOTICE, /^---\n\n🌐 /);

    await h.emit("agent_settled");
    assert.equal(h.statuses.at(-1), undefined);
    assert.equal(await h.emit("tool_call", { toolName: "read", input: { path: "README.md" } }), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("persistent noread and readonly are mutually exclusive without cross-disabling", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-access-modes-"));
  try {
    const h = await harness(root);
    const readonly = h.commands.get("readonly")!;
    const noread = h.commands.get("noread")!;

    await readonly.handler("--always", h.ctx);
    assert.equal(loadReadonlyConfig(root).config.preference, "readonly");
    await noread.handler("--always", h.ctx);
    assert.equal(loadReadonlyConfig(root).config.preference, "noread");
    assert.equal(h.statuses.at(-1), "NO READ");

    await readonly.handler("inspect locally", h.ctx);
    assert.deepEqual(h.sentPrompts, []);
    assert.match(h.notifications.at(-1)!.message, /Persistent no-read mode is active/);

    await readonly.handler("--never", h.ctx);
    assert.equal(loadReadonlyConfig(root).config.preference, "noread");
    await noread.handler("--never", h.ctx);
    assert.equal(loadReadonlyConfig(root).config.preference, "never");

    await readonly.handler("--always", h.ctx);
    await noread.handler("", h.ctx);
    assert.equal(h.statuses.at(-1), "NO READ NEXT");
    await h.emit("input", { text: "Discuss without files", source: "interactive" });
    assert.equal(h.statuses.at(-1), "NO READ");
    await h.emit("agent_settled");
    assert.equal(h.statuses.at(-1), "READ ONLY");
    assert.equal(loadReadonlyConfig(root).config.preference, "readonly");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("/noread exposes control options and handles bridged prompts", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-noread-command-"));
  try {
    const h = await harness(root);
    const command = h.commands.get("noread")!;
    assert.deepEqual(command.getArgumentCompletions!(""), [
      { value: "--always", label: "--always" },
      { value: "--never", label: "--never" },
      { value: "help", label: "help" },
    ]);
    await command.handler("help", h.ctx);
    assert.match(h.openedHelp.at(-1)!, /\/noread \[prompt\]/);
    assert.deepEqual(await h.emit("input", { text: "/noread Discuss bridge behavior", source: "extension" }), { action: "handled" });
    assert.deepEqual(h.sentPrompts, ["Discuss bridge behavior"]);
    assert.equal(h.statuses.at(-1), "NO READ");
    await h.emit("agent_settled");

    assert.deepEqual(await h.emit("input", { text: "/noread --always", source: "extension" }), { action: "handled" });
    assert.deepEqual(h.sentPrompts, ["Discuss bridge behavior"]);
    assert.equal(loadReadonlyConfig(root).config.preference, "noread");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
