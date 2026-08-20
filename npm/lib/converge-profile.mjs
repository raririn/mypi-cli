import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const lockAttempts = 100;

/**
 * Remove only recognized legacy MyPi-managed profile packages. Product modules
 * now ship as sealed runtime composition; no package path is added to settings.
 */
export async function convergeLegacyProfile({ env = process.env } = {}) {
  const agentDir = resolve(env.MYPI_AGENT_DIR || join(homedir(), ".mypi", "agent"));
  assertSafeDirectory(agentDir);
  const settingsPath = join(agentDir, "settings.json");
  const lockPath = join(agentDir, ".distribution-profile.lock");
  await acquireLock(lockPath);
  try {
    const settings = readSettings(settingsPath);
    const packages = Array.isArray(settings.packages) ? [...settings.packages] : [];
    const removed = [];
    const retained = [];

    for (const entry of packages) {
      const source = packageSource(entry);
      const resolvedSource = source ? resolvePackageSource(source, settingsPath) : undefined;
      if (isLegacyManagedPackage(resolvedSource, agentDir, env.MYPI_PACKAGE_ROOT)) {
        removed.push(source);
      } else {
        retained.push(entry);
      }
    }

    if (removed.length > 0) {
      settings.packages = retained;
      backupSettings(settingsPath, agentDir);
      atomicWriteJson(settingsPath, settings);
    }
    return { changed: removed.length > 0, removed };
  } finally {
    try {
      rmdirSync(lockPath);
    } catch {
      // A failed cleanup must not mask convergence; stale locks expire.
    }
  }
}

function assertSafeDirectory(path) {
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe MyPi agent directory: ${path}`);
    return;
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

async function acquireLock(path) {
  for (let attempt = 0; attempt < lockAttempts; attempt += 1) {
    try {
      mkdirSync(path, { mode: 0o700 });
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const age = Date.now() - lstatSync(path).mtimeMs;
      if (age > 60_000) {
        try {
          rmdirSync(path);
          continue;
        } catch {
          // Another process may still own or have just removed the lock.
        }
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
  }
  throw new Error(`Timed out waiting for MyPi profile lock: ${path}`);
}

function readSettings(path) {
  if (!existsSync(path)) return {};
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Unsafe MyPi settings path: ${path}`);
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("MyPi settings must contain a JSON object.");
  }
  return value;
}

function packageSource(entry) {
  if (typeof entry === "string") return entry;
  return entry && typeof entry === "object" && typeof entry.source === "string" ? entry.source : undefined;
}

function resolvePackageSource(source, settingsPath) {
  if (/^(?:npm:|git:|https?:|ssh:)/.test(source)) return undefined;
  return resolve(isAbsolute(source) ? source : join(dirname(settingsPath), source));
}

function isLegacyManagedPackage(path, agentDir, configuredPackageRoot) {
  if (!path) return false;
  const resolvedPath = resolve(path);
  if (resolvedPath === resolve(agentDir, "packages", "mypi-core")) return hasManifest(resolvedPath, "@mypi/core");
  if (resolvedPath === resolve(agentDir, "packages", "web-search")) return hasManifest(resolvedPath, "@mypi/web-search");

  const standaloneRoots = [
    join(agentDir, "..", "packages", "standalone", "releases"),
    configuredPackageRoot ? join(resolve(configuredPackageRoot), "releases") : undefined,
  ].filter(Boolean);
  return standaloneRoots.some((root) => {
    const rel = relative(resolve(root), resolvedPath);
    return rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
      && resolvedPath.endsWith(`${sep}resources${sep}mypi-core`)
      && (!existsSync(resolvedPath) || hasManifest(resolvedPath, "@mypi/core"));
  });
}

function hasManifest(path, name) {
  try {
    const manifestPath = join(path, "package.json");
    const stat = lstatSync(manifestPath);
    return stat.isFile() && !stat.isSymbolicLink() && JSON.parse(readFileSync(manifestPath, "utf8")).name === name;
  } catch {
    return false;
  }
}

function backupSettings(settingsPath, agentDir) {
  if (!existsSync(settingsPath)) return;
  const backupRoot = join(agentDir, "backups", "standalone-installer");
  mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const destination = join(backupRoot, `settings-${stamp}.json`);
  copyFileSync(settingsPath, destination, constants.COPYFILE_EXCL);
  chmodSync(destination, 0o600);
}

function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  } finally {
    closeSync(descriptor);
  }
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}
