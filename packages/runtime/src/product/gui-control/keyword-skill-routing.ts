import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  type ExtensionAPI,
  type InputEventResult,
} from '../../core/extensions/types.ts'
import type { SlashCommandInfo } from '../../core/slash-commands.ts'
import { parseFrontmatter, stripFrontmatter } from '../../utils/frontmatter.ts'

type Frontmatter = Record<string, unknown>
type UnknownRecord = Record<string, unknown>
type Notify = (message: string) => void

export type KeywordSkillMatcher =
  | { readonly kind: 'keyword'; readonly value: string; readonly caseSensitive: boolean }
  | { readonly kind: 'regex'; readonly regex: RegExp }

export interface KeywordSkillRoute {
  readonly skillName: string
  readonly filePath: string
  readonly priority: number
  readonly matchers: readonly KeywordSkillMatcher[]
}

export interface KeywordSkillRegistry {
  readonly routes: readonly KeywordSkillRoute[]
  readonly diagnostics: readonly string[]
}

export type KeywordSkillResolution =
  | { readonly kind: 'none' }
  | { readonly kind: 'match'; readonly route: KeywordSkillRoute }
  | { readonly kind: 'ambiguous'; readonly routes: readonly KeywordSkillRoute[] }

export interface KeywordSkillRouter {
  routeInteractiveInput(text: string, notify: Notify): InputEventResult
  routeExtensionInput(text: string, notify: Notify): InputEventResult
  expandExtensionInput(text: string, notify: Notify): ExpandedSkillInput
}

export interface SkillInvocationPresentation {
  readonly version: 1
  readonly skillName: string
  readonly originalText: string
}

export interface ExpandedSkillInput {
  readonly text: string
  readonly presentation?: SkillInvocationPresentation
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined
}

