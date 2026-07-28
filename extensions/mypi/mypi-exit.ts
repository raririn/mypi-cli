import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'

const HELP = `# /exit — cleanly exit MyPi

## Syntax

/exit
/exit --help

## Behavior

Requests MyPi's documented graceful shutdown. MyPi waits until the current agent run, queued steering, follow-up messages, retries, and compaction work become idle, then emits session_shutdown to every extension before terminating.

This gives extensions time to close sockets and remove local ownership leases. Electron and other MyPi processes continue independently.

## Failure and safety

Use /exit for a clean shutdown. A process suspended with Ctrl-Z remains alive and can remain a session writer; resume it with fg before exiting or terminate that process explicitly.

In print mode the command is a no-op because MyPi already exits after processing prompts.`

/** Adds an explicit graceful-exit command for MyPi runtimes. */
export default function exitExtension(pi: ExtensionAPI): void {
  const handleExitCommand = async (args: string, ctx: ExtensionContext) => {
    const option = args.trim()
    if (option === '--help') { await ctx.ui.editor('/exit help', HELP); return }
    if (option) { ctx.ui.notify('Usage: /exit [--help]', 'warning'); return }
    ctx.shutdown()
  }
  pi.registerCommand('exit', {
    description: 'Cleanly exit MyPi after pending work becomes idle',
    handler: handleExitCommand
  })
  pi.on('input', async (event, ctx) => {
    if (event.source !== 'extension') return undefined
    const match = event.text.trim().match(/^\/exit(?:\s+(.*))?$/i)
    if (!match) return undefined
    await handleExitCommand(match[1] ?? '', ctx)
    return { action: 'handled' }
  })
}
