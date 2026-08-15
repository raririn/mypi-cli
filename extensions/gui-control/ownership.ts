import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'
import lockfile from '@bybrave/proper-lockfile2'

export const TUI_LEASE_SURFACE = 'pi-cli'
export const SESSION_LOCK_STALE_MS = 30_000
export const SESSION_LOCK_UPDATE_MS = 10_000

export interface SessionOwnershipControlInfo {
  protocol: 1
  socketPath: string
  token: string
}

export interface LeaseInfo {
  version?: 2
  pid: number
  processStartTime?: number
  hostname: string
  startedAt: string
  surface: string
  ownerId?: string
  control?: SessionOwnershipControlInfo
}

export interface SessionHandoffRequest {
  requesterPid: number
  requesterProcessStartTime?: number
  force: boolean
}

export type SessionHandoffDecision =
  | { status: 'accepted' }
  | { status: 'busy'; message?: string }
  | { status: 'declined'; message?: string }
  | { status: 'error'; message: string }

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
  /** MyPi profile root used for the authenticated local handoff endpoint. */
  agentDir?: string
  /** Optional cooperative handoff handler. Absence leaves force/manual recovery only. */
  onHandoffRequest?: (request: SessionHandoffRequest) => Promise<SessionHandoffDecision>
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
      (value.version !== undefined && value.version !== 2) ||
      (value.processStartTime !== undefined && (typeof value.processStartTime !== 'number' || !Number.isFinite(value.processStartTime))) ||
      typeof value.hostname !== 'string' ||
      typeof value.startedAt !== 'string' ||
      typeof value.surface !== 'string' ||
      (value.ownerId !== undefined && typeof value.ownerId !== 'string') ||
      (value.control !== undefined && (
        typeof value.control !== 'object' ||
        value.control === null ||
        value.control.protocol !== 1 ||
        typeof value.control.socketPath !== 'string' ||
        typeof value.control.token !== 'string'
      ))
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

  // No live lock: the writer is not refreshing it, so the lease is at most
  // migration-compatibility evidence of an older MyPi writer that created
  // only a .lease. Trust it solely for a same-host process that is still
  // alive; a lease from a dead pid or a vanished host (a container that was
  // replaced, a machine that was renamed) is stale and must not lock the
  // session out — that is what `startSessionOwnership` reclaims.
  if (parsed.state === 'missing') return undefined
  if (parsed.state === 'invalid') return unknownHolder()
  if (parsed.info.pid === process.pid && parsed.info.hostname === hostname()) return undefined
  if (parsed.info.hostname === hostname() && pidAlive(parsed.info.pid)) return parsed.info
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
  const ownerId = randomUUID()
  const processStartTime = Math.round(performance.timeOrigin)
  const control = options.agentDir && options.onHandoffRequest
    ? createOwnershipControl(options.agentDir, sessionFile, ownerId, options.onHandoffRequest)
    : undefined
  const info: LeaseInfo = {
    version: 2,
    pid: process.pid,
    processStartTime,
    hostname: hostname(),
    startedAt: new Date().toISOString(),
    surface: options.surface ?? TUI_LEASE_SURFACE,
    ownerId,
    ...(control ? { control: control.info } : {}),
  }
  let compromised = false
  const compromiseListeners = new Set<(error: Error) => void>()
  if (options.onCompromised) compromiseListeners.add(options.onCompromised)
  let releaseLock: (() => void) | undefined
  try {
    releaseLock = lockfile.lockSync(sessionFile, {
      realpath: false,
      lockfilePath: sessionWriterLockPath(sessionFile),
      stale: SESSION_LOCK_STALE_MS,
      update: SESSION_LOCK_UPDATE_MS,
      onCompromised: (error) => {
        compromised = true
        for (const listener of compromiseListeners) listener(error)
      },
    })
  } catch (error) {
    control?.stop()
    throw error
  }

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
    control?.stop()
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
        control?.stop()
        removeLeaseIfOwned(leasePath, info)
      }
    },
  }
  ownershipRegistry.set(registryKey, handle)
  return handle
}

function createOwnershipControl(
  agentDir: string,
  sessionFile: string,
  ownerId: string,
  onHandoffRequest: (request: SessionHandoffRequest) => Promise<SessionHandoffDecision>,
): { info: SessionOwnershipControlInfo; stop(): void } {
  const preferredDirectory = join(resolve(agentDir), 'ownership-control')
  const preferredSocketPath = join(preferredDirectory, `${ownerId.slice(0, 16)}.sock`)
  // Darwin caps AF_UNIX paths at roughly 104 bytes (Linux at 108). A custom
  // or test profile can exceed that even though the endpoint itself is local.
  // Keep the fallback private to this uid and retain the random owner token.
  const directory = Buffer.byteLength(preferredSocketPath) <= 96
    ? preferredDirectory
    : join('/tmp', `mypi-${typeof process.getuid === 'function' ? process.getuid() : process.pid}`, 'ownership-control')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
  const socketPath = join(directory, `${ownerId.slice(0, 16)}.sock`)
  const token = randomUUID()
  rmSync(socketPath, { force: true })

  const server = net.createServer((socket) => {
    socket.setEncoding('utf8')
    let buffer = ''
    let handled = false
    socket.on('data', (chunk) => {
      if (handled) return
      buffer += chunk
      if (buffer.length > 16_384) {
        handled = true
        socket.end(`${JSON.stringify({ type: 'handoff_result', status: 'error', message: 'Request exceeded the handoff protocol limit.' })}\n`)
        return
      }
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      handled = true
      let frame: {
        type?: string
        protocol?: number
        token?: string
        ownerId?: string
        sessionFile?: string
        requesterPid?: number
        requesterProcessStartTime?: number
        force?: boolean
      }
      try {
        frame = JSON.parse(buffer.slice(0, newline)) as typeof frame
      } catch {
        socket.end(`${JSON.stringify({ type: 'handoff_result', status: 'error', message: 'Malformed handoff request.' })}\n`)
        return
      }
      if (
        frame.type !== 'handoff_request' ||
        frame.protocol !== 1 ||
        frame.token !== token ||
        frame.ownerId !== ownerId ||
        resolve(String(frame.sessionFile ?? '')) !== resolve(sessionFile) ||
        !Number.isInteger(frame.requesterPid) ||
        Number(frame.requesterPid) <= 0
      ) {
        socket.end(`${JSON.stringify({ type: 'handoff_result', status: 'error', message: 'Handoff request identity did not match the current owner.' })}\n`)
        return
      }
      void onHandoffRequest({
        requesterPid: Number(frame.requesterPid),
        ...(typeof frame.requesterProcessStartTime === 'number'
          ? { requesterProcessStartTime: frame.requesterProcessStartTime }
          : {}),
        force: frame.force === true,
      }).then(
        (result) => socket.end(`${JSON.stringify({ type: 'handoff_result', ...result })}\n`),
        (error: unknown) => socket.end(`${JSON.stringify({
          type: 'handoff_result',
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        })}\n`),
      )
    })
  })
  server.on('error', () => {})
  server.listen(socketPath, () => {
    try { chmodSync(socketPath, 0o600) } catch {}
  })
  server.unref()

  let stopped = false
  return {
    info: { protocol: 1, socketPath, token },
    stop() {
      if (stopped) return
      stopped = true
      try { server.close() } catch {}
      rmSync(socketPath, { force: true })
    },
  }
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
