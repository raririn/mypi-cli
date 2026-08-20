import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '../../core/extensions/types.ts'
import { buildSessionContext, sessionEntryToContextMessages, type SessionEntry } from '../../core/session-manager.ts'
import { GuiControlController, type ControllerState } from './controller.ts'
import { GUI_CONTROL_STATE_EVENT } from './events.ts'
import { BoundedEventQueue } from './transport.ts'
import { loadGuiControlConfig, saveGuiControlConfig } from './config.ts'
import { GUI_CONTROL_MAX_ATTACHMENT_BYTES, GUI_CONTROL_MAX_FRAME_BYTES, GUI_CONTROL_MAX_MESSAGE_BYTES, GUI_CONTROL_MAX_SNAPSHOT_BATCH, GUI_CONTROL_MAX_SNAPSHOT_MESSAGES, type ClientFrame, type ManagedAttachment, type ServerFrame, type TuiSnapshotMetadata, type TuiSnapshotUsage } from './protocol.ts'
import { startTuiPresence, type TuiPresenceHandle } from './presence.ts'
import {
  readLiveForeignLease,
  startSessionOwnership,
  type LeaseInfo,
  type SessionHandoffDecision,
  type SessionHandoffRequest,
  type SessionOwnershipHandle,
} from './ownership.ts'
import { createKeywordSkillRouter } from './keyword-skill-routing.ts'

const HELP = `# /gui-control — TUI-to-GUI bridge

## Commands

/gui-control or /gc
Connect immediately to a running MyPi GUI. New MyPi installs already discover authenticated GUI endpoints automatically.

/gui-control --always
Persist global auto-connect and enable the current TUI session.

/gui-control --never
Persist global no-auto-connect and disconnect the current session. A later plain command can still connect that one session manually.

/gui-control --disconnect
Disconnect only the current TUI session.

/gui-control --status
Show global preference and current transport state.

/gui-control --help
Show this reference.

## Ownership and safety

The TUI remains the only runtime and writer for its session. A local presence lease lets the GUI mark and protect this session even before /gc is enabled. When connected, the GUI reads persisted history directly from the JSONL file, mirrors live Pi events, and sends user messages through this TUI. The GUI must not open the session in a second runtime, and session/project archive is hard-blocked while the TUI is alive.

Approvals remain in the TUI. GUI messages still pass through normal input handling, /safemode, /plan, and /goal enforcement.

## Scope

The bridge mirrors semantic Pi events and durable session entries, not terminal ANSI output, built-in TUI screens, or arbitrary custom components. It is local Unix-socket transport only; it is not an SSH bridge or daemon.

Socket failures are nonfatal. If no GUI is running, enabled control waits quietly with bounded, unref'd backoff and does not interfere with TUI work. Run --disconnect for this session or --never to opt out globally.`

const EVENT_NAMES = [
  'session_info_changed', 'session_tree', 'session_compact', 'model_select', 'thinking_level_select',
  'agent_start', 'agent_end', 'agent_settled', 'turn_start', 'turn_end', 'message_start', 'message_update', 'message_end',
  'tool_execution_start', 'tool_execution_update', 'tool_execution_end', 'queue_update', 'auto_retry_start', 'auto_retry_end', 'extension_error'
] as const

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[depth omitted]'
  if (typeof value === 'string') return value.length > 100_000 ? `${value.slice(0, 100_000)}…[truncated]` : value
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.slice(0, 500).map((item) => sanitize(item, depth + 1))
  if (typeof value === 'object') {
    const input = value as Record<string, unknown>
    if (input.type === 'image' && (typeof input.data === 'string' || typeof input.source === 'object')) return { type: 'image', mimeType: input.mimeType, omitted: true }
    const output: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(input).slice(0, 500)) output[key] = key === 'data' && typeof child === 'string' && child.length > 100_000 ? '[large data omitted]' : sanitize(child, depth + 1)
    return output
  }
  return String(value)
}

function messageRole(value: unknown): string | undefined {
  return value && typeof value === 'object' && typeof (value as { role?: unknown }).role === 'string'
    ? (value as { role: string }).role
    : undefined
}

