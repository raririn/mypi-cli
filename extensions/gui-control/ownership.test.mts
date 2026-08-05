import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readLiveForeignLease, sessionWriterLockPath, startSessionOwnership } from './ownership.ts'

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true } catch { return false }
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
