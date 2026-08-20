import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export interface TuiPresenceLease {
  version: 1
  instanceId: string
  pid: number
  processStartTime?: number
  cwd: string
  sessionId: string
  sessionFile?: string
  sessionName?: string
  leafId?: string
  heartbeatAt: string
}
export interface TuiPresenceHandle { path?: string; stop(): void }
export const TUI_PRESENCE_HEARTBEAT_MS = 10_000
export const TUI_PRESENCE_STALE_MS = 35_000

export function parseTuiPresenceLease(value: unknown): TuiPresenceLease {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Presence lease must be an object')
  const input = value as Record<string, unknown>
  if (input.version !== 1 || typeof input.instanceId !== 'string' || typeof input.pid !== 'number' || (input.processStartTime != null && typeof input.processStartTime !== 'number') || typeof input.cwd !== 'string' || typeof input.sessionId !== 'string' || typeof input.heartbeatAt !== 'string' || !Number.isFinite(Date.parse(input.heartbeatAt))) throw new Error('Malformed TUI presence lease')
  for (const key of ['sessionFile', 'sessionName', 'leafId']) if (input[key] != null && typeof input[key] !== 'string') throw new Error(`Malformed presence ${key}`)
  return input as unknown as TuiPresenceLease
}

export function startTuiPresence(agentDir: string, getLease: () => Omit<TuiPresenceLease, 'version' | 'instanceId' | 'pid' | 'processStartTime' | 'heartbeatAt'>): TuiPresenceHandle {
  const instanceId = randomUUID(); let stopped = false; let path: string | undefined
  let timer: NodeJS.Timeout | undefined
  const write = () => {
    if (stopped) return
    try {
      const current = getLease()
      const directory = join(resolve(agentDir), 'tui-presence')
      if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) throw new Error('Unsafe TUI presence directory')
      mkdirSync(directory, { recursive: true, mode: 0o700 }); try { chmodSync(directory, 0o700) } catch { /* best effort */ }
      path ||= join(directory, `${process.pid}-${current.sessionId}-${instanceId.slice(0, 8)}.json`)
      const temp = `${path}.${instanceId}.tmp`
      const lease: TuiPresenceLease = { version: 1, instanceId, pid: process.pid, processStartTime: Math.round(performance.timeOrigin), ...current, heartbeatAt: new Date().toISOString() }
      writeFileSync(temp, `${JSON.stringify(lease)}\n`, { encoding: 'utf8', mode: 0o600 })
      renameSync(temp, path)
    } catch { /* presence is advisory and must never affect TUI work */ }
  }
  const removeLease = () => { if (path) try { rmSync(path, { force: true }) } catch { /* nonfatal */ } }
  const onProcessExit = () => removeLease()
  process.once('exit', onProcessExit)
  write(); timer = setInterval(write, TUI_PRESENCE_HEARTBEAT_MS); timer.unref()
  return { get path() { return path }, stop() { if (stopped) return; stopped = true; if (timer) clearInterval(timer); process.off('exit', onProcessExit); removeLease() } }
}

export function readTuiPresenceLease(path: string): TuiPresenceLease | undefined {
  try { const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink()) return undefined; return parseTuiPresenceLease(JSON.parse(readFileSync(path, 'utf8'))) }
  catch { return undefined }
}
