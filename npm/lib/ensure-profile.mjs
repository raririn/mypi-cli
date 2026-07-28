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
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundledSource = join(packageRoot, "resources", "mypi-core");
const lockAttempts = 100;

export async function ensureBundledProfile({
  env = process.env,
  replaceManaged = false,
} = {}) {
  const agentDir = resolve(env.MYPI_AGENT_DIR || join(homedir(), ".mypi", "agent"));
  assertSafeDirectory(agentDir);
  const settingsPath = join(agentDir, "settings.json");
  const lockPath = join(agentDir, ".distribution-profile.lock");
  await acquireLock(lockPath);
  try {
    const settings = readSettings(settingsPath);
    const packages = Array.isArray(settings.packages) ? [...settings.packages] : [];
    let changed = false;
    let foundBundled = false;

    const nextPackages = [];
    for (const entry of packages) {
      const source = packageSource(entry);
      if (!source) {
        nextPackages.push(entry);
        continue;
      }
      const resolvedSource = resolvePackageSource(source, settingsPath);
      if (samePath(resolvedSource, bundledSource)) {
        foundBundled = true;
        nextPackages.push(entry);
        continue;
      }
      if (
        replaceManaged
        && isSupersededManagedPackage(resolvedSource, agentDir)
      ) {
        changed = true;
        continue;
      }
      if (
        replaceManaged
        && isReplaceableMyPiCore(resolvedSource, agentDir, env.MYPI_PACKAGE_ROOT)
      ) {
        changed = true;
        foundBundled = true;
        nextPackages.push(replacePackageSource(entry, bundledSource));
        continue;
      }
      nextPackages.push(entry);
    }

    if (!foundBundled && !hasValidMyPiCore(nextPackages, settingsPath)) {
      nextPackages.push(bundledSource);
      changed = true;
    }

    if (changed) {
      settings.packages = nextPackages;
      backupSettings(settingsPath, agentDir);
      atomicWriteJson(settingsPath, settings);
    }
    return { changed, source: bundledSource };
  } finally {
    try {
      rmdirSync(lockPath);
    } catch {
      // A failed cleanup must not mask the profile result; stale locks expire.
    }
  }
}

function assertSafeDirectory(path) {
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Unsafe MyPi agent directory: ${path}`);
    }
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
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Unsafe MyPi settings path: ${path}`);
  }
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("MyPi settings must contain a JSON object.");
  }
  return value;
}

function packageSource(entry) {
  if (typeof entry === "string") return entry;
  return entry && typeof entry === "object" && typeof entry.source === "string"
    ? entry.source
    : undefined;
}

function replacePackageSource(entry, source) {
  return typeof entry === "string" ? source : { ...entry, source };
}

function resolvePackageSource(source, settingsPath) {
  if (/^(?:npm:|git:|https?:|ssh:)/.test(source)) return undefined;
  return resolve(isAbsolute(source) ? source : join(dirname(settingsPath), source));
}

function hasValidMyPiCore(entries, settingsPath) {
  return entries.some((entry) => {
    const source = packageSource(entry);
    const resolvedSource = source ? resolvePackageSource(source, settingsPath) : undefined;
    if (!resolvedSource || !existsSync(join(resolvedSource, "package.json"))) return false;
    try {
      const manifest = JSON.parse(readFileSync(join(resolvedSource, "package.json"), "utf8"));
      return manifest.name === "@mypi/core";
    } catch {
      return false;
    }
  });
}

function isReplaceableMyPiCore(path, agentDir, configuredPackageRoot) {
  if (!path) return false;
  const resolvedPath = resolve(path);
  if (resolvedPath === resolve(agentDir, "packages", "mypi-core")) return hasMyPiCoreManifest(resolvedPath);
  const standaloneRoots = [
    join(agentDir, "..", "packages", "standalone", "releases"),
    configuredPackageRoot ? join(resolve(configuredPackageRoot), "releases") : undefined,
  ].filter(Boolean);
  return standaloneRoots.some((standaloneRoot) => {
    const relativePath = relative(resolve(standaloneRoot), resolvedPath);
    return relativePath
      && relativePath !== ".."
      && !relativePath.startsWith(`..${sep}`)
      && !isAbsolute(relativePath)
      && resolvedPath.endsWith(`${sep}resources${sep}mypi-core`)
      && hasMyPiCoreManifest(resolvedPath);
  });
}

function hasMyPiCoreManifest(path) {
  try {
    return JSON.parse(readFileSync(join(path, "package.json"), "utf8")).name === "@mypi/core";
  } catch {
    return false;
  }
}

function isSupersededManagedPackage(path, agentDir) {
  if (!path || resolve(path) !== resolve(agentDir, "packages", "web-search")) return false;
  try {
    return JSON.parse(readFileSync(join(path, "package.json"), "utf8")).name === "@mypi/web-search";
  } catch {
    return false;
  }
}

function samePath(left, right) {
  return left ? resolve(left) === resolve(right) : false;
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
  const descriptor = openSync(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  try {
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  } finally {
    closeSync(descriptor);
  }
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}
