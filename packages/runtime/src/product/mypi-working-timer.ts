import type { ExtensionAPI, ExtensionContext } from '../core/extensions/types.ts'

export function formatWorkingElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor(totalSeconds % 3600 / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

/** Adds elapsed time to Pi's built-in TUI working message without replacing its spinner. */
export default function workingTimerExtension(pi: ExtensionAPI): void {
  let startedAt: number | undefined
  let timer: NodeJS.Timeout | undefined
  let activeCtx: ExtensionContext | undefined

  const render = () => {
    if (startedAt == null || !activeCtx) return
    try { activeCtx.ui.setWorkingMessage(`Working... (${formatWorkingElapsed(Date.now() - startedAt)})`) }
    catch { /* a cosmetic timer must never disrupt Pi */ }
  }

  const stop = (ctx?: ExtensionContext) => {
    if (timer) clearInterval(timer)
    timer = undefined
    startedAt = undefined
    const target = ctx ?? activeCtx
    activeCtx = undefined
    try { target?.ui.setWorkingMessage() } catch { /* nonfatal UI cleanup */ }
  }

  pi.on('agent_start', (_event, ctx) => {
    if (ctx.mode !== 'tui') return
    activeCtx = ctx
    if (startedAt == null) startedAt = Date.now()
    render()
    if (!timer) {
      timer = setInterval(render, 1000)
      timer.unref()
    }
  })

  pi.on('agent_settled', (_event, ctx) => {
    if (ctx.mode === 'tui' && ctx.isIdle()) stop(ctx)
  })

  pi.on('session_shutdown', (_event, ctx) => { if (activeCtx || ctx.mode === 'tui') stop(ctx) })
}
