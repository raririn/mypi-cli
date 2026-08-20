export const MYPI_CONTROL_PROTOCOL = 1
export const GUI_CONTROL_MAX_FRAME_BYTES = 512 * 1024
export const GUI_CONTROL_MAX_BUFFER_BYTES = 1024 * 1024
export const GUI_CONTROL_MAX_MESSAGE_BYTES = 128 * 1024
export const GUI_CONTROL_MAX_SNAPSHOT_BATCH = 50
export const GUI_CONTROL_MAX_SNAPSHOT_BATCHES = 200
export const GUI_CONTROL_MAX_SNAPSHOT_MESSAGES = GUI_CONTROL_MAX_SNAPSHOT_BATCH * GUI_CONTROL_MAX_SNAPSHOT_BATCHES
export const GUI_CONTROL_MAX_ATTACHMENTS = 8
export const GUI_CONTROL_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

export type DeliveryMode = 'auto' | 'steer' | 'followUp'
export interface ManagedAttachment {
  kind: 'image' | 'file'
  name: string
  mimeType: string
  fsPath: string
  sizeBytes: number
}
export type TuiOperation =
  | { type: 'compact'; customInstructions?: string }
  | { type: 'rename'; title: string }
  | { type: 'set_model'; provider: string; modelId: string }
  | { type: 'set_thinking'; level: string }
  | { type: 'reload' }
  | { type: 'abort' }
  | { type: 'get_tree' }
  | { type: 'navigate_tree'; targetId: string; summarize?: boolean; customInstructions?: string }
  | { type: 'resolve_fork'; renderedMessageIndex: number; renderedMessageText?: string }
  | { type: 'shutdown' }

export interface TuiSnapshotUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cost: number
  usingSubscription: boolean
  contextTokens: number | null
  contextWindow: number
  contextPercent: number | null
  autoCompact: boolean
}

export interface TuiSnapshotMetadata {
  sessionId: string
  cwd: string
  sessionFile?: string
  sessionName?: string
  updatedAt: string
  busy: boolean
  model?: { provider: string; id: string; name?: string } | null
  thinkingLevel?: string
  usage: TuiSnapshotUsage
  capabilities: {
    operations: TuiOperation['type'][]
    models: Array<{ provider: string; id: string; name?: string; contextWindow: number }>
  }
}

export interface EndpointManifest {
  application: 'mypi-gui-control'
  protocol: number
  guiInstanceId: string
  pid: number
  socketPath: string
  token: string
  createdAt: string
}

export interface TuiHello {
  type: 'hello'
  protocol: number
  token: string
  connectionId: string
  mode: 'tui'
  pid: number
  /** Stable for the lifetime of one OS process, including extension reloads. */
  processStartTime?: number
  cwd: string
  sessionId: string
  sessionFile?: string
  sessionName?: string
  leafId?: string
  model?: { provider: string; id: string; name?: string } | null
  thinkingLevel?: string
  busy: boolean
  managedAttachmentTransport?: 'local-path-v1'
}

export type ClientFrame =
  | TuiHello
  | { type: 'event'; connectionId: string; sequence: number; event: Record<string, unknown> }
  | { type: 'snapshot_start'; connectionId: string; snapshotId: string; full: boolean; baseCursor?: string; cursor?: string; leafId?: string; metadata: TuiSnapshotMetadata }
  | { type: 'snapshot_batch'; connectionId: string; snapshotId: string; index: number; messages: unknown[] }
  | { type: 'snapshot_end'; connectionId: string; snapshotId: string; cursor?: string; leafId?: string; batchCount: number }
  | { type: 'gap'; connectionId: string; reason: string }
  | { type: 'pong'; connectionId: string; nonce: string }
  | { type: 'send_result'; connectionId: string; requestId: string; accepted: boolean; error?: string }
  | { type: 'operation_result'; connectionId: string; requestId: string; accepted: boolean; error?: string; result?: unknown }
  | { type: 'error'; connectionId?: string; code: string; message: string }

