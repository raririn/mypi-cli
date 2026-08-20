import type { ExtensionAPI } from "../core/extensions/types.ts";

export const MYPI_IDENTITY_LINE = "You are running in MyPi.";

/** Preserves MyPi's product identity when callers replace the upstream base prompt. */
export default function identityExtension(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event) => {
    if (event.systemPrompt.includes(MYPI_IDENTITY_LINE)) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${MYPI_IDENTITY_LINE}` };
  });
}
