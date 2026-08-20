#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, link, lstat, mkdir, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { hostname, homedir, userInfo } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const APPLICATION = "mypi-gui-tui-bridge";
const ARTIFACT_HASH = "__ARTIFACT_HASH__";
const BRIDGE_PROTOCOL = 1;
const MAX_ARGUMENT = 4_096;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const values = new Map();
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.length > MAX_ARGUMENT || /[\0\r\n]/.test(value)) {
      throw new Error("Invalid helper arguments");
    }
    values.set(key.slice(2), value);
  }
  return { command, values };
}

function required(values, key) {
  const value = values.get(key);
  if (!value) throw new Error(`Missing --${key}`);
  return value;
}

async function ensurePrivateDirectory(path) {
  try {
    const existing = await lstat(path);
    if (existing.isSymbolicLink() || !existing.isDirectory()) throw new Error(`Unsafe endpoint directory: ${path}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
  await chmod(path, 0o700);
  return realpath(path);
}

async function ensureDirectory(path) {
  try {
    const existing = await lstat(path);
    if (existing.isSymbolicLink() || !existing.isDirectory()) throw new Error(`Unsafe directory: ${path}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
  return realpath(path);
}

const EXTENSION_FILES = [
  "config.ts",
  "controller.ts",
  "index.ts",
  "keyword-skill-routing.ts",
  "ownership.ts",
  "package.json",
  "presence.ts",
  "protocol.ts",
  "transport.ts",
];

async function assertExtensionMatches(source, target) {
  const entries = (await readdir(target, { withFileTypes: true })).map((entry) => entry.name).sort();
  if (JSON.stringify(entries) !== JSON.stringify([...EXTENSION_FILES].sort())) {
    throw new Error("Existing content-addressed extension has unexpected files");
  }
  for (const name of EXTENSION_FILES) {
    const [expected, actual] = await Promise.all([readFile(join(source, name)), readFile(join(target, name))]);
    if (createHash("sha256").update(expected).digest("hex") !== createHash("sha256").update(actual).digest("hex")) {
      throw new Error(`Existing content-addressed extension failed integrity validation: ${name}`);
    }
  }
}

async function stableHostId() {
  for (const candidate of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    try {
      const value = (await readFile(candidate, "utf8")).trim();
      if (value) return `machine:${value}`;
    } catch {}
  }
  if (process.platform === "darwin") {
    try {
      const output = execFileSync("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { encoding: "utf8", timeout: 5_000 });
      const match = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      if (match?.[1]) return `machine:${match[1]}`;
    } catch {}
  }
  return `fallback:${createHash("sha256").update(`${userInfo().uid}:${hostname()}`).digest("hex")}`;
}

function piVersion() {
  try {
    return execFileSync("pi", ["--version"], { encoding: "utf8", timeout: 5_000 }).trim();
  } catch {
    return "unavailable";
  }
}

async function preflight(values) {
  const requestedHash = required(values, "artifact-hash");
  if (requestedHash !== ARTIFACT_HASH) throw new Error("Artifact hash mismatch");
  const configuredAgentDir = values.get("agent-dir") || process.env.MYPI_AGENT_DIR || process.env.MYPI_CODING_AGENT_DIR || join(homedir(), ".mypi", "agent");
  await mkdir(configuredAgentDir, { recursive: true, mode: 0o700 });
  const agentDir = await realpath(configuredAgentDir);
  process.stdout.write(`${JSON.stringify({
    application: APPLICATION,
    artifactHash: ARTIFACT_HASH,
    piVersion: piVersion(),
    bridgeProtocol: BRIDGE_PROTOCOL,
    nodeMajor: Number(process.versions.node.split(".")[0]),
    agentDir,
    uid: userInfo().uid,
    hostId: await stableHostId(),
  })}\n`);
}

async function prepare(values) {
  if (required(values, "artifact-hash") !== ARTIFACT_HASH) throw new Error("Artifact hash mismatch");
  const profileId = required(values, "profile-id");
  const instanceId = required(values, "instance-id");
  if (!/^[0-9a-f-]{36}$/i.test(profileId) || !/^[0-9a-f-]{36}$/i.test(instanceId)) throw new Error("Invalid runtime identity");
  // Unix socket paths are limited to roughly 104 bytes on macOS. Keep the
  // content-addressed artifact cache verbose, but use a separately hashed,
  // private short namespace for the live socket.
  const cacheRoot = await ensurePrivateDirectory(join(homedir(), ".cache", "mypi", "tb"));
  const artifactRoot = await ensurePrivateDirectory(join(cacheRoot, ARTIFACT_HASH.slice(0, 12)));
  const instanceKey = createHash("sha256").update(`${profileId}:${instanceId}`).digest("hex").slice(0, 24);
  const instanceRoot = await ensurePrivateDirectory(join(artifactRoot, instanceKey));
  const socketPath = join(instanceRoot, "bridge.sock");
  // OpenSSH 8.6 on macOS leaves a remote StreamLocal listener behind when a
  // tunnel drops and does not honor the client's bind-unlink preference for
  // the next remote forward. This directory is derived from the authenticated
  // profile + GUI instance, so removing only an existing socket here is safe;
  // refuse files and symlinks instead of unlinking an ambiguous path.
  try {
    const existingSocket = await lstat(socketPath);
    if (!existingSocket.isSocket() || existingSocket.isSymbolicLink()) throw new Error("Unsafe existing remote bridge socket");
    await rm(socketPath, { force: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  process.stdout.write(`${JSON.stringify({
    application: APPLICATION,
    artifactHash: ARTIFACT_HASH,
    runtimeRoot: instanceRoot,
    socketPath,
  })}\n`);
}

async function install(values) {
  if (required(values, "artifact-hash") !== ARTIFACT_HASH) throw new Error("Artifact hash mismatch");
  const agentDir = resolve(required(values, "agent-dir"));
  // A compatible MyPi installation already loads gui-control from its managed
  // core package. Reuse it so an existing MyPi TUI can tether immediately,
  // without installing a duplicate direct extension or demanding a reload.
  const packagedExtension = join(agentDir, "packages", "mypi-core", "extensions", "gui-control", "index.ts");
  try {
    const packagedInfo = await lstat(packagedExtension);
    const packagedReal = await realpath(packagedExtension);
    if (!packagedInfo.isFile() || packagedInfo.isSymbolicLink() || !packagedReal.startsWith(`${await realpath(agentDir)}${sep}`)) {
      throw new Error("Unsafe managed MyPi gui-control extension");
    }
    process.stdout.write(`${JSON.stringify({
      application: APPLICATION,
      artifactHash: ARTIFACT_HASH,
      extensionPath: packagedReal,
      reloadRequired: false,
    })}\n`);
    return;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const extensionsDir = await ensureDirectory(join(agentDir, "extensions"));
  const target = join(extensionsDir, `mypi-gui-control-${ARTIFACT_HASH.slice(0, 12)}`);
  const source = dirname(fileURLToPath(import.meta.url));
  let targetExists = false;
  try {
    const existing = await lstat(target);
    targetExists = true;
    if (existing.isSymbolicLink() || !existing.isDirectory()) throw new Error("Owned extension target is not a private directory");
    await assertExtensionMatches(source, target);
  } catch (error) {
    if (error?.code !== "ENOENT" || targetExists) throw error;
    const temporary = join(extensionsDir, `.mypi-gui-control-${process.pid}-${randomUUID()}.tmp`);
    await mkdir(temporary, { mode: 0o700 });
    try {
      for (const name of EXTENSION_FILES) {
        const content = await readFile(join(source, name));
        await writeFile(join(temporary, name), content, { mode: 0o600 });
      }
      await rename(temporary, target);
    } catch (copyError) {
      await rm(temporary, { recursive: true, force: true });
      throw copyError;
    }
  }
  process.stdout.write(`${JSON.stringify({
    application: APPLICATION,
    artifactHash: ARTIFACT_HASH,
    extensionPath: join(target, "index.ts"),
    reloadRequired: true,
  })}\n`);
}

async function readOwnedEndpoint(endpointFile, instanceId, token) {
  try {
    const fileInfo = await lstat(endpointFile);
    if (fileInfo.isSymbolicLink() || !fileInfo.isFile()) return undefined;
    const parsed = JSON.parse(await readFile(endpointFile, "utf8"));
    return parsed?.application === "mypi-gui-control" && parsed?.guiInstanceId === instanceId && parsed?.token === token
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

async function serve(values) {
  if (required(values, "artifact-hash") !== ARTIFACT_HASH) throw new Error("Artifact hash mismatch");
  const instanceId = required(values, "instance-id");
  const profileId = required(values, "profile-id");
  const token = required(values, "token");
  if (
    !/^[0-9a-f-]{36}$/i.test(instanceId) ||
    !/^[0-9a-f-]{36}$/i.test(profileId) ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(token)
  ) throw new Error("Invalid endpoint identity");
  const socketPath = required(values, "socket-path");
  const agentDir = resolve(required(values, "agent-dir"));
  const endpointDir = await ensurePrivateDirectory(join(agentDir, "gui-control"));
  const allowedRuntimeRoot = resolve(homedir(), ".cache", "mypi", "tb", ARTIFACT_HASH.slice(0, 12));
  if (!resolve(socketPath).startsWith(`${allowedRuntimeRoot}${sep}`) || !socketPath.endsWith(`${sep}bridge.sock`)) {
    throw new Error("Remote socket path is outside the owned runtime directory");
  }
  const expectedInstanceKey = createHash("sha256").update(`${profileId}:${instanceId}`).digest("hex").slice(0, 24);
  if (dirname(socketPath).split(sep).at(-1) !== expectedInstanceKey) throw new Error("Remote socket path does not match the endpoint instance");
  await ensurePrivateDirectory(dirname(socketPath));
  const endpointFile = join(endpointDir, "endpoint.json");
  try {
    const endpointInfo = await lstat(endpointFile);
    if (endpointInfo.isSymbolicLink() || !endpointInfo.isFile()) throw new Error("Unsafe existing endpoint file");
    const existing = JSON.parse(await readFile(endpointFile, "utf8"));
    if (existing?.guiInstanceId !== instanceId || existing?.token !== token) {
      throw new Error("Another GUI-control endpoint already owns this remote agent directory");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const endpoint = {
    application: "mypi-gui-control",
    protocol: BRIDGE_PROTOCOL,
    guiInstanceId: instanceId,
    pid: process.pid,
    socketPath,
    token,
    createdAt: new Date().toISOString(),
  };
  const temporary = join(endpointDir, `.endpoint-${process.pid}-${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(endpoint)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  if (await readOwnedEndpoint(endpointFile, instanceId, token)) await rm(endpointFile, { force: true });
  try {
    await link(temporary, endpointFile);
  } finally {
    await rm(temporary, { force: true });
  }

  let stopping = false;
  const cleanup = async () => {
    if (stopping) return;
    stopping = true;
    if (await readOwnedEndpoint(endpointFile, instanceId, token)) await rm(endpointFile, { force: true });
    try {
      const socketInfo = await lstat(socketPath);
      if (socketInfo.isSocket()) await rm(socketPath, { force: true });
    } catch {}
    try {
      await rmdir(dirname(socketPath));
    } catch {}
  };
  for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) process.on(signal, () => void cleanup().finally(() => process.exit(0)));
  process.stdin.resume();
  process.stdin.on("end", () => void cleanup().finally(() => process.exit(0)));
  process.stdin.on("error", () => void cleanup().finally(() => process.exit(1)));
  await new Promise(() => {});
}

try {
  const { command, values } = parseArgs(process.argv.slice(2));
  if (command === "preflight") await preflight(values);
  else if (command === "install") await install(values);
  else if (command === "prepare") await prepare(values);
  else if (command === "serve") await serve(values);
  else throw new Error("Expected preflight or serve command");
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