export type ServerFrame =
  | { type: 'hello_ack'; protocol: number; guiInstanceId: string; heartbeatMs: number; lastEntryId?: string }
  | { type: 'ping'; nonce: string }
  | { type: 'resync'; since?: string }
  | { type: 'send_message'; requestId: string; message: string; delivery: DeliveryMode; attachments?: ManagedAttachment[]; queuedMessageId?: string }
  | { type: 'execute_operation'; requestId: string; operation: TuiOperation }
  | { type: 'disconnect'; reason?: string }

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}
function string(value: unknown, label: string, max = GUI_CONTROL_MAX_MESSAGE_BYTES): string {
  if (typeof value !== 'string' || !value || value.length > max) throw new Error(`${label} must be a non-empty bounded string`)
  return value
}
function optionalString(value: unknown, label: string): string | undefined {
  return value == null ? undefined : string(value, label)
}
function boundedPossiblyEmptyString(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || value.length > max) throw new Error(`${label} must be a bounded string`)
  return value
}
function number(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`)
  return value
}
function optionalNumber(value: unknown, label: string): number | undefined {
  return value == null ? undefined : number(value, label)
}
function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`)
  return value
}
function nullableNumber(value: unknown, label: string): number | null {
  return value === null ? null : number(value, label)
}

function parseSnapshotUsage(value: unknown): TuiSnapshotUsage {
  const input = object(value, 'snapshot metadata usage')
  return {
    inputTokens: number(input.inputTokens, 'usage.inputTokens'),
    outputTokens: number(input.outputTokens, 'usage.outputTokens'),
    cacheReadTokens: number(input.cacheReadTokens, 'usage.cacheReadTokens'),
    cacheWriteTokens: number(input.cacheWriteTokens, 'usage.cacheWriteTokens'),
    cost: number(input.cost, 'usage.cost'),
    usingSubscription: boolean(input.usingSubscription, 'usage.usingSubscription'),
    contextTokens: nullableNumber(input.contextTokens, 'usage.contextTokens'),
    contextWindow: number(input.contextWindow, 'usage.contextWindow'),
    contextPercent: nullableNumber(input.contextPercent, 'usage.contextPercent'),
    autoCompact: boolean(input.autoCompact, 'usage.autoCompact')
  }
}

function parseSnapshotMetadata(value: unknown): TuiSnapshotMetadata {
  const input = object(value, 'snapshot metadata')
  const capabilityInput = object(input.capabilities, 'snapshot metadata capabilities')
  if (!Array.isArray(capabilityInput.operations) || capabilityInput.operations.length > 32) throw new Error('capabilities.operations must be a bounded array')
  const operations = capabilityInput.operations.map((value) => string(value, 'capabilities operation', 64))
  const validOperations: TuiOperation['type'][] = ['compact', 'rename', 'set_model', 'set_thinking', 'reload', 'abort', 'get_tree', 'navigate_tree', 'resolve_fork', 'shutdown']
  if (operations.some((value) => !validOperations.includes(value as TuiOperation['type']))) throw new Error('capabilities.operations contains an unknown operation')
  if (!Array.isArray(capabilityInput.models) || capabilityInput.models.length > 2_000) throw new Error('capabilities.models must be a bounded array')
  const models = capabilityInput.models.map((value) => {
    const model = object(value, 'capabilities model')
    return {
      provider: string(model.provider, 'capabilities model provider', 256),
      id: string(model.id, 'capabilities model id', 512),
      name: optionalString(model.name, 'capabilities model name'),
      contextWindow: number(model.contextWindow, 'capabilities model contextWindow')
    }
  })
  const modelValue = input.model
  let model: TuiSnapshotMetadata['model']
  if (modelValue === null || modelValue === undefined) model = modelValue as null | undefined
  else {
    const modelInput = object(modelValue, 'snapshot metadata model')
    model = {
      provider: string(modelInput.provider, 'snapshot metadata model provider', 256),
      id: string(modelInput.id, 'snapshot metadata model id', 512),
      name: optionalString(modelInput.name, 'snapshot metadata model name')
    }
  }
  return {
    sessionId: string(input.sessionId, 'snapshot metadata sessionId', 512),
    cwd: string(input.cwd, 'snapshot metadata cwd', 4096),
    sessionFile: optionalString(input.sessionFile, 'snapshot metadata sessionFile'),
    sessionName: optionalString(input.sessionName, 'snapshot metadata sessionName'),
    updatedAt: string(input.updatedAt, 'snapshot metadata updatedAt', 128),
    busy: boolean(input.busy, 'snapshot metadata busy'),
    model,
    thinkingLevel: optionalString(input.thinkingLevel, 'snapshot metadata thinkingLevel'),
    usage: parseSnapshotUsage(input.usage),
    capabilities: { operations: operations as TuiOperation['type'][], models }
  }
}

