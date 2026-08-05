import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { resolve } from 'node:path'
import lockfile from '@bybrave/proper-lockfile2'

export const TUI_LEASE_SURFACE = 'pi-cli'
export const SESSION_LOCK_STALE_MS = 30_000
export const SESSION_LOCK_UPDATE_MS = 10_000

interface LeaseInfo {
  pid: number
  hostname: string
  startedAt: string
  surface: string
  ownerId?: string
}

export interface SessionOwnershipHandle {
  readonly sessionFile: string
  readonly info: LeaseInfo
  stop(): void
}

export interface SessionOwnershipOptions {
  onCompromised?: (error: Error) => void
  /** Reuse this process's retained lock during Pi's shutdown/start reload pair. */
  reuseExisting?: boolean
  /** Human-readable writer surface persisted for cross-process diagnostics. */
  surface?: 'pi-cli' | 'mypi-gui-rpc'
}

interface InternalOwnershipHandle extends SessionOwnershipHandle {
  addCompromiseListener(listener: ((error: Error) => void) | undefined): void
}

const OWNERSHIP_REGISTRY_KEY = Symbol.for('mypi.session-writer-locks')
const ownershipRegistry = (() => {
  const root = globalThis as typeof globalThis & { [OWNERSHIP_REGISTRY_KEY]?: Map<string, InternalOwnershipHandle> }
  return root[OWNERSHIP_REGISTRY_KEY] ??= new Map<string, InternalOwnershipHandle>()
})()

