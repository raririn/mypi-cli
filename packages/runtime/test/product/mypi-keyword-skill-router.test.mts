import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test, { after } from 'node:test'
import type { ExtensionAPI, SlashCommandInfo } from '@earendil-works/pi-coding-agent'
import { formatSkillsForPrompt, loadSkills } from '@earendil-works/pi-coding-agent'
import keywordSkillRouter, {
  createKeywordSkillRouter,
  loadKeywordSkillRegistry,
  resolveKeywordSkill,
  type KeywordSkillRoute,
} from '../../src/product/mypi-keyword-skill-router.ts'

type Handler = (event: any, ctx: any) => unknown

const testSkillsRoot = mkdtempSync(join(tmpdir(), 'mypi-keyword-skill-router-'))
after(() => rmSync(testSkillsRoot, { recursive: true, force: true }))

function writeTestSkill(name: string, keywordInvoke: string): string {
  const skillDirectory = join(testSkillsRoot, name)
  const skillPath = join(skillDirectory, 'SKILL.md')
  mkdirSync(skillDirectory, { recursive: true })
  writeFileSync(skillPath, [
    '---',
    `name: ${name}`,
    'description: Test-only keyword routing fixture.',
    'disable-model-invocation: true',
    'metadata:',
    keywordInvoke,
    '---',
    '',
    `# ${name}`,
    '',
    'Test-only skill body.',
    '',
  ].join('\n'))
  return skillPath
}

const whatOnlySkillPath = writeTestSkill('what-only', String.raw`  keyword-invoke:
    regex:
      - pattern: '1q2w3e4r5t[0-9]?'`)
const issueSkillPath = writeTestSkill('issue', String.raw`  keyword-invoke:
    priority: 100
    case-sensitive: false
    keywords:
      - '[ISSUE]'
    regex:
      - pattern: '(?=[\s\S]*\b(?:issues?|bugs?|defects?|regressions?|feature requests?)\b)(?=[\s\S]*\b(?:track(?:s|ed|ing)?|record(?:s|ed|ing)?|log(?:s|ged|ging)?|fil(?:e|es|ed|ing)|report(?:s|ed|ing)?|triag(?:e|es|ed|ing))\b)'
        flags: i`)
const projectMemorySkillPath = writeTestSkill('manage-project-memory', String.raw`  keyword-invoke:
    priority: 50
    case-sensitive: false
    regex:
      - pattern: '(?:^\s*(?:(?:please|kindly)\s+)?(?:remember(?!\s+me\s+(?:checkbox|control|button|option|setting|feature)\b)|memor(?:ize|ise)|recall|forget)\b|^\s*(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:remember(?!\s+me\s+(?:checkbox|control|button|option|setting|feature)\b)|memor(?:ize|ise)|recall|forget)\b|^\s*(?:do|did)\s+you\s+remember\b|^\s*(?:(?:please|kindly)\s+)?(?:keep|note)\s+(?:this|that)\s+(?:in mind|for later)\b|^\s*(?:project\s+)?memo(?:ry)?\s*:|\b(?:save|store|record|add|write)\s+(?:this|that|it|the following)\s+(?:in|to)\s+(?:the\s+)?(?:project\s+)?memory\b|\bwhat\s+do\s+you\s+remember\b|^\s*(?:(?:please|kindly)\s+)?(?:read|show|list|check|review|update|edit|change|clear)\s+(?:the\s+)?(?:project\s+)?memory\b|\b(?:remove|delete)\s+.+?\s+from\s+(?:the\s+)?(?:project\s+)?memory\b)'
        flags: i`)

function skillCommand(name: string, path = whatOnlySkillPath): SlashCommandInfo {
  return {
    name: `skill:${name}`,
    description: 'test skill',
    source: 'skill',
    sourceInfo: {
      path,
      source: 'test',
      scope: 'temporary',
      origin: 'top-level',
    },
  }
}

function createHarness(commands: SlashCommandInfo[] = [skillCommand('what-only')]) {
  const handlers = new Map<string, Handler[]>()
  const notifications: string[] = []
  const pi = {
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler])
    },
    getCommands() {
      return commands
    },
  } as unknown as ExtensionAPI
  const ctx = {
    ui: {
      notify(message: string) {
        notifications.push(message)
      },
    },
  }

  keywordSkillRouter(pi)
  return {
    notifications,
    async input(text: string, source = 'interactive') {
      const [handler] = handlers.get('input') ?? []
      return handler?.({ text, source }, ctx)
    },
  }
}

