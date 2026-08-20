import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'
import test from 'node:test'
import { readLiveForeignLease, sessionWriterLockPath, startSessionOwnership } from '../../../src/product/gui-control/ownership.ts'

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true } catch { return false }
}

async function requestHandoff(
  control: { socketPath: string; token: string },
  sessionFile: string,
  ownerId: string,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(control.socketPath)
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(`${JSON.stringify({
      type: 'handoff_request',
      protocol: 1,
      token: control.token,
      ownerId,
      sessionFile,
      requesterPid: 2468,
      force: false,
      ...overrides,
    })}\n`))
    socket.on('data', (chunk) => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      socket.destroy()
      resolve(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>)
    })
    socket.on('error', reject)
  })
}

test('TUI ownership uses an exclusive atomic lock and owner-token cleanup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-tui-ownership-'))
  try {
    const sessionFile = join(dir, 'session.jsonl')
    await writeFile(sessionFile, '{}\n')
    const first = startSessionOwnership(sessionFile)
    assert.equal(await exists(sessionWriterLockPath(sessionFile)), true)
    assert.equal(readLiveForeignLease(sessionFile), undefined, 'our own lock is not foreign')

    const diagnostic = JSON.parse(await readFile(`${sessionFile}.lease`, 'utf8'))
    assert.equal(diagnostic.ownerId, first.info.ownerId)
    const reloaded = startSessionOwnership(sessionFile, { reuseExisting: true })
    assert.equal(reloaded.info.ownerId, first.info.ownerId)
    assert.throws(() => startSessionOwnership(sessionFile), (error: unknown) => (
      Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ELOCKED')
    ))

    first.stop()
    first.stop()
    assert.equal(await exists(sessionWriterLockPath(sessionFile)), false)
    assert.equal(await exists(`${sessionFile}.lease`), false)

    const second = startSessionOwnership(sessionFile)
    assert.notEqual(second.info.ownerId, first.info.ownerId)
    second.stop()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ownership publishes an authenticated cooperative handoff endpoint', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mypi-ownership-control-'))
  try {
    const sessionFile = join(dir, 'session.jsonl')
    await writeFile(sessionFile, '{}\n')
    const requests: Array<{ requesterPid: number; force: boolean }> = []
    const handle = startSessionOwnership(sessionFile, {
      agentDir: dir,
      onHandoffRequest: async (request) => {
        requests.push(request)
        if (request.requesterPid === 2469) return { status: 'declined', message: 'not now' }
        return request.force ? { status: 'accepted' } : { status: 'busy', message: 'active turn' }
      },
    })
    const control = handle.info.control
    assert.ok(control)
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 3_000
      const poll = async () => {
        if (await exists(control.socketPath)) return resolve()
        if (Date.now() > deadline) return reject(new Error('handoff socket was not created'))
        setTimeout(poll, 10)
      }
      void poll()
    })

    const lease = JSON.parse(await readFile(`${sessionFile}.lease`, 'utf8'))
    assert.equal(lease.version, 2)
    assert.equal(lease.processStartTime, handle.info.processStartTime)
    assert.deepEqual(lease.control, control)

    const busy = await requestHandoff(control, sessionFile, handle.info.ownerId!, {})
    assert.equal(busy.status, 'busy')
    assert.equal(busy.message, 'active turn')
    const declined = await requestHandoff(control, sessionFile, handle.info.ownerId!, { requesterPid: 2469 })
    assert.equal(declined.status, 'declined')
    assert.equal(declined.message, 'not now')
    const forced = await requestHandoff(control, sessionFile, handle.info.ownerId!, { force: true })
    assert.equal(forced.status, 'accepted')
    assert.deepEqual(requests, [
      { requesterPid: 2468, force: false },
      { requesterPid: 2469, force: false },
      { requesterPid: 2468, force: true },
    ])

    const rejected = await requestHandoff(control, sessionFile, handle.info.ownerId!, { token: 'wrong' })
    assert.equal(rejected.status, 'error')
    assert.equal(requests.length, 3, 'an unauthenticated request did not reach the owner callback')

    handle.stop()
    assert.equal(await exists(control.socketPath), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('TUI ownership fails closed for malformed legacy metadata', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-tui-legacy-lock-'))
  try {
    const sessionFile = join(dir, 'session.jsonl')
    await writeFile(sessionFile, '{}\n')
    await writeFile(`${sessionFile}.lease`, '{ not json')
    assert.equal(readLiveForeignLease(sessionFile)?.surface, 'unknown')
    assert.throws(() => startSessionOwnership(sessionFile), /malformed/)
    assert.equal(await exists(sessionWriterLockPath(sessionFile)), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a stale foreign lease is reclaimed instead of blocking the session forever', async () => {
  await withSessionFile(async (sessionFile) => {
    // A writer that died without cleanup (container restart: the hostname no
    // longer matches and nothing refreshes the lock).
    writeFileSync(`${sessionFile}.lease`, `${JSON.stringify({
      pid: 999_999,
      hostname: 'a-dead-container',
      startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      surface: 'mypi-gui-rpc',
      ownerId: 'stale-owner',
    }, null, 2)}\n`)

    const handle = startSessionOwnership(sessionFile, { surface: 'mypi-gui-rpc' })
    try {
      const lease = JSON.parse(readFileSync(`${sessionFile}.lease`, 'utf8'))
      assert.equal(lease.pid, process.pid, 'the live writer owns the lease')
      assert.equal(lease.hostname, hostname())
    } finally {
      handle.stop()
    }
  })
})

test('a same-host lease whose pid is alive is still refused', async () => {
  await withSessionFile(async (sessionFile) => {
    writeFileSync(`${sessionFile}.lease`, `${JSON.stringify({
      // pid 1 is always alive and is never this process, so the lease looks
      // like a live same-host legacy writer that only wrote a lease file.
      pid: 1,
      hostname: hostname(),
      startedAt: new Date().toISOString(),
      surface: 'pi-cli',
      ownerId: 'live-legacy-writer',
    }, null, 2)}\n`)

    assert.throws(
      () => startSessionOwnership(sessionFile, { surface: 'mypi-gui-rpc' }),
      /is owned by pi-cli/,
      'a live same-host legacy writer keeps its session',
    )
  })
})

async function withSessionFile(run: (sessionFile: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-tui-ownership-stale-'))
  try {
    const sessionFile = join(dir, 'session.jsonl')
    await writeFile(sessionFile, '{}\n')
    await run(sessionFile)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('a stale foreign lease without a live lock is not reported as a live owner', async () => {
  await withSessionFile(async (sessionFile) => {
    // Exactly the shape left behind when a container is replaced: the lease
    // names a host that no longer exists and nothing refreshes the lock.
    writeFileSync(`${sessionFile}.lease`, `${JSON.stringify({
      pid: 415,
      hostname: 'a-replaced-container',
      startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      surface: 'pi-cli',
      ownerId: 'stale-owner',
    }, null, 2)}\n`)

    assert.equal(readLiveForeignLease(sessionFile), undefined,
      'a session must not stay locked out by a dead writer\'s lease')
  })
})
