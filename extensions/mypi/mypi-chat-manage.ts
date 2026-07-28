import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { archiveChat, deleteArchivedChat, eraseChatAssets, listChats, restoreChat, type ChatStorageRecord } from "./mypi-chat-storage.mts";

const TOOL_NAMES = ["list_chats", "inspect_chat_storage", "archive_chat", "restore_chat", "erase_chat_assets", "delete_archived_chat"] as const;
const TOOL_SET = new Set<string>(TOOL_NAMES);

export default function chatManageExtension(pi: ExtensionAPI): void {
  let active = false;
  let previousTools: string[] | undefined;

  function restore(ctx?: ExtensionContext): void {
    active = false;
    if (previousTools) pi.setActiveTools(previousTools);
    else pi.setActiveTools(pi.getActiveTools().filter((name) => !TOOL_SET.has(name)));
    previousTools = undefined;
    ctx?.ui.setStatus("chat-manage", undefined);
  }

  pi.registerTool({
    name: "list_chats",
    label: "List Chats",
    description: "List active and archived MyPi Chat sessions with storage sizes.",
    parameters: Type.Object({ state: Type.Optional(Type.Union([Type.Literal("active"), Type.Literal("archived"), Type.Literal("all")])) }),
    async execute(_id, params) {
      assertActive(active);
      return textResult(formatRecords(await listChats(params.state ?? "all")));
    },
  });

  pi.registerTool({
    name: "inspect_chat_storage",
    label: "Inspect Chat Storage",
    description: "Show detailed history, canvas, and attachment storage for one Chat.",
    parameters: Type.Object({ session_id: Type.String({ minLength: 1 }) }),
    async execute(_id, params) {
      assertActive(active);
      const records = (await listChats("all")).filter((record) => record.session.id === params.session_id);
      if (records.length !== 1) throw new Error(`Expected one Chat with ID ${params.session_id}; found ${records.length}.`);
      return textResult(formatRecords(records));
    },
  });

  pi.registerTool({
    name: "archive_chat",
    label: "Archive Chat",
    description: "Move an inactive Chat's history, canvas, and attachments out of active discovery.",
    parameters: Type.Object({ session_id: Type.String({ minLength: 1 }) }),
    async execute(_id, params) {
      assertActive(active);
      const result = await archiveChat(params.session_id);
      return textResult(`Archived Chat ${params.session_id}\nfrom: ${result.source}\nto: ${result.destination}`);
    },
  });

  pi.registerTool({
    name: "restore_chat",
    label: "Restore Chat",
    description: "Restore an archived Chat and its managed assets.",
    parameters: Type.Object({ session_id: Type.String({ minLength: 1 }) }),
    async execute(_id, params) {
      assertActive(active);
      const result = await restoreChat(params.session_id);
      return textResult(`Restored Chat ${params.session_id}\nfrom: ${result.source}\nto: ${result.destination}`);
    },
  });

  pi.registerTool({
    name: "erase_chat_assets",
    label: "Erase Chat Assets",
    description: "Permanently erase one inactive Chat's canvas and copied attachments while preserving conversation history.",
    parameters: Type.Object({ session_id: Type.String({ minLength: 1 }), confirm: Type.Literal(true) }),
    async execute(_id, params) {
      assertActive(active);
      if (params.confirm !== true) throw new Error("Erasing Chat assets requires confirm=true after explicit user confirmation.");
      const path = await eraseChatAssets(params.session_id);
      return textResult(`Erased canvas and copied attachments for Chat ${params.session_id}: ${path}`);
    },
  });

  pi.registerTool({
    name: "delete_archived_chat",
    label: "Delete Archived Chat",
    description: "Permanently delete an archived Chat, including history, canvas, and copied attachments.",
    parameters: Type.Object({ session_id: Type.String({ minLength: 1 }), confirm: Type.Literal(true) }),
    async execute(_id, params) {
      assertActive(active);
      if (params.confirm !== true) throw new Error("Permanent Chat deletion requires confirm=true after explicit user confirmation.");
      await deleteArchivedChat(params.session_id);
      return textResult(`Permanently deleted archived Chat ${params.session_id}.`);
    },
  });

  async function handle(args: string, ctx: ExtensionContext): Promise<void> {
    if (!ctx.isIdle()) {
      ctx.ui.notify("The agent is busy; wait before starting /chat-manage.", "warning");
      return;
    }
    previousTools = pi.getActiveTools().filter((name) => !TOOL_SET.has(name));
    pi.setActiveTools([...previousTools, ...TOOL_NAMES]);
    active = true;
    ctx.ui.setStatus("chat-manage", "CHAT MANAGE");
    pi.sendUserMessage(args.trim() || "List my Chat sessions and their storage use. Help me archive stale Chats or erase assets, and always ask before permanent deletion or asset erasure.");
  }

  pi.registerCommand("chat-manage", { description: "Manage MyPi Chat history and owned assets", handler: handle });
  pi.on("tool_call", (event) => TOOL_SET.has(event.toolName) && !active ? { block: true, reason: `${event.toolName} is available only during /chat-manage.` } : undefined);
  pi.on("before_agent_start", (event) => active ? {
    systemPrompt: `${event.systemPrompt}\n\n[CHAT MANAGEMENT ACTIVE]\nList Chats before mutation. Never erase assets or permanently delete history without explicit user confirmation. Chat management tools affect only the dedicated MyPi Chat store.`,
  } : undefined);
  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("agent_end", (_event, ctx) => restore(ctx));
  pi.on("session_shutdown", () => { if (previousTools) restore(); });
}

function formatRecords(records: readonly ChatStorageRecord[]): string {
  if (!records.length) return "No matching Chats.";
  return records.map((record) => JSON.stringify({
    state: record.state,
    sessionId: record.session.id,
    name: record.session.name ?? undefined,
    modifiedAt: record.session.modified.toISOString(),
    preview: record.session.firstMessage || undefined,
    historyBytes: record.historyBytes,
    assetBytes: record.assetBytes,
    attachmentCount: record.attachmentCount,
  })).join("\n");
}

function assertActive(active: boolean): void { if (!active) throw new Error("Chat management tools are available only during /chat-manage."); }
function textResult(text: string) { return { content: [{ type: "text" as const, text }], details: { text } }; }