test('loads the regex route from hidden skill metadata', () => {
  const registry = loadKeywordSkillRegistry([skillCommand('what-only')])
  assert.deepEqual(registry.diagnostics, [])
  assert.equal(registry.routes.length, 1)
  assert.equal(registry.routes[0]?.skillName, 'what-only')

  assert.equal(resolveKeywordSkill(registry.routes, 'ordinary prompt').kind, 'none')
  assert.equal(resolveKeywordSkill(registry.routes, 'please process 1q2w3e4r5t').kind, 'match')
  assert.equal(resolveKeywordSkill(registry.routes, 'prefix 1q2w3e4r5t7 suffix').kind, 'match')
})

test('loads the case-insensitive ISSUE route for its marker or explicit tracking intent', () => {
  const registry = loadKeywordSkillRegistry([skillCommand('issue', issueSkillPath)])
  assert.deepEqual(registry.diagnostics, [])
  assert.equal(registry.routes.length, 1)
  assert.equal(registry.routes[0]?.skillName, 'issue')

  for (const text of [
    '[ISSUE] add this bug',
    'please triage [issue]',
    'prefix[IsSuE]suffix',
    'track this issue before implementing it',
    'Please RECORD the GUI BUG first',
    'this regression should be logged',
    'file a feature request for lazy loading',
    'the defect needs to be reported',
  ]) {
    const resolution = resolveKeywordSkill(registry.routes, text)
    assert.equal(resolution.kind, 'match', text)
    if (resolution.kind === 'match') assert.equal(resolution.route.skillName, 'issue')
  }
  for (const text of [
    'issue',
    'ISSUE',
    '[ISSUES]',
    '[ ISSUE ]',
    'fix this bug without tracker changes',
    'record the command output',
    'we have a strong track record',
    'open the issue tracker',
    'ordinary prompt',
  ]) {
    assert.equal(resolveKeywordSkill(registry.routes, text).kind, 'none', text)
  }
})

test('loads explicit project-memory intents without matching incidental memory language', () => {
  const registry = loadKeywordSkillRegistry([skillCommand('manage-project-memory', projectMemorySkillPath)])
  assert.deepEqual(registry.diagnostics, [])
  assert.equal(registry.routes.length, 1)
  assert.equal(registry.routes[0]?.skillName, 'manage-project-memory')

  for (const text of [
    'Remember that release tags are signed',
    'can you MEMORISE this convention?',
    'Store this in project memory',
    'what do you remember about release tags?',
    'Do you remember our release process?',
    'forget the old release rule',
    'please keep this in mind',
    'Project memo: use pnpm',
    'update project memory',
    'delete the old rule from project memory',
  ]) {
    const resolution = resolveKeywordSkill(registry.routes, text)
    assert.equal(resolution.kind, 'match', text)
    if (resolution.kind === 'match') assert.equal(resolution.route.skillName, 'manage-project-memory')
  }

  for (const text of [
    'memory',
    'memo',
    'fix a memory leak',
    'remember me checkbox',
    'implement the remember me checkbox',
    'can you remember me setting behavior?',
    'the app should remember the selected tab',
    'memorization improves learning',
    'save this file to disk',
    'ordinary prompt',
  ]) {
    assert.equal(resolveKeywordSkill(registry.routes, text).kind, 'none', text)
  }
})

test('resolves keywords case-insensitively and uses priority for overlaps', () => {
  const low: KeywordSkillRoute = {
    skillName: 'low',
    filePath: '/low/SKILL.md',
    priority: 1,
    matchers: [{ kind: 'keyword', value: 'Deploy', caseSensitive: false }],
  }
  const high: KeywordSkillRoute = {
    skillName: 'high',
    filePath: '/high/SKILL.md',
    priority: 2,
    matchers: [{ kind: 'regex', regex: /deploy production/i }],
  }

  assert.equal(resolveKeywordSkill([low], 'please DEPLOY').kind, 'match')
  const resolution = resolveKeywordSkill([low, high], 'deploy production')
  assert.equal(resolution.kind, 'match')
  if (resolution.kind === 'match') assert.equal(resolution.route.skillName, 'high')
})

test('fails closed when equal-priority skills match', async () => {
  const shared: KeywordSkillRoute['matchers'] = [{ kind: 'keyword', value: 'shared', caseSensitive: false }]
  const resolution = resolveKeywordSkill([
    { skillName: 'one', filePath: '/one/SKILL.md', priority: 0, matchers: shared },
    { skillName: 'two', filePath: '/two/SKILL.md', priority: 0, matchers: shared },
  ], 'shared request')
  assert.equal(resolution.kind, 'ambiguous')
})