function parseTuiOperation(value: unknown): TuiOperation {
  const input = object(value, 'operation')
  const type = string(input.type, 'operation.type', 64)
  if (type === 'compact') return { type, customInstructions: optionalString(input.customInstructions, 'operation.customInstructions') }
  if (type === 'rename') return { type, title: string(input.title, 'operation.title', 1024) }
  if (type === 'set_model') return { type, provider: string(input.provider, 'operation.provider', 256), modelId: string(input.modelId, 'operation.modelId', 512) }
  if (type === 'set_thinking') return { type, level: string(input.level, 'operation.level', 64) }
  if (type === 'reload') return { type }
  if (type === 'abort') return { type }
  if (type === 'get_tree') return { type }
  if (type === 'navigate_tree') return {
    type,
    targetId: string(input.targetId, 'operation.targetId', 512),
    ...(input.summarize === undefined ? {} : { summarize: boolean(input.summarize, 'operation.summarize') }),
    ...(input.customInstructions === undefined ? {} : { customInstructions: string(input.customInstructions, 'operation.customInstructions') }),
  }
  if (type === 'resolve_fork') {
    const renderedMessageIndex = number(input.renderedMessageIndex, 'operation.renderedMessageIndex')
    if (!Number.isInteger(renderedMessageIndex) || renderedMessageIndex < 0) throw new Error('operation.renderedMessageIndex must be a non-negative integer')
    return {
      type,
      renderedMessageIndex,
      ...(input.renderedMessageText === undefined ? {} : { renderedMessageText: string(input.renderedMessageText, 'operation.renderedMessageText') }),
    }
  }
  if (type === 'shutdown') return { type }
  throw new Error(`Unknown TUI operation: ${type}`)
}

export function parseEndpointManifest(value: unknown): EndpointManifest {
  const input = object(value, 'endpoint manifest')
  if (input.application !== 'mypi-gui-control') throw new Error('Invalid endpoint application')
  return {
    application: 'mypi-gui-control',
    protocol: number(input.protocol, 'protocol'),
    guiInstanceId: string(input.guiInstanceId, 'guiInstanceId', 256),
    pid: number(input.pid, 'pid'),
    socketPath: string(input.socketPath, 'socketPath', 4096),
    token: string(input.token, 'token', 1024),
    createdAt: string(input.createdAt, 'createdAt', 128)
  }
}

export function parseClientFrame(value: unknown): ClientFrame {
  const input = object(value, 'client frame')
  const type = string(input.type, 'type', 64)
  if (type === 'hello') {
    const modelValue = input.model
    let model: TuiHello['model']
    if (modelValue === null || modelValue === undefined) model = modelValue as null | undefined
    else {
      const modelInput = object(modelValue, 'model')
      model = { provider: string(modelInput.provider, 'model.provider', 256), id: string(modelInput.id, 'model.id', 512), name: optionalString(modelInput.name, 'model.name') }
    }
    if (input.mode !== 'tui') throw new Error('Only TUI clients are accepted')
    const rawManagedAttachmentTransport = input.managedAttachmentTransport
    if (rawManagedAttachmentTransport !== undefined && rawManagedAttachmentTransport !== 'local-path-v1') throw new Error('Unknown managed attachment transport')
    const managedAttachmentTransport: TuiHello['managedAttachmentTransport'] = rawManagedAttachmentTransport === 'local-path-v1'
      ? 'local-path-v1'
      : undefined
    return { type, protocol: number(input.protocol, 'protocol'), token: string(input.token, 'token', 1024), connectionId: string(input.connectionId, 'connectionId', 256), mode: 'tui', pid: number(input.pid, 'pid'), processStartTime: optionalNumber(input.processStartTime, 'processStartTime'), cwd: string(input.cwd, 'cwd', 4096), sessionId: string(input.sessionId, 'sessionId', 512), sessionFile: optionalString(input.sessionFile, 'sessionFile'), sessionName: optionalString(input.sessionName, 'sessionName'), leafId: optionalString(input.leafId, 'leafId'), model, thinkingLevel: optionalString(input.thinkingLevel, 'thinkingLevel'), busy: boolean(input.busy, 'busy'), ...(managedAttachmentTransport ? { managedAttachmentTransport } : {}) }
  }
  const connectionId = string(input.connectionId, 'connectionId', 256)
  if (type === 'event') return { type, connectionId, sequence: number(input.sequence, 'sequence'), event: object(input.event, 'event') }
  if (type === 'snapshot_start') return {
    type,
    connectionId,
    snapshotId: string(input.snapshotId, 'snapshotId', 256),
    full: boolean(input.full, 'full'),
    baseCursor: optionalString(input.baseCursor, 'baseCursor'),
    cursor: optionalString(input.cursor, 'cursor'),
    leafId: optionalString(input.leafId, 'leafId'),
    metadata: parseSnapshotMetadata(input.metadata)
  }
  if (type === 'snapshot_batch') {
    if (!Array.isArray(input.messages) || input.messages.length > GUI_CONTROL_MAX_SNAPSHOT_BATCH) throw new Error('messages must be a bounded array')
    return { type, connectionId, snapshotId: string(input.snapshotId, 'snapshotId', 256), index: number(input.index, 'index'), messages: input.messages }
  }
  if (type === 'snapshot_end') return {
    type,
    connectionId,
    snapshotId: string(input.snapshotId, 'snapshotId', 256),
    cursor: optionalString(input.cursor, 'cursor'),
    leafId: optionalString(input.leafId, 'leafId'),
    batchCount: number(input.batchCount, 'batchCount')
  }
  if (type === 'gap') return { type, connectionId, reason: string(input.reason, 'reason', 2048) }
  if (type === 'pong') return { type, connectionId, nonce: string(input.nonce, 'nonce', 256) }
  if (type === 'send_result') return { type, connectionId, requestId: string(input.requestId, 'requestId', 256), accepted: boolean(input.accepted, 'accepted'), error: optionalString(input.error, 'error') }
  if (type === 'operation_result') return { type, connectionId, requestId: string(input.requestId, 'requestId', 256), accepted: boolean(input.accepted, 'accepted'), error: optionalString(input.error, 'error'), ...(input.result === undefined ? {} : { result: input.result }) }
  if (type === 'error') return { type, connectionId: optionalString(input.connectionId, 'connectionId'), code: string(input.code, 'code', 128), message: string(input.message, 'message', 4096) }
  throw new Error(`Unknown client frame type: ${type}`)
}

