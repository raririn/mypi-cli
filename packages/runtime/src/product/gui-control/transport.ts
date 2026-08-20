import { connect, type Socket } from 'node:net'
import { StringDecoder } from 'node:string_decoder'
import { GUI_CONTROL_MAX_BUFFER_BYTES, GUI_CONTROL_MAX_FRAME_BYTES, parseServerFrame, type ClientFrame, type ServerFrame } from './protocol.ts'

export class BoundedEventQueue {
  private frames: ClientFrame[] = []
  private bytes = 0
  private dirty = false
  private readonly maxRecords: number
  private readonly maxBytes: number
  constructor(maxRecords = 256, maxBytes = GUI_CONTROL_MAX_BUFFER_BYTES) {
    this.maxRecords = maxRecords
    this.maxBytes = maxBytes
  }

  enqueue(frame: ClientFrame): void {
    const encodedBytes = Buffer.byteLength(JSON.stringify(frame))
    const key = this.coalesceKey(frame)
    if (key) {
      const index = this.frames.findIndex((candidate) => this.coalesceKey(candidate) === key)
      if (index >= 0) { this.bytes -= Buffer.byteLength(JSON.stringify(this.frames[index])); this.frames[index] = frame; this.bytes += encodedBytes; return }
    }
    this.frames.push(frame); this.bytes += encodedBytes
    while (this.frames.length > this.maxRecords || this.bytes > this.maxBytes) {
      const dropIndex = this.frames.findIndex((candidate) => this.coalesceKey(candidate) !== undefined)
      const index = dropIndex >= 0 ? dropIndex : 0
      const [dropped] = this.frames.splice(index, 1); this.bytes -= Buffer.byteLength(JSON.stringify(dropped)); this.dirty = true
    }
  }

  drain(send: (frame: ClientFrame) => boolean): void {
    while (this.frames.length) {
      const frame = this.frames[0]
      if (!send(frame)) return
      this.frames.shift(); this.bytes -= Buffer.byteLength(JSON.stringify(frame))
    }
  }
  isDirty(): boolean { return this.dirty }
  clearDirty(): void { this.dirty = false }
  clear(): void { this.frames = []; this.bytes = 0; this.dirty = false }
  size(): number { return this.frames.length }

  private coalesceKey(frame: ClientFrame): string | undefined {
    if (frame.type !== 'event') return undefined
    const type = frame.event.type
    const message = frame.event.message as Record<string, unknown> | undefined
    if (type === 'message_update') return `message:${String(message?.id ?? '')}:${String((frame.event.assistantMessageEvent as Record<string, unknown> | undefined)?.type ?? '')}`
    if (type === 'tool_execution_update') return `tool:${String(frame.event.toolCallId ?? '')}`
    return undefined
  }
}

export interface SocketTransportCallbacks {
  onFrame(frame: ServerFrame): void
  onClose(reason: string): void
}

export class SocketTransport {
  private readonly callbacks: SocketTransportCallbacks
  private socket: Socket | undefined
  private decoder = new StringDecoder('utf8')
  private buffer = ''
  private closed = false

  constructor(callbacks: SocketTransportCallbacks) { this.callbacks = callbacks }

  connect(path: string, timeoutMs = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = connect(path)
      this.socket = socket
      let settled = false
      const timer = setTimeout(() => socket.destroy(new Error('Socket connect timed out')), timeoutMs); timer.unref()
      socket.setNoDelay(true)
      socket.once('connect', () => { if (settled) return; settled = true; clearTimeout(timer); resolve() })
      socket.on('data', (chunk) => this.push(chunk))
      socket.on('end', () => { this.buffer += this.decoder.end(); if (this.buffer) socket.destroy(new Error('Unterminated JSONL record at EOF')) })
      socket.on('error', (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error) } })
      socket.on('close', () => { clearTimeout(timer); this.finish('Socket closed') })
    })
  }

  send(frame: ClientFrame): boolean {
    const socket = this.socket
    if (!socket?.writable || this.closed) return false
    let line: string
    try { line = `${JSON.stringify(frame)}\n` } catch { return false }
    const bytes = Buffer.byteLength(line)
    if (bytes > GUI_CONTROL_MAX_FRAME_BYTES || socket.writableLength + bytes > GUI_CONTROL_MAX_BUFFER_BYTES) return false
    socket.write(line)
    return true
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.socket?.destroy()
  }

  private push(chunk: Buffer): void {
    if (this.closed) return
    try {
      this.buffer += this.decoder.write(chunk)
      if (Buffer.byteLength(this.buffer) > GUI_CONTROL_MAX_BUFFER_BYTES) throw new Error('Socket JSONL buffer limit exceeded')
      while (true) {
        const newline = this.buffer.indexOf('\n')
        if (newline < 0) {
          if (Buffer.byteLength(this.buffer) > GUI_CONTROL_MAX_FRAME_BYTES) throw new Error('Socket JSONL record limit exceeded')
          break
        }
        let line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        if (!line) continue
        if (Buffer.byteLength(line) > GUI_CONTROL_MAX_FRAME_BYTES) throw new Error('Socket JSONL record limit exceeded')
        this.callbacks.onFrame(parseServerFrame(JSON.parse(line)))
      }
    } catch (error) {
      this.socket?.destroy(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private finish(reason: string): void {
    if (this.closed) return
    this.closed = true
    this.callbacks.onClose(reason)
  }
}
