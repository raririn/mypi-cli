import type { ExtensionAPI } from "../core/extensions/types.ts";
import { Type } from "typebox";

export const ASK_USER_TOOL_NAME = "ask_user";
const GUI_CONTROL_STATE_EVENT = "mypi:gui-control-state";

interface GuiControlStateEvent {
  readonly state: "disabled" | "discovering" | "connecting" | "handshaking" | "connected" | "backoff" | "closing";
  readonly connected: boolean;
}

const OptionSchema = Type.Object({
  label: Type.String({
    minLength: 1,
    maxLength: 120,
    description: "Concise option label",
  }),
  description: Type.String({
    minLength: 1,
    maxLength: 300,
    description: "What choosing this option means",
  }),
});

const AskUserParameters = Type.Object({
  question: Type.String({
    minLength: 1,
    maxLength: 2_000,
    description: "One focused question whose answer materially affects the next action",
  }),
  options: Type.Array(OptionSchema, {
    minItems: 3,
    maxItems: 3,
    description: "Exactly three meaningfully different options",
  }),
  recommendedOption: Type.Integer({
    minimum: 1,
    maximum: 3,
    description: "One-based number of the option you recommend",
  }),
});

type AskUserParams = {
  readonly question: string;
  readonly options: readonly { readonly label: string; readonly description: string }[];
  readonly recommendedOption: number;
};

interface AskUserDetails {
  readonly question: string;
  readonly options: readonly { readonly label: string; readonly description: string }[];
  readonly recommendedOption: number;
  readonly answer?: string;
  readonly selectedOption?: number;
  readonly custom?: boolean;
  readonly cancelled?: boolean;
  readonly waitingForUserReply?: boolean;
  readonly mode: "dialog" | "bridged-freeform" | "unavailable";
}

interface AskUserDialogOptions {
  readonly signal?: AbortSignal;
  readonly mypiAskUser: AskUserParams & { readonly toolCallId: string };
}

function formatOption(params: AskUserParams, index: number): string {
  const option = params.options[index]!;
  const recommendation = params.recommendedOption === index + 1 ? " (Recommended)" : "";
  return `${index + 1}. ${option.label}${recommendation} — ${option.description}`;
}

function formatBridgedQuestion(params: AskUserParams): string {
  return [
    params.question,
    "",
    ...params.options.map((_option, index) => formatOption(params, index)),
    "",
    "Reply with 1, 2, or 3, or type any other direction.",
  ].join("\n");
}

function details(params: AskUserParams, extra: Omit<AskUserDetails, "question" | "options" | "recommendedOption">): AskUserDetails {
  return {
    question: params.question,
    options: params.options,
    recommendedOption: params.recommendedOption,
    ...extra,
  };
}

export default function askUserExtension(pi: ExtensionAPI): void {
  let guiBridgeConnected = false;
  let bridgedQuestionPending = false;

  pi.events.on(GUI_CONTROL_STATE_EVENT, (event: unknown) => {
    const state = event as Partial<GuiControlStateEvent> | undefined;
    guiBridgeConnected = state?.state === "connected" && state.connected === true;
  });

  pi.on("session_start", () => {
    guiBridgeConnected = false;
    bridgedQuestionPending = false;
  });
  pi.on("session_shutdown", () => {
    guiBridgeConnected = false;
    bridgedQuestionPending = false;
  });
  pi.on("input", () => {
    if (bridgedQuestionPending) bridgedQuestionPending = false;
  });
  pi.on("tool_call", () => bridgedQuestionPending
    ? { block: true, reason: "A bridged question is waiting for the user's reply; print the choices and stop without calling tools." }
    : undefined);

  pi.registerTool({
    name: ASK_USER_TOOL_NAME,
    label: "Ask User",
    description:
      "Pause and ask the user one focused question. Supply exactly three meaningfully different options, explain each option, and identify the option you recommend. The user can always choose Other and write any response.",
    promptSnippet: "Ask one blocking question with three options, one recommendation, and unrestricted custom input",
    promptGuidelines: [
      "Use ask_user only when the answer materially changes the next action; otherwise make a reasonable decision and continue.",
      "For ask_user, provide exactly three meaningfully different options and set recommendedOption to the one option you recommend.",
      "Call ask_user by itself before dependent operations; never emit operations decided before the user's answer as sibling tool calls.",
    ],
    parameters: AskUserParameters,
    executionMode: "sequential",

    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const normalized = params as AskUserParams;

      if (normalized.options.length !== 3 || !Number.isInteger(normalized.recommendedOption)
        || normalized.recommendedOption < 1 || normalized.recommendedOption > 3) {
        throw new Error("ask_user requires exactly three options and recommendedOption from 1 to 3");
      }

      if (ctx.mode === "tui" && guiBridgeConnected) {
        const text = formatBridgedQuestion(normalized);
        bridgedQuestionPending = true;
        return {
          content: [{
            type: "text",
            text: `A GUI-bridged user response is required. In your next assistant response, print the following question and choices verbatim, then stop and wait for the user's unrestricted reply. Do not call tools or continue operations.\n\n${text}`,
          }],
          details: details(normalized, {
            mode: "bridged-freeform",
            waitingForUserReply: true,
          }),
        };
      }

      if (!ctx.hasUI) {
        return {
          content: [{
            type: "text",
            text: "User interaction is unavailable. Stop without guessing and wait for the user to provide direction in an interactive session.",
          }],
          details: details(normalized, {
            mode: "unavailable",
            cancelled: true,
          }),
          terminate: true,
        };
      }

      const choices = normalized.options.map((_option, index) => formatOption(normalized, index));
      const otherChoice = "4. Other — Type any response";
      const dialogOptions: AskUserDialogOptions = {
        signal,
        mypiAskUser: {
          toolCallId,
          question: normalized.question,
          options: normalized.options,
          recommendedOption: normalized.recommendedOption,
        },
      };
      const choice = await ctx.ui.select(
        normalized.question,
        [...choices, otherChoice],
        dialogOptions,
      );

      if (choice === undefined) {
        return {
          content: [{ type: "text", text: "The user cancelled the question. Stop and wait for further direction." }],
          details: details(normalized, {
            mode: "dialog",
            cancelled: true,
          }),
          terminate: true,
        };
      }

      if (choice === otherChoice) {
        const answer = await ctx.ui.input(normalized.question, "Type any response", { signal });
        if (answer === undefined) {
          return {
            content: [{ type: "text", text: "The user cancelled the question. Stop and wait for further direction." }],
            details: details(normalized, {
              mode: "dialog",
              cancelled: true,
            }),
            terminate: true,
          };
        }
        return {
          content: [{ type: "text", text: `User wrote: ${answer}` }],
          details: details(normalized, {
            mode: "dialog",
            answer,
            custom: true,
          }),
        };
      }

      const selectedIndex = choices.indexOf(choice);
      if (selectedIndex < 0) {
        return {
          content: [{ type: "text", text: `User wrote: ${choice}` }],
          details: details(normalized, {
            mode: "dialog",
            answer: choice,
            custom: true,
          }),
        };
      }
      const selected = normalized.options[selectedIndex]!;
      const recommended = normalized.recommendedOption === selectedIndex + 1 ? " (recommended)" : "";
      return {
        content: [{
          type: "text",
          text: `User selected ${selectedIndex + 1}. ${selected.label}${recommended}`,
        }],
        details: details(normalized, {
          mode: "dialog",
          answer: selected.label,
          selectedOption: selectedIndex + 1,
          custom: false,
        }),
      };
    },
  });
}
