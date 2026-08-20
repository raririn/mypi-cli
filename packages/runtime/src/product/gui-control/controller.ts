import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { MYPI_CONTROL_PROTOCOL, parseEndpointManifest, type ClientFrame, type ServerFrame, type TuiHello } from './protocol.ts'
import { SocketTransport } from './transport.ts'

export type ControllerState = 'disabled' | 'discovering' | 'connecting' | 'handshaking' | 'connected' | 'backoff' | 'closing'
export interface ControllerCallbacks {
  createHello(): Omit<TuiHello, 'type' | 'protocol' | 'token'>
  onState(state: ControllerState, detail?: string): void
  onConnected(lastEntryId?: string): void
  onResync(since?: string): void
  onSendMessage(frame: Extract<ServerFrame, { type: 'send_message' }>): void
  onExecuteOperation(frame: Extract<ServerFrame, { type: 'execute_operation' }>): void
}
export interface ControllerOptions {
  agentDir: string
  callbacks: ControllerCallbacks
  transportFactory?: (callbacks: ConstructorParameters<typeof SocketTransport>[0]) => SocketTransport
  random?: () => number
  heartbeatTimeoutMs?: number
}

export class GuiControlController {
  private readonly options: ControllerOptions
  private state: ControllerState = 'disabled'
  private detail: string | undefined
  private desired = false
  private generation = 0
  private attempt = 0
  private retryTimer: NodeJS.Timeout | undefined
  private handshakeTimer: NodeJS.Timeout | undefined
  private heartbeatTimer: NodeJS.Timeout | undefined
  private negotiatedHeartbeatTimeoutMs: number | undefined
  private transport: SocketTransport | undefined

  constructor(options: ControllerOptions) { this.options = options }
  getState(): ControllerState { return this.state }
  getDetail(): string | undefined { return this.detail }
  isEnabled(): boolean { return this.desired }

  enable(): void {
    if (this.desired) return
    this.desired = true; this.attempt = 0; this.generation++
    void this.discoverAndConnect(this.generation)
  }

