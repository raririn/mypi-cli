import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const MAX_SOURCE_CHARS = 4_000;
const MAX_TITLE_CHARS = 36;
const TITLE_SYSTEM_PROMPT = [
  "You generate concise UI conversation titles for an assistant.",
  "Return only the title text.",
  "Keep it short, usually 2 to 5 words.",
  "Use the same language as the source message.",
  "Preserve ticket IDs exactly.",
  "No markdown, quotes, labels, or trailing punctuation.",
].join("\n");

export type TuiTitleGenerator = (
  prompt: string,
  ctx: ExtensionContext,
  signal: AbortSignal,
) => Promise<string | null>;

export interface TuiAutoTitleDependencies {
  readonly generateTitle?: TuiTitleGenerator;
}

/** Persist a generated name for the first textual prompt in TUI-owned sessions. */
export function registerTuiAutoTitle(
  pi: ExtensionAPI,
  dependencies: TuiAutoTitleDependencies = {},
): void {
  const generateTitle = dependencies.generateTitle ?? generateTuiTitle;
  let active = false;
  let attempted = false;
  let sessionId: string | undefined;
  let pending: AbortController | undefined;

  const cancelPending = () => {
    pending?.abort();
    pending = undefined;
  };

  const start = (promptInput: string, ctx: ExtensionContext) => {
    const prompt = promptInput.trim();
    if (!active || attempted || !prompt || pi.getSessionName()) return;
    if (ctx.sessionManager.getSessionId() !== sessionId) return;

    attempted = true;
    const requestSessionId = sessionId;
    const controller = new AbortController();
    pending = controller;

    void generateTitle(prompt.slice(0, MAX_SOURCE_CHARS), ctx, controller.signal)
      .then((title) => {
        if (pending === controller) pending = undefined;
        if (!title || controller.signal.aborted || !active || sessionId !== requestSessionId) return;
        if (pi.getSessionName()) return;
        pi.setSessionName(title);
      })
      .catch((error) => {
        if (pending === controller) pending = undefined;
        if (controller.signal.aborted) return;
        console.warn(`[tui-auto-title] title generation failed for ${requestSessionId ?? "unknown"}:`, error);
      });
  };

  pi.on("session_start", (_event, ctx) => {
    cancelPending();
    active = ctx.mode === "tui";
    attempted = false;
    sessionId = ctx.sessionManager.getSessionId();
    if (!active || pi.getSessionName()) return;

    const existingPrompt = firstTextualUserMessage(ctx);
    if (existingPrompt) queueMicrotask(() => start(existingPrompt, ctx));
  });

  pi.on("input", (event, ctx) => {
    if (event.source === "interactive") start(event.text, ctx);
    return undefined;
  });

  pi.on("session_info_changed", (event) => {
    if (event.name) {
      attempted = true;
      cancelPending();
    }
  });

  pi.on("session_shutdown", () => {
    active = false;
    sessionId = undefined;
    cancelPending();
  });
}

export default function tuiAutoTitleExtension(pi: ExtensionAPI): void {
  registerTuiAutoTitle(pi);
}

export async function generateTuiTitle(
  prompt: string,
  ctx: ExtensionContext,
  signal: AbortSignal,
): Promise<string | null> {
  const model = ctx.model;
  if (!model || signal.aborted) return null;

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey || signal.aborted) return null;

  const response = await complete(
    model,
    {
      systemPrompt: TITLE_SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: [{
          type: "text",
          text: [
            "Generate a short UI conversation title for the user's first message.",
            "Return only the title.",
            "",
            "<user_message>",
            prompt,
            "</user_message>",
          ].join("\n"),
        }],
        timestamp: Date.now(),
      }],
      tools: [],
    },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      env: auth.env,
      signal,
      maxTokens: 64,
    },
  );

  const text = response.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join(" ");
  return normalizeTitle(text);
}

function firstTextualUserMessage(ctx: ExtensionContext): string | undefined {
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message" || entry.message.role !== "user") continue;
    const text = extractText(entry.message.content);
    if (text) return text;
  }
  return undefined;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => (
      Boolean(block) && typeof block === "object" && (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ))
    .map((block) => block.text)
    .join(" ")
    .trim();
}

export function normalizeTitle(value: string): string | null {
  let title = value.replace(/\s+/g, " ").trim();
  if (!title) return null;
  title = title.replace(/^title\s*:\s*/i, "").trim();
  title = stripWrappingQuotes(title);
  title = title.replace(/[.?!,:;]+$/g, "").trim();
  if (!title) return null;
  if (title.length > MAX_TITLE_CHARS) title = `${title.slice(0, MAX_TITLE_CHARS - 3).trimEnd()}...`;
  return title || null;
}

function stripWrappingQuotes(value: string): string {
  let current = value.trim();
  while (current.length >= 2) {
    const first = current[0];
    const last = current[current.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'") || (first === "`" && last === "`")) {
      current = current.slice(1, -1).trim();
      continue;
    }
    break;
  }
  return current;
}
