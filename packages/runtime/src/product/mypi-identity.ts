import type { ExtensionAPI } from "../core/extensions/types.ts";

export const MYPI_IDENTITY_LINE = "You are running in MyPi.";

/** Daemon-served engines render in the desktop app, which displays Markdown
 *  images and mermaid diagrams — the model never uses either unless told. */
export const MYPI_RICH_OUTPUT_LINE =
  "Your output renders Markdown: local images (![alt](relative/path.png)) display inline, and ```mermaid code fences render as diagrams — use them when they communicate better than prose.";

/** Preserves MyPi's product identity when callers replace the upstream base prompt. */
export default function identityExtension(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event) => {
    const additions = [
      event.systemPrompt.includes(MYPI_IDENTITY_LINE) ? null : MYPI_IDENTITY_LINE,
      process.env.MYPI_DAEMON_ENGINE === "1" && !event.systemPrompt.includes("```mermaid")
        ? MYPI_RICH_OUTPUT_LINE
        : null,
    ].filter((line): line is string => line !== null);
    if (additions.length === 0) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${additions.join("\n")}` };
  });
}
