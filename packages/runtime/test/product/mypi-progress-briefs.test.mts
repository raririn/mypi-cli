import assert from 'node:assert/strict'
import test from 'node:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import progressBriefs, { PROGRESS_BRIEF_POLICY } from '../../src/product/mypi-progress-briefs.ts'

type Handler = (event: any, ctx: any) => unknown

function createHarness(options: { activeTools?: string[]; mode?: string } = {}) {
  const handlers = new Map<string, Handler[]>()
  const hiddenThinkingLabels: Array<string | undefined> = []
  const pi = {
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler])
    },
    getActiveTools: () => options.activeTools ?? ['read', 'bash', 'commentary'],
  } as unknown as ExtensionAPI
  const ctx = {
    mode: options.mode ?? 'rpc',
    ui: {
      setHiddenThinkingLabel(label?: string) {
        hiddenThinkingLabels.push(label)
      },
    },
  }

  progressBriefs(pi)
  return {
    ctx,
    handlers,
    hiddenThinkingLabels,
    async emit(name: string, event: unknown = {}) {
      let result: unknown
      for (const handler of handlers.get(name) ?? []) {
        const next = await handler(event, ctx)
        if (next !== undefined) result = next
      }
      return result
    },
  }
}

test('BUG-124 R1/R2: no context reminder is ever injected — zero provider turns for progress', async () => {
  const h = createHarness()
  // No context hook is even registered any more.
  assert.equal(h.handlers.has('context'), false)
  assert.equal(h.handlers.has('turn_end'), false)
  // Many tool-bearing turns still change nothing.
  for (let turn = 0; turn < 25; turn += 1) {
    assert.equal(await h.emit('turn_end', { toolResults: [{}] }), undefined)
    assert.equal(await h.emit('context', { messages: [] }), undefined)
  }
})

test('R5: the policy rides the system prompt only while the commentary tool exists', async () => {
  const withCommentary = createHarness({ activeTools: ['read', 'commentary'] })
  const appended = await withCommentary.emit('before_agent_start', { systemPrompt: 'base' }) as { systemPrompt: string }
  assert.match(appended.systemPrompt, /commentary.*tool/i)
  assert.match(appended.systemPrompt, /final answer/i)
  assert.ok(appended.systemPrompt.includes(PROGRESS_BRIEF_POLICY))

  const withoutCommentary = createHarness({ activeTools: ['read', 'bash'] })
  assert.equal(await withoutCommentary.emit('before_agent_start', { systemPrompt: 'base' }), undefined)
})

test('R3: subagent children get no progress policy at all', async () => {
  const previous = process.env.MYPI_SUBAGENT_CHILD
  process.env.MYPI_SUBAGENT_CHILD = 'explore'
  try {
    const child = createHarness()
    assert.equal(child.handlers.size, 0)
    assert.equal(await child.emit('before_agent_start', { systemPrompt: 'base' }), undefined)
  } finally {
    if (previous === undefined) delete process.env.MYPI_SUBAGENT_CHILD
    else process.env.MYPI_SUBAGENT_CHILD = previous
  }
})

test('the TUI hidden-thinking label behavior is preserved; GUI UI untouched', async () => {
  const gui = createHarness({ mode: 'rpc' })
  await gui.emit('session_start')
  await gui.emit('session_shutdown')
  assert.deepEqual(gui.hiddenThinkingLabels, [])

  const tui = createHarness({ mode: 'tui' })
  await tui.emit('session_start')
  assert.equal(tui.hiddenThinkingLabels.length, 1)
  assert.match(tui.hiddenThinkingLabels[0] ?? '', /Thinking/)
  await tui.emit('session_shutdown')
  assert.equal(tui.hiddenThinkingLabels.length, 2)
  assert.equal(tui.hiddenThinkingLabels[1], undefined)
})
