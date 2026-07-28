import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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
