import type { ExtensionAPI } from '../core/extensions/types.ts'
import { keyHint, keyText } from '../modes/interactive/components/keybinding-hints.ts'

/**
 * BUG-124: the old design injected a hidden context reminder on every run's
 * first turn and every 10 tool-bearing turns. Weak models answered the
 * reminder itself — an announcement-only `stop` that persisted as a
 * successful terminal boundary while the promised work never happened.
 *
 * Progress guidance now consumes zero provider turns (R1/R2): it is a
 * static system-prompt clause, present only when the `commentary` tool is
 * available (R5), telling the model to ride progress updates on the
 * commentary TOOL co-emitted with continuing work — never as a standalone
 * text response. Subagent children are excluded entirely (R3); with no
 * per-turn state left there is nothing for internal wakes to reset (R4);
 * ordinary assistant `stop` stays terminal (R6/R7).
 */
export const PROGRESS_BRIEF_POLICY = `
Progress updates policy:
- Do not reveal private chain-of-thought.
- While you are working with tools, share concise one- or two-sentence progress updates through the \`commentary\` tool, co-emitted in the same response as your continuing tool calls — never as a standalone text response.
- A plain text response without tool calls is always your final answer. Never end with a text response that merely announces what you will do next; either do it (tool calls) or deliver the result.
`.trim()

export default function progressBriefsExtension(pi: ExtensionAPI): void {
  // Explore/work/advisor/reviewer children run under their role prompts
  // alone; progress-brief policy never applies to them (R3).
  if (process.env.MYPI_SUBAGENT_CHILD) return

  pi.on('session_start', (_event, ctx) => {
    if (ctx.mode !== 'tui') return
    // Pi renders this label only when a provider-emitted thinking block exists
    // and thinking is collapsed. Use the configured keybinding, not a hardcoded key.
    const toggleKey = keyText('app.thinking.toggle')
    ctx.ui.setHiddenThinkingLabel(toggleKey
      ? `Thinking... (${keyHint('app.thinking.toggle', 'to expand')})`
      : 'Thinking...')
  })

  pi.on('before_agent_start', (event) => {
    // Guidance is meaningful only when the commentary tool exists to carry
    // it (R5); without it, say nothing rather than invite prose progress.
    if (!pi.getActiveTools().includes('commentary')) return undefined
    return { systemPrompt: `${event.systemPrompt}\n\n${PROGRESS_BRIEF_POLICY}` }
  })

  pi.on('session_shutdown', (_event, ctx) => {
    if (ctx.mode === 'tui') ctx.ui.setHiddenThinkingLabel()
  })
}