export function sessionWriterLockPath(sessionFile: string): string {
  return `${sessionFile}.lock`
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true
  try { process.kill(pid, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
}

function parseLease(leasePath: string): { state: 'missing' } | { state: 'invalid' } | { state: 'valid'; info: LeaseInfo } {
  if (!existsSync(leasePath)) return { state: 'missing' }
  try {
    const value = JSON.parse(readFileSync(leasePath, 'utf8')) as Partial<LeaseInfo>
    if (
      typeof value.pid !== 'number' ||
      typeof value.hostname !== 'string' ||
      typeof value.startedAt !== 'string' ||
      typeof value.surface !== 'string' ||
      (value.ownerId !== undefined && typeof value.ownerId !== 'string')
    ) return { state: 'invalid' }
    return { state: 'valid', info: value as LeaseInfo }
  } catch {
    return { state: 'invalid' }
  }
}

function unknownHolder(): LeaseInfo {
  return { pid: 0, hostname: 'unknown', startedAt: 'unknown', surface: 'unknown' }
}

export function readLiveForeignLease(sessionFile: string): LeaseInfo | undefined {
  const leasePath = `${sessionFile}.lease`
  let locked: boolean
  try {
    locked = lockfile.checkSync(sessionFile, {
      realpath: false,
      lockfilePath: sessionWriterLockPath(sessionFile),
      stale: SESSION_LOCK_STALE_MS,
    })
  } catch {
    return unknownHolder()
  }

  const parsed = parseLease(leasePath)
  if (locked) {
    if (parsed.state !== 'valid') return unknownHolder()
    if (parsed.info.pid === process.pid && parsed.info.hostname === hostname()) return undefined
    return parsed.info
  }

  // Migration compatibility for older MyPi writers that created only .lease.
  if (parsed.state === 'missing') return undefined
  if (parsed.state === 'invalid') return unknownHolder()
  if (parsed.info.pid === process.pid && parsed.info.hostname === hostname()) return undefined
  if (parsed.info.hostname !== hostname() || pidAlive(parsed.info.pid)) return parsed.info
  return undefined
}

export function startSessionOwnership(
  sessionFile: string,
  options: SessionOwnershipOptions = {},
): SessionOwnershipHandle {
  const registryKey = resolve(sessionFile)
  const retained = ownershipRegistry.get(registryKey)
  if (retained && options.reuseExisting) {
    retained.addCompromiseListener(options.onCompromised)
    return retained
  }

  const leasePath = `${sessionFile}.lease`
  const info: LeaseInfo = {
    pid: process.pid,
    hostname: hostname(),
    startedAt: new Date().toISOString(),
    surface: options.surface ?? TUI_LEASE_SURFACE,
    ownerId: randomUUID(),
  }
  let compromised = false
  const compromiseListeners = new Set<(error: Error) => void>()
  if (options.onCompromised) compromiseListeners.add(options.onCompromised)
  const releaseLock = lockfile.lockSync(sessionFile, {
    realpath: false,
    lockfilePath: sessionWriterLockPath(sessionFile),
    stale: SESSION_LOCK_STALE_MS,
    update: SESSION_LOCK_UPDATE_MS,
    onCompromised: (error) => {
      compromised = true
      for (const listener of compromiseListeners) listener(error)
    },
  })

  try {
    const legacy = parseLease(leasePath)
    if (legacy.state === 'invalid') throw ownershipError('Legacy writer lease is malformed')
    if (legacy.state === 'valid' && !(legacy.info.pid === process.pid && legacy.info.hostname === hostname())) {
      // Reaching here means proper-lockfile just granted us the writer lock,
      // so no live writer is refreshing it (the lock mtime is the liveness
      // signal; the lease is diagnostic metadata). A leftover lease from a
      // dead writer must therefore be reclaimed, not honored — otherwise a
      // session whose writer died without cleanup (container restart, SIGKILL,
      // a host whose hostname no longer matches) stays permanently unusable.
      // The one case still refused is a *same-host, live-pid* lease, which can
      // legitimately belong to an older MyPi writer that only wrote a lease.
      if (legacy.info.hostname === hostname() && pidAlive(legacy.info.pid)) {
        throw ownershipError(`Session is owned by ${legacy.info.surface} (pid ${legacy.info.pid} on ${legacy.info.hostname})`)
      }
      if (legacy.info.hostname !== hostname()) {
        console.warn(`[mypi] Reclaiming a stale writer lease from ${legacy.info.surface} (pid ${legacy.info.pid} on ${legacy.info.hostname}); its lock was not being refreshed.`)
      }
      rmSync(leasePath, { force: true })
    }
    writeLeaseAtomic(leasePath, info)
  } catch (error) {
    releaseLock()
    throw error
  }

  let stopped = false
  const onExit = () => removeLeaseIfOwned(leasePath, info)
  process.once('exit', onExit)
  const handle: InternalOwnershipHandle = {
    sessionFile,
    info,
    addCompromiseListener(listener) {
      if (listener) compromiseListeners.add(listener)
    },
    stop() {
      if (stopped) return
      stopped = true
      ownershipRegistry.delete(registryKey)
      process.off('exit', onExit)
      try {
        releaseLock()
      } catch (error) {
        if (!compromised && (error as NodeJS.ErrnoException).code !== 'ERELEASED') throw error
      } finally {
        removeLeaseIfOwned(leasePath, info)
      }
    },
  }
  ownershipRegistry.set(registryKey, handle)
  return handle
}

function writeLeaseAtomic(leasePath: string, info: LeaseInfo): void {
  const temp = `${leasePath}.${info.ownerId}.tmp`
  try {
    writeFileSync(temp, `${JSON.stringify(info, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, leasePath)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

function removeLeaseIfOwned(leasePath: string, expected: LeaseInfo): void {
  const current = parseLease(leasePath)
  if (current.state !== 'valid') return
  const same = expected.ownerId
    ? current.info.ownerId === expected.ownerId
    : current.info.pid === expected.pid
      && current.info.hostname === expected.hostname
      && current.info.startedAt === expected.startedAt
      && current.info.surface === expected.surface
  if (same) rmSync(leasePath, { force: true })
}

function ownershipError(message: string): Error {
  return Object.assign(new Error(message), { code: 'ELOCKED' })
}
