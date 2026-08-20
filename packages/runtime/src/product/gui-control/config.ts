import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export interface GuiControlConfig { version: 1; autoConnect: 'always' | 'never' }
export interface LoadedGuiControlConfig { config: GuiControlConfig; error?: string }
// MyPi's bridge is advisory until an authenticated endpoint appears, so
// opportunistic discovery is safe and removes the need to type /gc for every
// new TUI. Users who do not want tethering can persist `/gc --never`.
export const DEFAULT_GUI_CONTROL_CONFIG: GuiControlConfig = { version: 1, autoConnect: 'always' }

export function guiControlConfigPath(agentDir: string): string {
  return join(resolve(agentDir), 'gui-control.json')
}

export function loadGuiControlConfig(agentDir: string): LoadedGuiControlConfig {
  const path = guiControlConfigPath(agentDir)
  if (!existsSync(path)) return { config: DEFAULT_GUI_CONTROL_CONFIG }
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('config must be a regular file')
    const value = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown; autoConnect?: unknown }
    if (value.version !== 1 || (value.autoConnect !== 'always' && value.autoConnect !== 'never')) throw new Error('unsupported or malformed config')
    return { config: { version: 1, autoConnect: value.autoConnect } }
  } catch (error) {
    return { config: DEFAULT_GUI_CONTROL_CONFIG, error: error instanceof Error ? error.message : String(error) }
  }
}

export function saveGuiControlConfig(agentDir: string, config: GuiControlConfig): void {
  if (config.version !== 1 || (config.autoConnect !== 'always' && config.autoConnect !== 'never')) throw new Error('Invalid GUI-control config')
  const path = guiControlConfigPath(agentDir)
  const directory = dirname(path)
  if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) throw new Error('Refusing symlinked agent directory')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temp = join(directory, `.gui-control-${process.pid}-${Date.now()}.tmp`)
  let fd: number | undefined
  try {
    fd = openSync(temp, 'wx', 0o600)
    writeFileSync(fd, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
    fsyncSync(fd)
    closeSync(fd); fd = undefined
    try { chmodSync(temp, 0o600) } catch { /* best effort */ }
    renameSync(temp, path)
  } catch (error) {
    if (fd !== undefined) try { closeSync(fd) } catch { /* ignored */ }
    try { rmSync(temp, { force: true }) } catch { /* ignored */ }
    throw error
  }
}