export function parseServerFrame(value: unknown): ServerFrame {
  const input = object(value, 'server frame')
  const type = string(input.type, 'type', 64)
  if (type === 'hello_ack') return { type, protocol: number(input.protocol, 'protocol'), guiInstanceId: string(input.guiInstanceId, 'guiInstanceId', 256), heartbeatMs: number(input.heartbeatMs, 'heartbeatMs'), lastEntryId: optionalString(input.lastEntryId, 'lastEntryId') }
  if (type === 'ping') return { type, nonce: string(input.nonce, 'nonce', 256) }
  if (type === 'resync') return { type, since: optionalString(input.since, 'since') }
  if (type === 'send_message') {
    const delivery = input.delivery
    if (delivery !== 'auto' && delivery !== 'steer' && delivery !== 'followUp') throw new Error('Invalid delivery mode')
    const rawAttachments = input.attachments
    if (rawAttachments !== undefined && (!Array.isArray(rawAttachments) || rawAttachments.length > GUI_CONTROL_MAX_ATTACHMENTS)) throw new Error('attachments must be a bounded array')
    const attachments: ManagedAttachment[] = (Array.isArray(rawAttachments) ? rawAttachments : []).map((value): ManagedAttachment => {
      const attachment = object(value, 'attachment')
      if (attachment.kind !== 'image' && attachment.kind !== 'file') throw new Error('attachment.kind is invalid')
      const kind = attachment.kind as ManagedAttachment['kind']
      const sizeBytes = number(attachment.sizeBytes, 'attachment.sizeBytes')
      if (!Number.isInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > GUI_CONTROL_MAX_ATTACHMENT_BYTES) throw new Error('attachment.sizeBytes is invalid')
      return {
        kind,
        name: string(attachment.name, 'attachment.name', 256),
        mimeType: string(attachment.mimeType, 'attachment.mimeType', 128),
        fsPath: string(attachment.fsPath, 'attachment.fsPath', 4096),
        sizeBytes
      }
    })
    const message = boundedPossiblyEmptyString(input.message, 'message', GUI_CONTROL_MAX_MESSAGE_BYTES)
    if (!message.trim() && attachments.length === 0) throw new Error('message and attachments cannot both be empty')
    return {
      type,
      requestId: string(input.requestId, 'requestId', 256),
      message,
      delivery,
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(input.queuedMessageId == null
        ? {}
        : { queuedMessageId: string(input.queuedMessageId, 'queuedMessageId', 256) }),
    }
  }
  if (type === 'execute_operation') return { type, requestId: string(input.requestId, 'requestId', 256), operation: parseTuiOperation(input.operation) }
  if (type === 'disconnect') return { type, reason: optionalString(input.reason, 'reason') }
  throw new Error(`Unknown server frame type: ${type}`)
}
