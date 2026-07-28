import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'esbuild'
import type { ControllerCallbacks } from './controller.ts'
import { GUI_CONTROL_PROTOCOL, type ClientFrame, type ServerFrame } from './protocol.ts'
import type { SocketTransport, SocketTransportCallbacks } from './transport.ts'

const controllerBuild = await build({
  entryPoints: [join(import.meta.dirname, 'controller.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
})
const controllerUrl = `data:text/javascript;base64,${Buffer.from(controllerBuild.outputFiles[0]!.text).toString('base64')}`
const { GuiControlController } = await import(controllerUrl) as typeof import('./controller.ts')

class FakeTransport {
  closed = false
  private readonly callbacks: SocketTransportCallbacks
  private readonly acknowledge: boolean
  constructor(
    callbacks: SocketTransportCallbacks,
    acknowledge: boolean,
  ) {
    this.callbacks = callbacks
    this.acknowledge = acknowledge
  }

  async connect(): Promise<void> {}

  send(frame: ClientFrame): boolean {
    if (this.closed) return false
    if (this.acknowledge && frame.type === 'hello') {
      queueMicrotask(() => this.push({
        type: 'hello_ack',
        protocol: GUI_CONTROL_PROTOCOL,
        guiInstanceId: 'test-gui',
        heartbeatMs: 15_000,
      }))
    }
    return true
  }

  close(): void { this.closed = true }
  push(frame: ServerFrame): void { this.callbacks.onFrame(frame) }
  remoteClose(reason = 'Socket closed'): void { this.closed = true; this.callbacks.onClose(reason) }
}

function callbacks(): ControllerCallbacks {
  return {
    createHello: () => ({
      connectionId: 'test-connection',
      mode: 'tui',
      pid: process.pid,
      processStartTime: Date.now(),
      cwd: process.cwd(),
      sessionId: 'test-session',
      busy: false,
      model: null,
    }),
    onState: () => {},
    onConnected: () => {},
    onResync: () => {},
    onSendMessage: () => {},
    onExecuteOperation: () => {},
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for controller state')
    await delay(10)
  }
}

test('reconnects when a previously acknowledged GUI socket stops heartbeating', async () => {
  const agentDir = await mkdtemp(join(tmpdir(), 'mypi-gui-control-watchdog-'))
  const transports: FakeTransport[] = []
  try {
    await mkdir(join(agentDir, 'gui-control'))
    await writeFile(join(agentDir, 'gui-control', 'endpoint.json'), `${JSON.stringify({
      application: 'mypi-gui-control',
      protocol: GUI_CONTROL_PROTOCOL,
      guiInstanceId: 'test-gui',
      pid: process.pid,
      socketPath: join(agentDir, 'gui-control.sock'),
      token: 'test-token',
      createdAt: new Date().toISOString(),
    })}\n`)
    const controller = new GuiControlController({
      agentDir,
      callbacks: callbacks(),
      heartbeatTimeoutMs: 20,
      random: () => 0,
      transportFactory: (transportCallbacks) => {
        const transport = new FakeTransport(transportCallbacks, true)
        transports.push(transport)
        return transport as unknown as SocketTransport
      },
    })

    controller.enable()
    await delay(10)
    assert.equal(controller.getState(), 'connected')
    await waitFor(() => transports.length >= 2)
    assert.equal(transports[0]?.closed, true)
    controller.disable()
  } finally {
    await rm(agentDir, { recursive: true, force: true })
  }
})

test('ignores a late close from a retired transport after replacement', async () => {
  const agentDir = await mkdtemp(join(tmpdir(), 'mypi-gui-control-generation-'))
  const transports: FakeTransport[] = []
  try {
    await mkdir(join(agentDir, 'gui-control'))
    await writeFile(join(agentDir, 'gui-control', 'endpoint.json'), `${JSON.stringify({
      application: 'mypi-gui-control',
      protocol: GUI_CONTROL_PROTOCOL,
      guiInstanceId: 'test-gui',
      pid: process.pid,
      socketPath: join(agentDir, 'gui-control.sock'),
      token: 'test-token',
      createdAt: new Date().toISOString(),
    })}\n`)
    const controller = new GuiControlController({
      agentDir,
      callbacks: callbacks(),
      heartbeatTimeoutMs: 100,
      random: () => 0,
      transportFactory: (transportCallbacks) => {
        const transport = new FakeTransport(transportCallbacks, true)
        transports.push(transport)
        return transport as unknown as SocketTransport
      },
    })

    controller.enable()
    await waitFor(() => transports.length >= 2)
    await delay(5)
    const replacement = transports.at(-1)
    assert.ok(replacement && replacement !== transports[0])
    assert.equal(controller.getState(), 'connected')
    transports[0]?.remoteClose('late close from retired socket')
    await delay(5)
    assert.equal(controller.getState(), 'connected')
    controller.disable()
  } finally {
    await rm(agentDir, { recursive: true, force: true })
  }
})
