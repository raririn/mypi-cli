import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const SET_STATUS_TOOL_NAME = "set_status";
export const NOTIFY_USER_TOOL_NAME = "notify_user";
export const AGENT_STATUS_KEY = "agent-status";
export const MAX_AGENT_STATUS_LENGTH = 120;
export const MAX_NOTIFY_MESSAGE_LENGTH = 500;

const SetStatusParameters = Type.Object({
  status: Type.Optional(Type.String({
    maxLength: MAX_AGENT_STATUS_LENGTH,
    description: "One short present-tense line describing what you are doing now. Omit or pass an empty string to clear the status.",
  })),
});

const NotifyUserParameters = Type.Object({
  message: Type.String({
    minLength: 1,
    maxLength: MAX_NOTIFY_MESSAGE_LENGTH,
    description: "One or two sentences the user should see even while away from this task.",
  }),
});

/**
 * Lightweight agent → user signaling. Both tools ride existing host-UI
 * channels (`setStatus`/`notify`), so they work identically wherever the Pi
 * host runs — GUI-attached, TUI, or headless — with no platform-specific
 * behavior of their own.
 */
export default function agentSignalsExtension(pi: ExtensionAPI): void {
  const clearStatus = (ctx: { readonly ui: { setStatus(key: string, text: string | undefined): void } } | undefined) => {
    ctx?.ui.setStatus(AGENT_STATUS_KEY, undefined);
  };
  // A status describes the current run only; never let it outlive the work.
  pi.on("agent_end", (_event, ctx) => clearStatus(ctx));
  pi.on("session_shutdown", (_event, ctx) => clearStatus(ctx));

  pi.registerTool({
    name: SET_STATUS_TOOL_NAME,
    label: "Set Status",
    description:
      "Publish a one-line progress status the user sees on this task's row while you work. Keep it short, present tense, and update it when your focus changes. Omit the status argument to clear it.",
    promptSnippet: "Publish a one-line progress status shown on this task's row",
    promptGuidelines: [
      "Update set_status when you start a distinct phase of work (exploring, editing, testing), not for every tool call.",
      "Keep statuses under 80 characters, factual and present tense, e.g. \"Running the payment tests\".",
    ],
    parameters: SetStatusParameters,
    executionMode: "sequential",

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const raw = (params as { readonly status?: string }).status?.trim() ?? "";
      if (raw === "") {
        ctx.ui.setStatus(AGENT_STATUS_KEY, undefined);
        return {
          content: [{ type: "text", text: "Status cleared." }],
          details: { cleared: true },
        };
      }
      const status = raw.slice(0, MAX_AGENT_STATUS_LENGTH);
      ctx.ui.setStatus(AGENT_STATUS_KEY, status);
      return {
        content: [{ type: "text", text: `Status set: ${status}` }],
        details: { status },
      };
    },
  });

  pi.registerTool({
    name: NOTIFY_USER_TOOL_NAME,
    label: "Notify User",
    description:
      "Send the user a desktop notification for something worth their attention even while they are away: a milestone reached, a long task finished, or work blocked on something outside this conversation. The notification is delivered by the host and respects the user's notification preferences.",
    promptSnippet: "Send a desktop notification for a milestone or blocker",
    promptGuidelines: [
      "Use notify_user sparingly: milestones, completions of long work, or blockers — never routine progress (use set_status for that).",
      "Write the message so it is understandable without the conversation open.",
    ],
    parameters: NotifyUserParameters,
    executionMode: "sequential",

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const message = (params as { readonly message: string }).message.trim().slice(0, MAX_NOTIFY_MESSAGE_LENGTH);
      if (message === "") {
        throw new Error("notify_user requires a non-empty message");
      }
      ctx.ui.notify(message, "info");
      return {
        content: [{ type: "text", text: "Notification sent to the user." }],
        details: { message },
      };
    },
  });
}
