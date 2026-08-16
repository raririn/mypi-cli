import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createCliProxyProvider,
  type CliProxyProviderDependencies,
} from "./cliproxy-provider-core.ts";

export const CLIPROXY_FAST_ENTRY = "mypi-cliproxy-fast";

interface FastEntryData {
  readonly version: 1;
  readonly enabled: boolean;
}

function readFastMode(ctx: Pick<ExtensionContext, "sessionManager">): boolean {
  let enabled = false;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== CLIPROXY_FAST_ENTRY) continue;
    const data = entry.data as Partial<FastEntryData> | undefined;
    if (data?.version === 1 && typeof data.enabled === "boolean") enabled = data.enabled;
  }
  return enabled;
}

function fastCompletions(prefix: string) {
  const normalized = prefix.trimStart().toLowerCase();
  const options = ["on", "off", "status"];
  const matches = options.filter((value) => value.startsWith(normalized)).map((value) => ({ value, label: value }));
  return matches.length ? matches : null;
}

export function registerCliProxyProvider(
  pi: ExtensionAPI,
  dependencies: CliProxyProviderDependencies = {},
): void {
  let selectedFast = false;
  let effectiveFast = false;

  pi.registerProvider(createCliProxyProvider({
    ...dependencies,
    isFastEnabled: () => effectiveFast,
  }));

  const restore = (ctx: ExtensionContext) => {
    selectedFast = readFastMode(ctx);
    effectiveFast = selectedFast;
  };
  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("turn_start", () => { effectiveFast = selectedFast; });

  pi.registerCommand("fast", {
    description: "Set session-owned CLIProxyAPI priority processing for the next turn.",
    getArgumentCompletions: fastCompletions,
    handler: async (args, ctx) => {
      const value = args.trim().toLowerCase();
      if (!value || value === "status") {
        const current = selectedFast ? "on" : "off";
        const pending = ctx.isIdle() || selectedFast === effectiveFast
          ? ""
          : ` (current turn remains ${effectiveFast ? "on" : "off"})`;
        ctx.ui.notify(`CLIProxyAPI Fast is ${current}${pending}.`, "info");
        return;
      }
      if (value !== "on" && value !== "off") {
        ctx.ui.notify("Usage: /fast [on|off|status]", "error");
        return;
      }
      const enabled = value === "on";
      if (selectedFast !== enabled) {
        selectedFast = enabled;
        pi.appendEntry(CLIPROXY_FAST_ENTRY, { version: 1, enabled } satisfies FastEntryData);
      }
      const suffix = ctx.isIdle() ? "" : `; the current turn remains ${effectiveFast ? "on" : "off"}`;
      ctx.ui.notify(`CLIProxyAPI Fast is ${enabled ? "on" : "off"}${suffix}.`, "info");
    },
  });
}

export default function cliProxyProviderExtension(pi: ExtensionAPI): void {
  registerCliProxyProvider(pi);
}
