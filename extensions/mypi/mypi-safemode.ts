import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isSafeModeActive, setExecutionMode } from "@earendil-works/pi-coding-agent";
import { isTrustedReadOnlyTool } from "./mypi-trusted-read-tools.mts";
const OPTIONS = ["Approve", "Deny and interrupt", "Always approve (turn safe mode off)"];

const SAFEMODE_HELP = `# /safemode — complete reference

## Synopsis

/safemode
/safemode on
/safemode off
/safemode --help

## Purpose

Safe mode adds a user-approval gate in front of mutation-capable or otherwise unknown tool executions. The approval dialog shows the exact tool and arguments before a consequential operation runs.

Safe mode is OFF by default. While it is off, ordinary execution behavior remains in effect.

## State and lifetime

- State is process-local and stays outside project files and session history.
- Starting a new MyPi process resets safe mode to off.
- Reloading extensions resets safe mode to off.
- Selecting “Always approve” immediately turns safe mode off.
- When enabled, the footer/status area shows SAFE MODE.

## Operations allowed without approval

The following provenance-verified read-only tools pass through:

- Upstream-runtime built-in read, grep, find, and ls
- MyPi built-in web_search and web_fetch
- MyPi built-in recall_compacted_history for the active session's sealed checkpoint
- MyPi @mypi/core ask_user for non-mutating clarification

The web tools use constrained GET requests, block private/local targets, and treat returned pages as untrusted content. Checkpoint recall is bounded to an integrity-checked source branch and treats non-user content as historical evidence. The question tool only waits for or records user direction. Custom-tool trust requires the expected package source and a manifest that resolves to the active entrypoint; a matching name alone carries no trust.

Read-only here identifies verified implementations designed to preserve project state. Secret reads and outbound queries carry separate confidentiality implications. Safe mode gates execution and mutation; sandboxing and network isolation are separate controls.

## Operations requiring approval

- write — creates or replaces file contents
- edit — modifies existing file contents
- bash — arbitrary shell execution
- Direct ! and !! shell commands in the TUI
- Every unknown or custom tool other than the provenance-verified MyPi web and user-interaction tools above

Every write is consequential because it can alter source code, credentials, configuration, hooks, build scripts, executables, or data. Shell commands are always gated because shell syntax, subprocesses, redirection, scripts, aliases, and invoked programs make reliable static read-only classification impractical.

## Approval dialog

For each gated execution, MyPi shows the tool name and a preview of its arguments. The choices are:

1. Approve
   Allow this one tool call. Safe mode remains enabled and later gated calls ask again.

2. Deny and interrupt
   Block the tool call and abort the active agent operation. The blocked result is reported to the agent. For direct shell commands, execution is replaced with a cancelled result.

3. Always approve (turn safe mode off)
   Allow this tool call, disable safe mode, and permit later operations without safe-mode prompts.

Closing or cancelling the dialog is treated as denial.

## TUI, GUI, and non-interactive behavior

- TUI: uses MyPi's native runtime \`ctx.ui.select\` dialog.
- MyPi GUI/RPC: uses the extension UI protocol and displays a native GUI approval modal.
- Approval-capable UI is required. Print/JSON modes and other headless environments block gated tool calls.

## Parallel tool calls

MyPi preflights sibling tool calls before executing them. Safe mode asks about gated calls during preflight. Denying a call aborts the active operation; calls already finalized by other extensions or execution infrastructure may still have emitted lifecycle events. Safe mode provides approval gating, while transactional rollback remains the responsibility of the invoked operation.

## Interaction with /plan and /goal

- /plan already restricts the agent to project inspection and PLAN.md edits. If safe mode is also on, permitted PLAN.md writes still require approval.
- /goal uses normal execution tools. With safe mode on, goal execution asks before every write, edit, shell command, or custom tool.
- “Always approve” affects safe mode only; /plan’s independent PLAN.md-only enforcement remains active.

## Examples

/safemode
Show the current state and usage.

/safemode on
Enable approval gates.

/safemode off
Disable approval gates.

/safemode --help
Open this reference.

## Security boundaries and limitations

- Safe mode is an approval gate. Approved code runs with the user’s normal OS permissions.
- Approved operations retain their effects.
- A read-only tool can still disclose sensitive content to the model.
- Third-party extension tools require approval until their provenance is verified.
- Argument previews may be truncated for usability; inspect suspicious operations carefully.
- Another extension loaded earlier may mutate tool arguments before safe mode sees them, while a later extension may mutate them afterward. Review the final ecosystem of installed extensions when strong security guarantees are required.
- Use containers, OS accounts, filesystem permissions, or a proper sandbox when untrusted code requires isolation.
`;