function messageText(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const content = (value as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.flatMap((part) => part && typeof part === 'object' && (part as { type?: unknown }).type === 'text' && typeof (part as { text?: unknown }).text === 'string'
    ? [(part as { text: string }).text]
    : []).join('\n')
}

function compactPreview(value: string): string | undefined {
  const text = value.trim().replace(/\s+/g, ' ')
  return text ? text.slice(0, 280) : undefined
}

function projectTreeEntry(entry: SessionEntry, label: string | undefined, children: readonly unknown[], budget: { nodes: number }, depth: number): unknown {
  if (depth > 256 || ++budget.nodes > 20_000) throw new Error('Session tree exceeds the GUI bridge bounds')
  const role = entry.type === 'message' ? messageRole(entry.message) : undefined
  const previewSource = entry.type === 'message'
    ? messageText(entry.message)
    : entry.type === 'compaction' || entry.type === 'branch_summary'
      ? entry.summary
      : entry.type === 'session_info'
        ? entry.name ?? ''
        : entry.type === 'label'
          ? entry.label ?? ''
          : entry.type === 'thinking_level_change'
            ? entry.thinkingLevel
            : entry.type === 'model_change'
              ? entry.modelId
              : entry.type === 'custom' || entry.type === 'custom_message'
                ? entry.customType
                : ''
  const title = entry.type === 'message'
    ? role === 'user' ? 'User' : role === 'assistant' ? 'Assistant' : role || 'Message'
    : entry.type === 'branch_summary' ? 'Branch summary'
      : entry.type === 'compaction' ? 'Compaction'
        : entry.type === 'model_change' ? 'Model'
          : entry.type === 'thinking_level_change' ? 'Thinking'
            : entry.type === 'session_info' ? 'Title'
              : entry.type === 'label' ? 'Label'
                : entry.type === 'custom' || entry.type === 'custom_message' ? entry.customType.slice(0, 80) : 'Custom'
  const preview = compactPreview(previewSource)
  return {
    id: entry.id,
    parentId: entry.parentId,
    kind: entry.type,
    timestamp: entry.timestamp,
    ...(label ? { label: label.slice(0, 512) } : {}),
    ...(role ? { role } : {}),
    ...(entry.type === 'custom' || entry.type === 'custom_message' ? { customType: entry.customType.slice(0, 512) } : {}),
    title,
    ...(preview ? { preview } : {}),
    children: children.map((child) => {
      if (!child || typeof child !== 'object') throw new Error('Session tree contains a malformed child')
      const node = child as { entry?: SessionEntry; label?: string; children?: readonly unknown[] }
      if (!node.entry || !Array.isArray(node.children)) throw new Error('Session tree contains a malformed node')
      return projectTreeEntry(node.entry, node.label, node.children, budget, depth + 1)
    }),
  }
}

function projectSessionTree(ctx: ExtensionContext): unknown {
  const budget = { nodes: 0 }
  return {
    roots: ctx.sessionManager.getTree().map((node) => projectTreeEntry(node.entry, node.label, node.children, budget, 0)),
    leafId: ctx.sessionManager.getLeafId(),
  }
}

function resolveForkEntry(ctx: ExtensionContext, renderedMessageIndex: number, renderedMessageText?: string): string {
  const entries = ctx.sessionManager.getEntries()
  const branch = ctx.sessionManager.getBranch()
  if (entries.length > 100_000 || branch.length > 100_000) throw new Error('Session has too many entries to fork safely')
  const rendered = buildSessionContext(entries, ctx.sessionManager.getLeafId()).messages.flatMap((message) => {
    const role = messageRole(message)
    const text = messageText(message)
    return role && text ? [{ role, text }] : []
  })
  if (renderedMessageIndex >= rendered.length) throw new Error('The selected transcript message is no longer available')
  const branchMessages = branch.filter((entry): entry is Extract<SessionEntry, { type: 'message' }> => entry.type === 'message')
  let selected: Extract<SessionEntry, { type: 'message' }> | undefined
  let start = 0
  for (const [index, message] of rendered.entries()) {
    if (!['user', 'assistant'].includes(message.role)) {
      if (index === renderedMessageIndex) break
      continue
    }
    const branchIndex = branchMessages.findIndex((entry, candidateIndex) => candidateIndex >= start && messageRole(entry.message) === message.role && messageText(entry.message) === message.text)
    if (branchIndex < 0) break
    if (index === renderedMessageIndex) {
      selected = branchMessages[branchIndex]
      break
    }
    start = branchIndex + 1
  }
  if (renderedMessageText !== undefined && (messageRole(selected?.message) !== 'assistant' || messageText(selected?.message) !== renderedMessageText)) {
    const exact = branchMessages.filter((entry) => messageRole(entry.message) === 'assistant' && messageText(entry.message) === renderedMessageText)
    selected = exact.length === 1 ? exact[0] : undefined
  }
  if (!selected) throw new Error('The selected transcript message no longer maps to the active session branch')
  const selectedIndex = branch.findIndex((entry) => entry.id === selected!.id)
  const role = messageRole(selected.message)
  const nextIndex = branch.findIndex((entry, index) => {
    if (index <= selectedIndex || entry.type !== 'message') return false
    const nextRole = messageRole(entry.message)
    return role === 'assistant' ? nextRole === 'user' || nextRole === 'assistant' : nextRole === 'user'
  })
  return nextIndex > selectedIndex ? branch[nextIndex - 1]?.id ?? selected.id : branch.at(-1)?.id ?? selected.id
}

/**
 * Finds a live session-host (FEAT-060) serving the given session file, so a
 * lease refusal can point at `mypi attach` instead of a dead end. Purely a
 * discovery read; ownership semantics are untouched.
 */
function findLiveHostForSessionFile(agentDir: string, sessionFile: string): { sessionId: string } | undefined {
  const hostsDirectory = join(agentDir, 'hosts')
  let entries: string[]
  try {
    entries = readdirSync(hostsDirectory)
  } catch {
    return undefined
  }
  const wanted = resolve(sessionFile)
  for (const entry of entries) {
    if (!entry.endsWith('.host.json')) continue
    try {
      const sidecar = JSON.parse(readFileSync(join(hostsDirectory, entry), 'utf8')) as {
        pid?: number
        socketPath?: string
        sessionId?: string
        sessionFile?: string | null
      }
      if (!sidecar?.sessionId || typeof sidecar.pid !== 'number') continue
      if (!sidecar.sessionFile || resolve(sidecar.sessionFile) !== wanted) continue
      try {
        process.kill(sidecar.pid, 0)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') continue
      }
      if (!sidecar.socketPath || !existsSync(sidecar.socketPath)) continue
      return { sessionId: sidecar.sessionId }
    } catch {
      continue
    }
  }
  return undefined
}

export default function guiControlExtension(pi: ExtensionAPI): void {
  const agentDir = resolve(process.env.MYPI_AGENT_DIR || process.env.MYPI_CODING_AGENT_DIR || join(homedir(), '.mypi', 'agent'))
  const connectionId = randomUUID()
  const processStartTime = Math.round(performance.timeOrigin)
  let controller: GuiControlController | undefined
  let presence: TuiPresenceHandle | undefined
  let ownership: SessionOwnershipHandle | undefined
  let currentCtx: ExtensionContext | undefined
  let currentCommandCtx: ExtensionCommandContext | undefined
  let preference = loadGuiControlConfig(agentDir).config.autoConnect
  let sequence = 0
  let gapPending = false
  let lastSnapshotCursor: string | undefined
  let agentBusy = false
  let latestGoalSnapshotEvent: { snapshot: unknown } = { snapshot: null }
  const eventQueue = new BoundedEventQueue()
  const handledRequests = new Map<string, { accepted: boolean; error?: string; result?: unknown }>()
  const keywordSkillRouter = createKeywordSkillRouter(pi)

  function status(_ctx: ExtensionContext, state: ControllerState): void {
    // GUI control state is intentionally not shown in the footer: the surface
    // structure never assumes GUI control is inactive, and the row was noise.
    // Consumers that need the state still receive the event.
    pi.events.emit(GUI_CONTROL_STATE_EVENT, { state, connected: state === 'connected' })
  }

  function hello() {
    if (!currentCtx) throw new Error('TUI session context is unavailable')
    const sm = currentCtx.sessionManager
    const model = currentCtx.model
    return { connectionId, mode: 'tui' as const, pid: process.pid, processStartTime, cwd: currentCtx.cwd, sessionId: sm.getSessionId(), sessionFile: sm.getSessionFile(), sessionName: pi.getSessionName(), leafId: sm.getLeafId() ?? undefined, model: model ? { provider: model.provider, id: model.id, name: model.name } : null, thinkingLevel: pi.getThinkingLevel(), busy: agentBusy || !currentCtx.isIdle(), managedAttachmentTransport: 'local-path-v1' as const }
  }

  function send(frame: ClientFrame): boolean { return controller?.send(frame) ?? false }

  function snapshotUsage(ctx: ExtensionContext): TuiSnapshotUsage {
    let inputTokens = 0
    let outputTokens = 0
    let cacheReadTokens = 0
    let cacheWriteTokens = 0
    let cost = 0
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== 'message' || entry.message.role !== 'assistant') continue
      const usage = entry.message.usage
      inputTokens += usage.input
      outputTokens += usage.output
      cacheReadTokens += usage.cacheRead
      cacheWriteTokens += usage.cacheWrite
      cost += usage.cost.total
    }
    const context = ctx.getContextUsage()
    return {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      cost,
      usingSubscription: Boolean(ctx.model && ctx.modelRegistry.isUsingOAuth(ctx.model)),
      contextTokens: context?.tokens ?? null,
      contextWindow: context?.contextWindow ?? ctx.model?.contextWindow ?? 0,
      contextPercent: context?.percent ?? null,
      autoCompact: true
    }
  }

  function snapshotMetadata(ctx: ExtensionContext): TuiSnapshotMetadata {
    const model = ctx.model
    return {
      sessionId: ctx.sessionManager.getSessionId(),
      cwd: ctx.cwd,
      sessionFile: ctx.sessionManager.getSessionFile(),
      sessionName: pi.getSessionName(),
      updatedAt: new Date().toISOString(),
      busy: agentBusy || !ctx.isIdle(),
      model: model ? { provider: model.provider, id: model.id, name: model.name } : null,
      thinkingLevel: pi.getThinkingLevel(),
      usage: snapshotUsage(ctx),
      capabilities: {
        operations: ['compact', 'rename', 'set_model', 'set_thinking', 'reload', 'abort', 'get_tree', 'navigate_tree', 'resolve_fork', 'shutdown'],
        models: ctx.modelRegistry.getAvailable().slice(0, 2_000).map((candidate) => ({
          provider: candidate.provider,
          id: candidate.id,
          name: candidate.name,
          contextWindow: candidate.contextWindow
        }))
      }
    }
  }

  function snapshotBatches(messages: unknown[]): unknown[][] {
    if (messages.length > GUI_CONTROL_MAX_SNAPSHOT_MESSAGES) throw new Error(`Snapshot has ${messages.length} messages; maximum is ${GUI_CONTROL_MAX_SNAPSHOT_MESSAGES}`)
    const batches: unknown[][] = []
    let batch: unknown[] = []
    let batchBytes = 0
    const maxPayloadBytes = GUI_CONTROL_MAX_FRAME_BYTES - 16 * 1024
    for (const message of messages) {
      const messageBytes = Buffer.byteLength(JSON.stringify(message))
      if (messageBytes > maxPayloadBytes) throw new Error('A snapshot message exceeds the bridge frame limit')
      if (batch.length > 0 && (batch.length >= GUI_CONTROL_MAX_SNAPSHOT_BATCH || batchBytes + messageBytes > maxPayloadBytes)) {
        batches.push(batch); batch = []; batchBytes = 0
      }
      batch.push(message); batchBytes += messageBytes
    }
    if (batch.length > 0) batches.push(batch)
    return batches
  }

  function sendSnapshot(since?: string): void {
    if (!currentCtx || controller?.getState() !== 'connected') return
    try {
      const entries = currentCtx.sessionManager.getBranch()
      const cursorIndex = since ? entries.findIndex((entry) => entry.id === since) : -1
      const tail = cursorIndex >= 0 ? entries.slice(cursorIndex + 1) : []
      const full = !since || cursorIndex < 0 || tail.some((entry) => entry.type === 'compaction' || entry.type === 'branch_summary')
      const leafId = currentCtx.sessionManager.getLeafId() ?? undefined
      const cursor = leafId
      const messages = full
        ? buildSessionContext(currentCtx.sessionManager.getEntries(), leafId ?? null).messages
        : tail.flatMap((entry) => sessionEntryToContextMessages(entry as SessionEntry))
      const sanitized = sanitize(messages) as unknown[]
      const batches = snapshotBatches(sanitized)
      const snapshotId = randomUUID()
      send({
        type: 'snapshot_start',
        connectionId,
        snapshotId,
        full,
        ...(!full && since ? { baseCursor: since } : {}),
        ...(cursor ? { cursor } : {}),
        ...(leafId ? { leafId } : {}),
        metadata: snapshotMetadata(currentCtx)
      })
      batches.forEach((batch, index) => send({ type: 'snapshot_batch', connectionId, snapshotId, index, messages: batch }))
      send({ type: 'snapshot_end', connectionId, snapshotId, ...(cursor ? { cursor } : {}), ...(leafId ? { leafId } : {}), batchCount: batches.length })
      lastSnapshotCursor = cursor
      eventQueue.clearDirty(); gapPending = false
    } catch (error) {
      send({ type: 'gap', connectionId, reason: `Snapshot failed: ${error instanceof Error ? error.message : String(error)}` })
    }
  }

  function sendEvent(eventName: string, event: unknown): void {
    if (eventName === 'agent_start') agentBusy = true
    else if (eventName === 'agent_settled') agentBusy = false
    if (controller?.getState() !== 'connected') return
    const normalized = sanitize({ type: eventName, ...(event && typeof event === 'object' ? event as object : { value: event }) }) as Record<string, unknown>
    const frame: ClientFrame = { type: 'event', connectionId, sequence: ++sequence, event: normalized }
    eventQueue.enqueue(frame)
    eventQueue.drain(send)
    if (eventQueue.isDirty() && !gapPending) { gapPending = true; send({ type: 'gap', connectionId, reason: 'Streaming event dropped under backpressure' }) }
    if (eventName === 'message_end' || eventName === 'agent_settled') {
      eventQueue.drain(send)
      if (gapPending) sendSnapshot()
    }
    if (eventName === 'agent_start' || eventName === 'agent_settled' || eventName === 'session_tree' || eventName === 'session_compact' || eventName === 'session_info_changed' || eventName === 'model_select' || eventName === 'thinking_level_select') {
      sendSnapshot(lastSnapshotCursor)
    }
  }

  async function loadManagedAttachments(attachments: readonly ManagedAttachment[] | undefined): Promise<{
    images: Array<{ type: 'image'; data: string; mimeType: string }>
    files: ManagedAttachment[]
  }> {
    if (!attachments?.length) return { images: [], files: [] }
    const managedRoot = await realpath(resolve(agentDir, 'tui-bridge-attachments'))
    const images: Array<{ type: 'image'; data: string; mimeType: string }> = []
    const files: ManagedAttachment[] = []
    let totalBytes = 0
    for (const attachment of attachments) {
      const candidate = resolve(attachment.fsPath)
      // macOS commonly exposes /var through the /private/var symlink. Compare
      // canonical paths so a file staged through that system alias is not
      // mistaken for an escape from the managed root.
      const canonicalCandidate = await realpath(candidate)
      const rel = relative(managedRoot, canonicalCandidate)
      if (!rel || rel.startsWith('..') || rel.includes('\0')) throw new Error('Attachment path is outside MyPi managed storage')
      const stats = await lstat(candidate)
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size !== attachment.sizeBytes || stats.size > GUI_CONTROL_MAX_ATTACHMENT_BYTES) {
        throw new Error('Attachment file failed regular-file and size validation')
      }
      totalBytes += stats.size
      if (totalBytes > 20 * 1024 * 1024) throw new Error('Attachments exceed the 20 MB total limit')
      if (attachment.kind === 'image') {
        if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(attachment.mimeType)) throw new Error('Unsupported image attachment type')
        images.push({ type: 'image', data: (await readFile(candidate)).toString('base64'), mimeType: attachment.mimeType })
      } else {
        files.push(attachment)
      }
    }
    return { images, files }
  }

  function fileAttachmentPreamble(message: string, files: readonly ManagedAttachment[]): string {
    if (files.length === 0) return message
    const payload = JSON.stringify({
      version: 1,
      files: files.map((file) => ({
        kind: 'file', name: file.name, mimeType: file.mimeType, fsPath: file.fsPath, sizeBytes: file.sizeBytes,
      })),
    })
    const block = `<pi-gui-file-attachments>${payload}</pi-gui-file-attachments>`
    return message ? `${block}\n${message}` : block
  }

  async function answerSend(frame: Extract<ServerFrame, { type: 'send_message' }>): Promise<void> {
    const previous = handledRequests.get(frame.requestId)
    if (previous) { send({ type: 'send_result', connectionId, requestId: frame.requestId, ...previous }); return }
    let result: { accepted: boolean; error?: string; result?: unknown }
    try {
      if ((!frame.message.trim() && !frame.attachments?.length) || Buffer.byteLength(frame.message) > GUI_CONTROL_MAX_MESSAGE_BYTES) throw new Error('Message is empty or too large')
      if (!currentCtx) throw new Error('TUI session is unavailable')
      const expanded = keywordSkillRouter.expandExtensionInput(
        frame.message,
        (diagnostic) => currentCtx!.ui.notify(diagnostic, 'warning'),
      )
      const { images, files } = await loadManagedAttachments(frame.attachments)
      const message = fileAttachmentPreamble(expanded.text, files)
      const queuedDelivery = frame.delivery === 'followUp'
        ? 'followUp'
        : frame.delivery === 'steer' || (frame.delivery === 'auto' && !currentCtx.isIdle())
          ? 'steer'
          : undefined
      const textPart = {
        type: 'text' as const,
        text: message,
        ...(expanded.presentation ? { mypiSkillInvocation: expanded.presentation } : {}),
        ...(queuedDelivery ? { mypiQueuedMessageMode: queuedDelivery } : {}),
        ...(queuedDelivery && frame.queuedMessageId
          ? { mypiQueuedMessageId: frame.queuedMessageId }
          : {}),
      }
      const content = images.length > 0 || expanded.presentation || queuedDelivery ? [textPart, ...images] : message
      if (queuedDelivery === 'followUp') pi.sendUserMessage(content, { deliverAs: 'followUp' })
      else if (queuedDelivery === 'steer') pi.sendUserMessage(content, { deliverAs: 'steer' })
      else pi.sendUserMessage(content)
      result = { accepted: true }
    } catch (error) { result = { accepted: false, error: error instanceof Error ? error.message : String(error) } }
    handledRequests.set(frame.requestId, result)
    while (handledRequests.size > 256) handledRequests.delete(handledRequests.keys().next().value!)
    send({ type: 'send_result', connectionId, requestId: frame.requestId, ...result })
  }

  async function answerOperation(frame: Extract<ServerFrame, { type: 'execute_operation' }>): Promise<void> {
    const previous = handledRequests.get(frame.requestId)
    if (previous) { send({ type: 'operation_result', connectionId, requestId: frame.requestId, ...previous }); return }
    let result: { accepted: boolean; error?: string; result?: unknown }
    try {
      if (!currentCtx) throw new Error('TUI session is unavailable')
      const operation = frame.operation
      if (operation.type === 'compact') {
        currentCtx.compact(operation.customInstructions ? { customInstructions: operation.customInstructions } : undefined)
      } else if (operation.type === 'rename') {
        pi.setSessionName(operation.title)
        sendSnapshot()
      } else if (operation.type === 'set_model') {
        const model = currentCtx.modelRegistry.find(operation.provider, operation.modelId)
        if (!model) throw new Error(`Model not found: ${operation.provider}/${operation.modelId}`)
        if (!await pi.setModel(model)) throw new Error(`Model is unavailable: ${operation.provider}/${operation.modelId}`)
      } else if (operation.type === 'set_thinking') {
        pi.setThinkingLevel(operation.level as any)
        sendSnapshot()
      } else if (operation.type === 'reload') {
        if (!currentCommandCtx) throw new Error('Run /gc once in this TUI before requesting reload from GUI')
        result = { accepted: true }
        handledRequests.set(frame.requestId, result)
        send({ type: 'operation_result', connectionId, requestId: frame.requestId, ...result })
        await currentCommandCtx.reload()
        return
      } else if (operation.type === 'abort') {
        currentCtx.abort()
      } else if (operation.type === 'get_tree') {
        if (!currentCtx.isIdle()) throw new Error('Stop the remote task before opening its branch tree')
        result = { accepted: true, result: projectSessionTree(currentCtx) }
      } else if (operation.type === 'navigate_tree') {
        if (!currentCtx.isIdle()) throw new Error('Stop the remote task before navigating its branch tree')
        const navigation = await (currentCtx as ExtensionContext & Pick<ExtensionCommandContext, 'navigateTree'>).navigateTree(operation.targetId, {
          summarize: operation.summarize === true,
          ...(operation.customInstructions ? { customInstructions: operation.customInstructions } : {}),
        })
        result = { accepted: true, result: navigation }
        sendSnapshot()
      } else if (operation.type === 'resolve_fork') {
        if (!currentCtx.isIdle()) throw new Error('Stop the remote task before forking it')
        result = {
          accepted: true,
          result: {
            entryId: resolveForkEntry(currentCtx, operation.renderedMessageIndex, operation.renderedMessageText),
          },
        }
      } else if (operation.type === 'shutdown') {
        if (!currentCtx.isIdle()) throw new Error('Stop the remote task before archiving it')
        const shutdownCtx = currentCtx
        result = { accepted: true }
        handledRequests.set(frame.requestId, result)
        send({ type: 'operation_result', connectionId, requestId: frame.requestId, ...result })
        setTimeout(() => shutdownCtx.shutdown(), 0)
        return
      }
      result ??= { accepted: true }
    } catch (error) { result = { accepted: false, error: error instanceof Error ? error.message : String(error) } }
    handledRequests.set(frame.requestId, result)
    while (handledRequests.size > 256) handledRequests.delete(handledRequests.keys().next().value!)
    send({ type: 'operation_result', connectionId, requestId: frame.requestId, ...result })
  }

  function createController(ctx: ExtensionContext): GuiControlController {
    return new GuiControlController({ agentDir, callbacks: {
      createHello: hello,
      onState: (state) => status(ctx, state),
      onConnected: (lastEntryId) => { eventQueue.clear(); sendSnapshot(lastEntryId); sendEvent('goal_snapshot', latestGoalSnapshotEvent) },
      onResync: (since) => sendSnapshot(since),
      onSendMessage: (frame) => { void answerSend(frame) },
      onExecuteOperation: (frame) => { void answerOperation(frame) }
    } })
  }

  async function command(args: string, ctx: ExtensionCommandContext): Promise<void> {
    currentCommandCtx = ctx
    const option = args.trim().toLowerCase()
    if (option === '--help') { await ctx.ui.editor('GUI control help', HELP); return }
    if (ctx.mode !== 'tui') { ctx.ui.notify('GUI control is available only in Pi TUI sessions.', 'warning'); return }
    if (!controller) { currentCtx = ctx; controller = createController(ctx) }
    if (!option) { controller.enable(); ctx.ui.notify('GUI control enabled for this TUI session.', 'info'); return }
    if (option === '--always' || option === '--never') {
      preference = option === '--always' ? 'always' : 'never'
      try { saveGuiControlConfig(agentDir, { version: 1, autoConnect: preference }) }
      catch (error) { ctx.ui.notify(`Could not save GUI-control preference: ${error instanceof Error ? error.message : String(error)}`, 'error'); return }
      if (preference === 'always') controller.enable(); else controller.disable()
      ctx.ui.notify(`GUI-control auto-connect is ${preference}.`, 'info'); return
    }
    if (option === '--disconnect') { controller.disable(); ctx.ui.notify('GUI control disconnected for this session.', 'info'); return }
    if (option === '--status') { ctx.ui.notify(`GUI control: ${controller.getState()}${controller.getDetail() ? ` (${controller.getDetail()})` : ''}; global auto-connect: ${preference}.`, 'info'); return }
    ctx.ui.notify('Usage: /gui-control [--always|--never|--disconnect|--status|--help]', 'warning')
  }

  const commandDefinition = { description: 'Mirror and control this TUI session from MyPi GUI', getArgumentCompletions: (prefix: string) => { const values = ['--always', '--never', '--disconnect', '--status', '--help']; const items = values.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })); return items.length ? items : null }, handler: command }
  pi.registerCommand('gui-control', commandDefinition)
  pi.registerCommand('gc', commandDefinition)

  // An ownership refusal must survive the TUI's alternate-screen teardown and
  // must not read as success: a launcher wrapper (CloudCLI runs
  // `mypi --session <id> || mypi` in a terminal) can only offer its fallback
  // when the refused process exits nonzero, and the reason is invisible
  // unless it also lands on stderr.
  function refuseAndShutdown(
    ctx: ExtensionContext,
    message: string,
    conflict?: { sessionFile: string; holder: LeaseInfo },
  ): void {
    ctx.ui.notify(message, 'error')
    // This private engine-to-daemon frame is deliberately prefixed so normal
    // stderr (including arbitrary JSON from extensions) can never be mistaken
    // for an ownership conflict. The daemon keeps the control capability
    // private and exposes only sanitized owner diagnostics to clients.
    if (conflict && process.env.MYPI_DAEMON_ENGINE === '1') {
      process.stderr.write(`@@MYPI_OWNERSHIP_CONFLICT@@${JSON.stringify({
        protocol: 1,
        sessionFile: conflict.sessionFile,
        owner: conflict.holder,
      })}\n`)
    }
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
    setTimeout(() => ctx.shutdown(), 0)
    // session_start can fire while the runtime is still being assembled, when
    // the surface's shutdown bridge is not bound yet — the request above is
    // then a silent no-op and the session would keep running *without* the
    // writer lease. Enforce the refusal: if graceful shutdown has not exited
    // the process shortly, leave the alternate screen (harmless when it was
    // never entered), restore the cursor, and exit nonzero ourselves.
    const enforce = setTimeout(() => {
      process.stderr.write('\u001b[?1049l\u001b[?25h')
      process.exit(1)
    }, 1500)
    enforce.unref?.()
  }

  async function handleHandoffRequest(
    ctx: ExtensionContext,
    request: SessionHandoffRequest,
  ): Promise<SessionHandoffDecision> {
    if (!request.force) {
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        return {
          status: 'busy',
          message: 'The owner has an active turn or queued input. Manage it in the owning process before retrying.',
        }
      }
      const accepted = await ctx.ui.confirm(
        'Session handoff requested',
        `Another MyPi process (pid ${request.requesterPid}) wants to resume this session. Release it and close this session process?`,
      )
      if (!accepted) return { status: 'declined', message: 'The owner declined the handoff request.' }
    } else if (!ctx.isIdle()) {
      ctx.abort()
    }

    ctx.ui.notify(
      request.force
        ? `Rob requested by MyPi pid ${request.requesterPid}; aborting active work and releasing the session.`
        : `Handoff accepted for MyPi pid ${request.requesterPid}; releasing the session.`,
      request.force ? 'warning' : 'info',
    )
    // Let the authenticated control response flush before graceful shutdown
    // emits session_shutdown and releases the writer lease.
    const shutdownTimer = setTimeout(() => ctx.shutdown(), 50)
    shutdownTimer.unref?.()
    return { status: 'accepted' }
  }

  pi.on('session_before_switch', (event, ctx) => {
    if ((ctx.mode !== 'tui' && ctx.mode !== 'rpc') || !event.targetSessionFile) return
    const holder = readLiveForeignLease(event.targetSessionFile)
    if (!holder) return
    const owner = holder.pid > 0 ? `${holder.surface} (pid ${holder.pid})` : 'another or unverifiable Pi writer'
    const liveHost = findLiveHostForSessionFile(agentDir, event.targetSessionFile)
    ctx.ui.notify(
      liveHost
        ? `Cannot resume this session here: it is live in a session host (${owner}). Take it over with \`mypi attach --take ${liveHost.sessionId}\` or mirror it with \`mypi attach ${liveHost.sessionId}\`.`
        : `Cannot resume this session here: it is owned by ${owner}. Close or release the owning surface first.`,
      'error',
    )
    return { cancel: true }
  })

  pi.on('session_start', (event, ctx) => {
    currentCtx = ctx
    agentBusy = !ctx.isIdle()
    if (ctx.mode !== 'tui' && ctx.mode !== 'rpc') return
    ownership?.stop(); ownership = undefined
    const sessionFile = ctx.sessionManager.getSessionFile()
    if (sessionFile) {
      const holder = readLiveForeignLease(sessionFile)
      if (holder) {
        const owner = holder.pid > 0 ? `${holder.surface} (pid ${holder.pid})` : 'another or unverifiable Pi writer'
        const liveHost = findLiveHostForSessionFile(agentDir, sessionFile)
        const message = liveHost
          ? `This session is live in a session host (${owner}). Take it over with \`mypi attach --take ${liveHost.sessionId}\` or mirror it with \`mypi attach ${liveHost.sessionId}\`.`
          : `This session is owned by ${owner} and cannot be continued in TUI. Continue it in MyPi GUI, or close/release the other session first.`
        refuseAndShutdown(ctx, message, { sessionFile, holder })
        return
      }
      try {
        ownership = startSessionOwnership(sessionFile, {
          reuseExisting: event.reason === 'reload',
          surface: ctx.mode === 'rpc' ? 'mypi-gui-rpc' : 'pi-cli',
          agentDir,
          onHandoffRequest: (request) => handleHandoffRequest(ctx, request),
          onCompromised: (error) => {
            refuseAndShutdown(ctx, `Session writer lock was compromised: ${error.message}. Shutting down to prevent concurrent writes.`)
          },
        })
      } catch (error) {
        const holder = readLiveForeignLease(sessionFile)
        refuseAndShutdown(
          ctx,
          `Could not acquire the session writer lock: ${error instanceof Error ? error.message : String(error)}`,
          holder ? { sessionFile, holder } : undefined,
        )
        return
      }
    }
    // RPC is itself the GUI-owned runtime; it needs the same exclusive writer
    // lease but must not try to mirror back through gui-control.
    if (ctx.mode === 'rpc') return
    const loaded = loadGuiControlConfig(agentDir); preference = loaded.config.autoConnect
    if (loaded.error) ctx.ui.notify(`GUI-control config ignored: ${loaded.error}`, 'warning')
    presence?.stop()
    presence = startTuiPresence(agentDir, () => ({ cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile(), sessionName: pi.getSessionName(), leafId: ctx.sessionManager.getLeafId() ?? undefined }))
    // Re-announce on in-process session switch: close the previous connection
    // so the GUI maps this TUI to the new session file instead of keeping the
    // old attribution alive until heartbeat timeout.
    controller?.disable()
    controller = createController(ctx)
    if (preference === 'always') controller.enable()
  })

  for (const eventName of EVENT_NAMES) {
    pi.on(eventName as any, (event: unknown, ctx: ExtensionContext) => { currentCtx = ctx; sendEvent(eventName, event) })
  }
  pi.events.on('mypi:goal-snapshot', (event: unknown) => {
    const snapshot = event && typeof event === 'object' && 'snapshot' in event
      ? (event as { snapshot: unknown }).snapshot
      : null
    latestGoalSnapshotEvent = { snapshot }
    sendEvent('goal_snapshot', latestGoalSnapshotEvent)
  })
  pi.events.on('pi-gui:approval-state', (event: unknown) => sendEvent('tui_approval_state', event))
  pi.on('session_shutdown', (event, ctx) => {
    sendEvent('session_shutdown', event)
    controller?.disable(); controller = undefined
    presence?.stop(); presence = undefined
    const retiringOwnership = ownership
    ownership = undefined
    // Reload reuses the same process-held lock in the replacement extension
    // instance. Other shutdown reasons release on the next event-loop turn so
    // every session_shutdown handler finishes while ownership is still held.
    if (event.reason !== 'reload' && retiringOwnership) {
      const timer = setTimeout(() => retiringOwnership.stop(), 0)
      timer.unref()
    }
    currentCtx = ctx
    currentCommandCtx = undefined
    lastSnapshotCursor = undefined
    agentBusy = false
  })
}
