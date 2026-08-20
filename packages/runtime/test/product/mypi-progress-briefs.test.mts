import assert from 'node:assert/strict'
import test from 'node:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import progressBriefs, {
  PROGRESS_BRIEF_CUSTOM_TYPE,
  PROGRESS_BRIEF_INTERVAL,
} from '../../src/product/mypi-progress-briefs.ts'

type Handler = (event: any, ctx: any) => unknown

function createHarness() {
  const handlers = new Map<string, Handler[]>()
  const hiddenThinkingLabels: Array<string | undefined> = []
  const pi = {
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler])
    },
  } as unknown as ExtensionAPI
  const ctx = {
    mode: 'rpc',
    ui: {
      setHiddenThinkingLabel(label?: string) {
        hiddenThinkingLabels.push(label)
      },
    },
  }

  progressBriefs(pi)
  return {
    ctx,
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

test('injects a hidden first-turn reminder and appends the persistent policy', async () => {
  const h = createHarness()
  const before = await h.emit('before_agent_start', { systemPrompt: 'base' }) as { systemPrompt: string }
  assert.match(before.systemPrompt, /first response.*call tools/i)

  const first = await h.emit('context', { messages: [{ role: 'user', content: 'work', timestamp: 1 }] }) as {
    messages: Array<{ role: string; customType?: string; display?: boolean }>
  }
  assert.equal(first.messages.at(-1)?.role, 'custom')
  assert.equal(first.messages.at(-1)?.customType, PROGRESS_BRIEF_CUSTOM_TYPE)
  assert.equal(first.messages.at(-1)?.display, false)
  assert.equal(await h.emit('context', { messages: [] }), undefined)
})

test('requests another brief after ten tool-bearing turns only', async () => {
  const h = createHarness()
  await h.emit('before_agent_start', { systemPrompt: 'base' })
  await h.emit('context', { messages: [] })

  await h.emit('turn_end', { toolResults: [] })
  assert.equal(await h.emit('context', { messages: [] }), undefined)

  for (let turn = 1; turn < PROGRESS_BRIEF_INTERVAL; turn += 1) {
    await h.emit('turn_end', { toolResults: [{}] })
    assert.equal(await h.emit('context', { messages: [] }), undefined)
  }

  await h.emit('turn_end', { toolResults: [{}, {}] })
  const periodic = await h.emit('context', { messages: [] }) as {
    messages: Array<{ customType?: string }>
  }
  assert.equal(periodic.messages.at(-1)?.customType, PROGRESS_BRIEF_CUSTOM_TYPE)
  assert.equal(await h.emit('context', { messages: [] }), undefined)
})

test('resets the interval for each top-level request and keeps GUI UI untouched', async () => {
  const h = createHarness()
  await h.emit('session_start')
  assert.deepEqual(h.hiddenThinkingLabels, [])

  await h.emit('before_agent_start', { systemPrompt: 'first' })
  await h.emit('context', { messages: [] })
  for (let turn = 0; turn < 4; turn += 1) await h.emit('turn_end', { toolResults: [{}] })

  await h.emit('before_agent_start', { systemPrompt: 'second' })
  const nextRequest = await h.emit('context', { messages: [] }) as { messages: Array<{ customType?: string }> }
  assert.equal(nextRequest.messages.at(-1)?.customType, PROGRESS_BRIEF_CUSTOM_TYPE)
})