function asList(value: unknown): readonly unknown[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

function skillNameFromCommand(command: SlashCommandInfo, frontmatter: Frontmatter): string {
  if (command.name.startsWith('skill:')) return command.name.slice('skill:'.length)
  return typeof frontmatter.name === 'string' && frontmatter.name.trim()
    ? frontmatter.name.trim()
    : command.name
}

function parseKeywordMatchers(
  config: UnknownRecord,
  filePath: string,
  diagnostics: string[],
): KeywordSkillMatcher[] {
  const matchers: KeywordSkillMatcher[] = []
  const caseSensitive = config['case-sensitive'] === true

  if (config['case-sensitive'] !== undefined && typeof config['case-sensitive'] !== 'boolean') {
    diagnostics.push(`${filePath}: metadata.keyword-invoke.case-sensitive must be a boolean`)
  }

  for (const value of asList(config.keywords)) {
    if (typeof value !== 'string' || value.length === 0) {
      diagnostics.push(`${filePath}: metadata.keyword-invoke.keywords entries must be non-empty strings`)
      continue
    }
    matchers.push({ kind: 'keyword', value, caseSensitive })
  }

  for (const value of asList(config.regex)) {
    const entry = asRecord(value)
    const pattern = typeof value === 'string' ? value : entry?.pattern
    const flags = typeof value === 'string' ? '' : (entry?.flags ?? '')

    if (typeof pattern !== 'string' || pattern.length === 0 || typeof flags !== 'string') {
      diagnostics.push(`${filePath}: regex entries must be strings or { pattern, flags? } objects`)
      continue
    }
    if (/[gy]/.test(flags)) {
      diagnostics.push(`${filePath}: regex flags "g" and "y" are not supported because matching must be stateless`)
      continue
    }

    try {
      matchers.push({ kind: 'regex', regex: new RegExp(pattern, flags) })
    } catch (error) {
      diagnostics.push(`${filePath}: invalid keyword-invoke regex: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return matchers
}

/** Build routes from the skill commands Pi has already discovered and trusted. */
export function loadKeywordSkillRegistry(commands: readonly SlashCommandInfo[]): KeywordSkillRegistry {
  const routes: KeywordSkillRoute[] = []
  const diagnostics: string[] = []

  for (const command of commands) {
    if (command.source !== 'skill') continue

    const filePath = command.sourceInfo.path
    let frontmatter: Frontmatter
    try {
      frontmatter = parseFrontmatter<Frontmatter>(readFileSync(filePath, 'utf8')).frontmatter
    } catch (error) {
      diagnostics.push(`${filePath}: unable to read skill frontmatter: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }

    const metadata = asRecord(frontmatter.metadata)
    const configValue = metadata?.['keyword-invoke']
    if (configValue === undefined) continue

    const config = asRecord(configValue)
    if (!config) {
      diagnostics.push(`${filePath}: metadata.keyword-invoke must be a mapping`)
      continue
    }
    if (frontmatter['disable-model-invocation'] !== true) {
      diagnostics.push(`${filePath}: keyword-invoked skills must set disable-model-invocation: true`)
      continue
    }

    const priorityValue = config.priority ?? 0
    if (typeof priorityValue !== 'number' || !Number.isFinite(priorityValue)) {
      diagnostics.push(`${filePath}: metadata.keyword-invoke.priority must be a finite number`)
      continue
    }

    const matchers = parseKeywordMatchers(config, filePath, diagnostics)
    if (matchers.length === 0) {
      diagnostics.push(`${filePath}: metadata.keyword-invoke must define at least one valid keyword or regex`)
      continue
    }

    routes.push({
      skillName: skillNameFromCommand(command, frontmatter),
      filePath,
      priority: priorityValue,
      matchers,
    })
  }

  return { routes, diagnostics }
}

function matcherMatches(matcher: KeywordSkillMatcher, text: string): boolean {
  if (matcher.kind === 'regex') return matcher.regex.test(text)
  if (matcher.caseSensitive) return text.includes(matcher.value)
  return text.toLowerCase().includes(matcher.value.toLowerCase())
}

/** Resolve one input deterministically; equal-priority overlaps are ambiguous. */
export function resolveKeywordSkill(
  routes: readonly KeywordSkillRoute[],
  text: string,
): KeywordSkillResolution {
  const matches = routes.filter((route) => route.matchers.some((matcher) => matcherMatches(matcher, text)))
  if (matches.length === 0) return { kind: 'none' }

  const highestPriority = Math.max(...matches.map((route) => route.priority))
  const winners = matches.filter((route) => route.priority === highestPriority)
  if (winners.length > 1) return { kind: 'ambiguous', routes: winners }
  return { kind: 'match', route: winners[0]! }
}

function explicitSkillInvocation(text: string): { skillName: string; args: string } | undefined {
  const match = /^\/skill:([^\s]+)(?:\s+([\s\S]*))?$/.exec(text)
  if (!match) return undefined
  return { skillName: match[1]!, args: match[2]?.trim() ?? '' }
}

function expandSkill(command: SlashCommandInfo, skillName: string, args: string): string {
  const filePath = command.sourceInfo.path
  const body = stripFrontmatter(readFileSync(filePath, 'utf8')).trim()
  const block = `<skill name="${skillName}" location="${filePath}">\nReferences are relative to ${dirname(filePath)}.\n\n${body}\n</skill>`
  return args ? `${block}\n\n${args}` : block
}

/**
 * One lazy resolver shared by native Pi input hooks and authenticated GUI
 * bridge delivery. Keeping expansion here matters because pi.sendUserMessage()
 * labels bridge messages as extension input and disables Pi's own expansion.
 */
export function createKeywordSkillRouter(pi: Pick<ExtensionAPI, 'getCommands'>): KeywordSkillRouter {
  let commands: readonly SlashCommandInfo[] | undefined
  let registry: KeywordSkillRegistry | undefined
  let diagnosticsReported = false

  function ensureLoaded(notify: Notify): readonly SlashCommandInfo[] {
    commands ??= pi.getCommands()
    registry ??= loadKeywordSkillRegistry(commands)
    if (!diagnosticsReported) {
      diagnosticsReported = true
      for (const diagnostic of registry.diagnostics.slice(0, 3)) notify(`Keyword skills: ${diagnostic}`)
      if (registry.diagnostics.length > 3) {
        notify(`Keyword skills: ${registry.diagnostics.length - 3} additional configuration error(s)`)
      }
    }
    return commands
  }

  function resolveInvocation(text: string, notify: Notify): { skillName: string; args: string } | undefined {
    const explicit = explicitSkillInvocation(text)
    if (explicit) return explicit

    ensureLoaded(notify)
    const resolution = resolveKeywordSkill(registry!.routes, text)
    if (resolution.kind === 'none') return undefined
    if (resolution.kind === 'ambiguous') {
      throw new Error(`Keyword skill match is ambiguous: ${resolution.routes.map((route) => route.skillName).join(', ')}`)
    }
    return { skillName: resolution.route.skillName, args: text }
  }

  function expandInvocation(
    text: string,
    invocation: { skillName: string; args: string },
    notify: Notify,
  ): ExpandedSkillInput {
    const command = ensureLoaded(notify).find(
      (candidate) => candidate.source === 'skill' && candidate.name === `skill:${invocation.skillName}`,
    )
    if (!command) return { text }
    return {
      text: expandSkill(command, invocation.skillName, invocation.args),
      presentation: {
        version: 1,
        skillName: invocation.skillName,
        originalText: invocation.args || text,
      },
    }
  }

  return {
    routeInteractiveInput(text, notify) {
      // Explicit interactive commands are expanded by AgentSession after input hooks.
      if (explicitSkillInvocation(text)) return { action: 'continue' }
      try {
        const invocation = resolveInvocation(text, notify)
        return invocation
          ? { action: 'transform', text: `/skill:${invocation.skillName} ${invocation.args}` }
          : { action: 'continue' }
      } catch (error) {
        notify(error instanceof Error ? error.message : String(error))
        return { action: 'handled' }
      }
    },

    routeExtensionInput(text, notify) {
      // Extension commands use pi.sendUserMessage(), which deliberately disables
      // Pi's own command/template expansion. Expand only an explicit skill command
      // here; broad keyword routing of arbitrary extension chatter would recurse.
      const invocation = explicitSkillInvocation(text)
      if (!invocation) return { action: 'continue' }
      try {
        const expanded = expandInvocation(text, invocation, notify)
        return expanded.presentation
          ? { action: 'transform', text: expanded.text }
          : { action: 'continue' }
      } catch (error) {
        notify(error instanceof Error ? error.message : String(error))
        return { action: 'handled' }
      }
    },

    expandExtensionInput(text, notify) {
      const invocation = resolveInvocation(text, notify)
      return invocation ? expandInvocation(text, invocation, notify) : { text }
    },
  }
}