  disable(): void {
    this.desired = false; this.generation++
    this.setState('closing')
    if (this.retryTimer) clearTimeout(this.retryTimer)
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer)
    this.retryTimer = undefined; this.handshakeTimer = undefined; this.heartbeatTimer = undefined
    this.negotiatedHeartbeatTimeoutMs = undefined
    this.transport?.close(); this.transport = undefined
    this.setState('disabled')
  }

  send(frame: ClientFrame): boolean {
    if (this.state !== 'connected' && frame.type !== 'hello') return false
    return this.transport?.send(frame) ?? false
  }

  private async discoverAndConnect(generation: number): Promise<void> {
    if (!this.current(generation)) return
    this.setState('discovering')
    let transport: SocketTransport | undefined
    try {
      const endpointPath = join(resolve(this.options.agentDir), 'gui-control', 'endpoint.json')
      if (!existsSync(endpointPath)) throw new Error('GUI endpoint is not available')
      const stat = lstatSync(endpointPath)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('GUI endpoint manifest is unsafe')
      const endpoint = parseEndpointManifest(JSON.parse(readFileSync(endpointPath, 'utf8')))
      if (endpoint.protocol !== MYPI_CONTROL_PROTOCOL) throw new Error(`MyPi control protocol ${endpoint.protocol} is incompatible`)
      if (!this.current(generation)) return
      this.setState('connecting')
      const transportFactory = this.options.transportFactory ?? ((callbacks) => new SocketTransport(callbacks))
      transport = transportFactory({
        onFrame: (frame) => this.handleFrame(generation, transport!, frame),
        onClose: (reason) => this.handleClose(generation, transport!, reason),
      })
      this.transport = transport
      await transport.connect(endpoint.socketPath)
      if (!this.current(generation) || this.transport !== transport) { transport.close(); return }
      this.setState('handshaking')
      const hello = this.options.callbacks.createHello()
      if (!transport.send({ type: 'hello', protocol: MYPI_CONTROL_PROTOCOL, token: endpoint.token, ...hello })) throw new Error('Failed to write MyPi control hello')
      this.handshakeTimer = setTimeout(() => {
        if (this.current(generation) && this.state === 'handshaking') {
          this.failTransport(generation, transport!, 'GUI-control handshake timed out')
        }
      }, 5000)
      this.handshakeTimer.unref()
    } catch (error) {
      if (transport && this.transport === transport) {
        this.transport = undefined
        transport.close()
      }
      if (this.current(generation)) this.scheduleRetry(generation, error instanceof Error ? error.message : String(error))
    }
  }

  private handleFrame(generation: number, transport: SocketTransport, frame: ServerFrame): void {
    if (!this.current(generation) || this.transport !== transport) return
    if (frame.type === 'hello_ack') {
      if (frame.protocol !== MYPI_CONTROL_PROTOCOL) {
        this.failTransport(generation, transport, 'MyPi control protocol changed during handshake')
        return
      }
      if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
      this.handshakeTimer = undefined
      this.negotiatedHeartbeatTimeoutMs = this.options.heartbeatTimeoutMs ?? Math.max(5000, frame.heartbeatMs * 3 + 1000)
      this.armHeartbeatWatchdog(generation, transport)
      this.attempt = 0; this.setState('connected')
      this.options.callbacks.onConnected(frame.lastEntryId)
      return
    }
    if (this.state !== 'connected') return
    this.armHeartbeatWatchdog(generation, transport)
    if (frame.type === 'ping') {
      const hello = this.options.callbacks.createHello()
      this.send({ type: 'pong', connectionId: hello.connectionId, nonce: frame.nonce })
    } else if (frame.type === 'resync') this.options.callbacks.onResync(frame.since)
    else if (frame.type === 'send_message') this.options.callbacks.onSendMessage(frame)
    else if (frame.type === 'execute_operation') this.options.callbacks.onExecuteOperation(frame)
    else if (frame.type === 'disconnect') this.disable()
  }

  private handleClose(generation: number, transport: SocketTransport, reason: string): void {
    if (!this.current(generation) || this.transport !== transport) return
    this.transport = undefined
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer)
    this.handshakeTimer = undefined
    this.heartbeatTimer = undefined
    this.negotiatedHeartbeatTimeoutMs = undefined
    if (this.desired) this.scheduleRetry(generation, reason)
    else this.setState('disabled')
  }

  private armHeartbeatWatchdog(generation: number, transport: SocketTransport): void {
    const timeoutMs = this.negotiatedHeartbeatTimeoutMs
    if (!timeoutMs) return
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer)
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = undefined
      this.failTransport(generation, transport, 'GUI heartbeat stopped')
    }, timeoutMs)
    this.heartbeatTimer.unref()
  }

  private failTransport(generation: number, transport: SocketTransport, reason: string): void {
    if (!this.current(generation) || this.transport !== transport) return
    this.transport = undefined
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer)
    this.handshakeTimer = undefined
    this.heartbeatTimer = undefined
    this.negotiatedHeartbeatTimeoutMs = undefined
    transport.close()
    this.scheduleRetry(generation, reason)
  }

  private scheduleRetry(generation: number, detail: string): void {
    if (!this.current(generation) || this.retryTimer) return
    this.setState('backoff', detail)
    const base = Math.min(10000, 500 * 2 ** Math.min(this.attempt++, 5))
    const random = this.options.random ?? Math.random
    const delay = Math.round(base * (0.8 + random() * 0.4))
    this.retryTimer = setTimeout(() => { this.retryTimer = undefined; if (this.current(generation)) void this.discoverAndConnect(generation) }, delay)
    this.retryTimer.unref()
  }

  private current(generation: number): boolean { return this.desired && generation === this.generation }
  private setState(state: ControllerState, detail?: string): void { this.state = state; this.detail = detail; this.options.callbacks.onState(state, detail) }
}