test('input hook transforms matching user input and preserves explicit invocations', async () => {
  const h = createHarness()
  assert.deepEqual(await h.input('say 1q2w3e4r5t3 please'), {
    action: 'transform',
    text: '/skill:what-only say 1q2w3e4r5t3 please',
  })
  assert.deepEqual(await h.input('ordinary prompt'), { action: 'continue' })
  assert.deepEqual(await h.input('say 1q2w3e4r5t3 please', 'extension'), { action: 'continue' })
  assert.deepEqual(await h.input('/skill:another 1q2w3e4r5t3'), { action: 'continue' })
  assert.deepEqual(h.notifications, [])
})

test('extension command handoff expands an explicit skill invocation on every request', async () => {
  const h = createHarness()
  for (const args of ['first explicit request', 'second explicit request']) {
    const result = await h.input(`/skill:what-only ${args}`, 'extension') as { action?: string; text?: string }
    assert.equal(result.action, 'transform')
    assert.equal((result.text?.match(/<skill name="what-only"/g) ?? []).length, 1)
    assert.equal(result.text?.endsWith(`\n\n${args}`), true)
  }
  assert.deepEqual(h.notifications, [])
})

test('input hook lazily invokes ISSUE for its marker or explicit tracking intent', async () => {
  const h = createHarness([skillCommand('issue', issueSkillPath)])
  assert.deepEqual(await h.input('[issue] add archive failure'), {
    action: 'transform',
    text: '/skill:issue [issue] add archive failure',
  })
  assert.deepEqual(await h.input('track this bug before coding'), {
    action: 'transform',
    text: '/skill:issue track this bug before coding',
  })
  assert.deepEqual(await h.input('add issue without marker'), { action: 'continue' })
  assert.deepEqual(await h.input('/skill:another [ISSUE]'), { action: 'continue' })
  assert.deepEqual(h.notifications, [])
})

test('input hook lazily invokes project memory and preserves higher-priority ISSUE routing', async () => {
  const h = createHarness([
    skillCommand('manage-project-memory', projectMemorySkillPath),
    skillCommand('issue', issueSkillPath),
  ])
  assert.deepEqual(await h.input('Please remember that releases use signed tags'), {
    action: 'transform',
    text: '/skill:manage-project-memory Please remember that releases use signed tags',
  })
  assert.deepEqual(await h.input('fix the remember me control'), { action: 'continue' })
  assert.deepEqual(await h.input('[ISSUE] remember this archive failure'), {
    action: 'transform',
    text: '/skill:issue [ISSUE] remember this archive failure',
  })
  assert.deepEqual(h.notifications, [])
})

test('authenticated GUI bridge expands keyword and explicit skills exactly once', () => {
  const router = createKeywordSkillRouter({
    getCommands: () => [skillCommand('what-only')],
  })
  const notifications: string[] = []
  const notify = (message: string) => notifications.push(message)

  const original = 'say 1q2w3e4r5t3 through the bridge'
  const routed = router.expandExtensionInput(original, notify)
  assert.equal((routed.text.match(/<skill name="what-only"/g) ?? []).length, 1)
  assert.match(routed.text, /References are relative to/)
  assert.equal(routed.text.endsWith(`\n\n${original}`), true)
  assert.equal(routed.text.includes('/skill:what-only'), false)
  assert.deepEqual(routed.presentation, { version: 1, skillName: 'what-only', originalText: original })

  const explicit = router.expandExtensionInput('/skill:what-only preserve these args', notify)
  assert.equal((explicit.text.match(/<skill name="what-only"/g) ?? []).length, 1)
  assert.equal(explicit.text.endsWith('\n\npreserve these args'), true)
  assert.deepEqual(explicit.presentation, { version: 1, skillName: 'what-only', originalText: 'preserve these args' })
  assert.deepEqual(router.expandExtensionInput('ordinary bridge prompt', notify), { text: 'ordinary bridge prompt' })
  assert.deepEqual(notifications, [])
})

test('keyword skills are command-discoverable but absent from model prompt metadata', () => {
  const result = loadSkills({
    cwd: resolve(import.meta.dirname, '../..'),
    agentDir: resolve(import.meta.dirname, '.empty-agent-dir'),
    skillPaths: [whatOnlySkillPath, issueSkillPath, projectMemorySkillPath],
    includeDefaults: false,
  })

  assert.deepEqual(result.diagnostics, [])
  assert.equal(result.skills.length, 3)
  assert.deepEqual(result.skills.map((skill) => skill.name).sort(), ['issue', 'manage-project-memory', 'what-only'])
  assert.equal(result.skills.every((skill) => skill.disableModelInvocation), true)
  assert.equal(formatSkillsForPrompt(result.skills), '')
})
