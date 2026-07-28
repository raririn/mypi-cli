import { keyHint, keyText, type ExtensionAPI } from '@earendil-works/pi-coding-agent'

export const PROGRESS_BRIEF_INTERVAL = 10
export const PROGRESS_BRIEF_CUSTOM_TYPE = 'mypi-progress-brief-reminder'

export const PROGRESS_BRIEF_POLICY = `
Progress brief policy:
- Do not reveal private chain-of-thought.
- If your first response to this request will call tools, first give the user a concise one- or two-sentence work brief describing what you will do and why.
- When a progress-brief reminder appears, if you will continue calling tools, first give a concise one- or two-sentence update describing what changed, what you learned, and what you will do next.
- If you are ready to give the final answer without more tools, answer normally without a redundant progress preamble.
`.trim()

export const PROGRESS_BRIEF_REMINDER = `
Progress-brief reminder: before making additional tool calls, give the user a factual one- or two-sentence progress update. Describe results and next actions without exposing private chain-of-thought. If no more tools are needed, answer normally.
`.trim()

/** Adds concise model-authored progress briefs without persisting reminder messages. */
export default function progressBriefsExtension(pi: ExtensionAPI): void {
  let completedToolTurns = 0
  let briefDue = true

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
    completedToolTurns = 0
    briefDue = true
    return { systemPrompt: `${event.systemPrompt}\n\n${PROGRESS_BRIEF_POLICY}` }
  })

  pi.on('context', (event) => {
    if (!briefDue) return
    briefDue = false
    return {
      messages: [
        ...event.messages,
        {
          role: 'custom' as const,
          customType: PROGRESS_BRIEF_CUSTOM_TYPE,
          content: PROGRESS_BRIEF_REMINDER,
          display: false,
          timestamp: Date.now(),
        },
      ],
    }
  })

  pi.on('turn_end', (event) => {
    if (event.toolResults.length === 0) return
    completedToolTurns += 1
    if (completedToolTurns % PROGRESS_BRIEF_INTERVAL === 0) briefDue = true
  })

  pi.on('session_shutdown', (_event, ctx) => {
    if (ctx.mode === 'tui') ctx.ui.setHiddenThinkingLabel()
  })
}