function describeCall(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "bash") return String(input.command || "(empty command)");
  if (toolName === "write" || toolName === "edit") return String(input.path || "(unknown path)");
  try {
    const serialized = JSON.stringify(input, null, 2);
    return serialized.length > 1200 ? `${serialized.slice(0, 1200)}\n…` : serialized;
  } catch {
    return "(arguments unavailable)";
  }
}

export default function safemodeExtension(pi: ExtensionAPI) {
  // Safe Mode is one of the three per-session execution modes owned by the
  // runtime (Sandbox Off / Sandbox On / Safe Mode); this extension is the
  // /safemode alias plus the approval gate. The runtime's mode controller owns
  // the footer indicator, so this extension no longer sets its own status.
  const handleSafemodeCommand = async (args: string, ctx: ExtensionContext) => {
    const option = args.trim().toLowerCase();
    if (option === "--help") {
      await ctx.ui.editor("Safe mode help", SAFEMODE_HELP);
      return;
    }
    if (!option) {
      ctx.ui.notify(`Safe mode is ${isSafeModeActive() ? "on" : "off"}. Usage: /safemode [on|off]`, "info");
      return;
    }
    if (option !== "on" && option !== "off") {
      ctx.ui.notify("Usage: /safemode [on|off]", "warning");
      return;
    }
    if (option === "on") {
      setExecutionMode("safe");
    } else if (isSafeModeActive()) {
      // Leaving Safe Mode returns to normal; it never forces a sandbox off.
      setExecutionMode("off");
    }
    ctx.ui.notify(`Safe mode ${option === "on" ? "enabled" : "disabled"}.`, option === "on" ? "warning" : "info");
  };

  pi.registerCommand("safemode", {
    description: "Require approval for mutating or potentially dangerous tool calls",
    getArgumentCompletions: (prefix) => {
      const values = ["on", "off", "--help"];
      const matches = values.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
      return matches.length ? matches : null;
    },
    handler: handleSafemodeCommand,
  });

  pi.on("input", async (event, ctx) => {
    if (event.source !== "extension") return undefined;
    const match = event.text.trim().match(/^\/safemode(?:\s+(.*))?$/i);
    if (!match) return undefined;
    await handleSafemodeCommand(match[1] ?? "", ctx);
    return { action: "handled" };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!isSafeModeActive() || isTrustedReadOnlyTool(pi, event.toolName)) return undefined;

    if (!ctx.hasUI) {
      ctx.abort();
      return { block: true, reason: `Safe mode blocked ${event.toolName}: no approval UI is available` };
    }

    const detail = describeCall(event.toolName, event.input);
    pi.events.emit("mypi:approval-state", { waiting: true, toolName: event.toolName });
    let choice: string | undefined;
    try { choice = await ctx.ui.select(`Safe mode: approve ${event.toolName}?\n\n${detail}`, OPTIONS); }
    finally { pi.events.emit("mypi:approval-state", { waiting: false, toolName: event.toolName }); }

    if (choice === OPTIONS[0]) return undefined;
    if (choice === OPTIONS[2]) {
      setExecutionMode("off");
      ctx.ui.notify("Safe mode disabled; this tool call was approved.", "warning");
      return undefined;
    }

    ctx.abort();
    return { block: true, reason: `Safe mode: ${event.toolName} denied by user` };
  });

  // Direct !/!! shell commands bypass tool_call, so gate those separately.
  pi.on("user_bash", async (event, ctx) => {
    if (!isSafeModeActive()) return undefined;
    if (!ctx.hasUI) {
      return { result: { output: "Safe mode blocked shell execution: no approval UI is available", exitCode: 126, cancelled: true, truncated: false } };
    }

    pi.events.emit("mypi:approval-state", { waiting: true, toolName: "user_bash" });
    let choice: string | undefined;
    try { choice = await ctx.ui.select(`Safe mode: approve shell command?\n\n${event.command}`, OPTIONS); }
    finally { pi.events.emit("mypi:approval-state", { waiting: false, toolName: "user_bash" }); }
    if (choice === OPTIONS[0]) return undefined;
    if (choice === OPTIONS[2]) {
      setExecutionMode("off");
      ctx.ui.notify("Safe mode disabled; this shell command was approved.", "warning");
      return undefined;
    }
    return { result: { output: "Safe mode: shell command denied by user", exitCode: 126, cancelled: true, truncated: false } };
  });
}
