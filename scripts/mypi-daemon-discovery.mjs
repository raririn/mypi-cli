// Side-effect-free discovery helpers for the MyPi session daemon.
//
// Deliberately separate from `mypi-daemon.mjs`: that module *is* the daemon
// and binds a socket when loaded, so anything that merely needs to find a
// daemon (the proxy, `mypi attach`, tests) must import from here instead.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Bumped only for breaking wire changes; clients exact-match it. */
export const MYPI_DAEMON_PROTOCOL = 2;

const STARTUP_LOCK_STALE_MS = 30_000;

function agentDir() {
  const configured = process.env.MYPI_AGENT_DIR || process.env.MYPI_CODING_AGENT_DIR;
  return resolve(configured || join(homedir(), ".mypi", "agent"));
}

/** Directory holding the daemon socket and its discovery sidecar. */
export function daemonDir() {
  return process.env.MYPI_DAEMON_DIR ? resolve(process.env.MYPI_DAEMON_DIR) : join(agentDir(), "daemon");
}

export function daemonSocketPath() {
  return join(daemonDir(), "daemon.sock");
}

export function daemonSidecarPath() {
  return join(daemonDir(), "daemon.json");
}

function daemonStartupLockPath() {
  return join(daemonDir(), "daemon-startup.lock");
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

/**
 * Reads a live daemon sidecar, pruning it (and its orphaned socket file)
 * when the process is gone, so a fresh daemon can bind cleanly.
 */
export function readLiveDaemon() {
  const sidecarPath = daemonSidecarPath();
  let sidecar;
  try {
    sidecar = JSON.parse(readFileSync(sidecarPath, "utf8"));
  } catch {
    return null;
  }
  if (typeof sidecar?.pid !== "number" || typeof sidecar.socketPath !== "string") return null;
  if (!pidAlive(sidecar.pid)) {
    rmSync(sidecarPath, { force: true });
    rmSync(sidecar.socketPath, { force: true });
    return null;
  }
  if (!existsSync(sidecar.socketPath)) return null;
  return sidecar;
}

/**
 * Serializes concurrent spawns: whoever creates the lock file starts the
 * daemon, everyone else waits for the sidecar. A lock left by a crashed
 * starter goes stale and is reclaimed.
 */
export function acquireStartupLock() {
  const lockPath = daemonStartupLockPath();
  mkdirSync(daemonDir(), { recursive: true, mode: 0o700 });
  try {
    const fd = openSync(lockPath, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`);
    closeSync(fd);
    return { acquired: true, release: () => rmSync(lockPath, { force: true }) };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    try {
      const held = JSON.parse(readFileSync(lockPath, "utf8"));
      const age = Date.now() - Date.parse(held.at ?? 0);
      if (!pidAlive(held.pid) || !Number.isFinite(age) || age > STARTUP_LOCK_STALE_MS) {
        rmSync(lockPath, { force: true });
        return acquireStartupLock();
      }
    } catch {
      rmSync(lockPath, { force: true });
      return acquireStartupLock();
    }
    return { acquired: false, release: () => {} };
  }
}

/**
 * Connect-or-spawn: returns the socket path of a live daemon, starting a
 * detached one from `launcherPath` (the `mypi` entry script) when none is
 * running. Used by every surface that treats the daemon as the authority.
 */
export async function ensureDaemonRunning(launcherPath, { spawnTimeoutMs = 15_000 } = {}) {
  const live = readLiveDaemon();
  if (live) return live.socketPath;
  const { spawn } = await import("node:child_process");
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [launcherPath, "__daemon"], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env },
    });
    let buffer = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error("Timed out waiting for the MyPi session daemon to start"));
    }, spawnTimeoutMs);
    timer.unref?.();
    child.stdout?.on("data", (data) => {
      buffer += data.toString();
      const line = buffer.split("\n").find((candidate) => candidate.trim());
      if (!line || settled) return;
      try {
        const frame = JSON.parse(line);
        if (frame?.type === "daemon_ready" && typeof frame.socketPath === "string") {
          settled = true;
          clearTimeout(timer);
          child.stdout?.destroy();
          child.unref();
          resolvePromise(frame.socketPath);
        }
      } catch {
        // Bootstrap noise before the daemon takes stdout.
      }
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`MyPi session daemon exited during startup (code ${code})`));
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}
