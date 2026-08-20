#!/usr/bin/env node

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { readMyPiRuntimeVersion } from "./mypi-version-contract.mjs";

// MyPi uses its own state namespace. MYPI_AGENT_DIR is the only
// product-facing override; the vendored upstream package derives and reads the
// internal MYPI_CODING_AGENT_DIR name from its MyPi package identity.
const configuredAgentDir = process.env.MYPI_AGENT_DIR;
const agentDir = resolve(configuredAgentDir || join(homedir(), ".mypi", "agent"));
process.env.MYPI_AGENT_DIR = agentDir;
process.env.MYPI_CODING_AGENT_DIR = agentDir;
delete process.env.PI_CODING_AGENT_DIR;
delete process.env.MYPI_RUNTIME_PROFILE;

const { productVersion, piCoreVersion, displayVersion } = readMyPiRuntimeVersion();
process.env.MYPI_RUNTIME_DISPLAY_VERSION = displayVersion;

// Private, protocol-versioned entry points used by MyPi Desktop over SSH.
// They deliberately run inside this launcher's Node runtime so a remote login
// shell only needs a compatible `mypi` binary; `node` itself need not be on
// the non-interactive PATH.
const internalCommand = process.argv[2];
if (internalCommand === "--version" || internalCommand === "-v") {
  process.stdout.write(`${displayVersion}\n`);
  process.exit(0);
}

if (internalCommand === "__remote-info") {
  const invokedPathIndex = process.argv.indexOf("--invoked-path", 3);
  const invokedPath = invokedPathIndex >= 0 ? process.argv[invokedPathIndex + 1] : undefined;
  process.stdout.write(`${JSON.stringify({
    application: "mypi-remote-host",
    protocol: 1,
    bridgeProtocol: 5,
    workspaceProtocol: 2,
    workspaceCapabilities: ["files", "changes", "worktrees", "attachments", "session-lifecycle", "project-resources", "workspace-index"],
    version: productVersion,
    piVersion: piCoreVersion,
    nodeMajor: Number(process.versions.node.split(".")[0]),
    agentDir,
    ...(invokedPath ? { executablePath: invokedPath } : {}),
  })}\n`);
  process.exit(0);
}

if (internalCommand === "__remote-node-eval") {
  const encoded = process.argv[3];
  if (!encoded || !/^[A-Za-z0-9+/=]+$/.test(encoded) || encoded.length > 512_000) {
    throw new Error("Invalid MyPi remote bootstrap payload.");
  }
  const source = Buffer.from(encoded, "base64").toString("utf8");
  const require = createRequire(import.meta.url);
  Function("require", source)(require);
} else if (internalCommand === "__remote-run") {
  const scriptPath = process.argv[3];
  if (!scriptPath || !scriptPath.startsWith("/") || /[\0\r\n]/.test(scriptPath)) {
    throw new Error("Invalid MyPi remote helper path.");
  }
  process.argv = [process.execPath, scriptPath, ...process.argv.slice(4)];
  await import(pathToFileURL(scriptPath).href);
} else if (internalCommand === "__remote-workspace") {
  await import("./mypi-remote-workspace.mjs");
} else if (internalCommand === "__daemon") {
  // Session daemon (FEAT-061): one socket per profile owning every live
  // session, so surfaces meet on a single authority and remote access needs
  // exactly one pipe.
  await import("./mypi-daemon.mjs");
} else if (internalCommand === "proxy") {
  // stdio <-> daemon pass-through for SSH.
  await import("./mypi-proxy.mjs");
} else if (internalCommand === "__host") {
  // Session host (FEAT-060): serves the RPC runtime on a unix socket so
  // several surfaces can attach to one live session.
  await import("./mypi-host.mjs");
} else if (internalCommand === "attach") {
  // Line-mode client for a live hosted session (FEAT-060 Phase 2a).
  await import("./mypi-attach.mjs");
} else {

  // Hosted TUI (FEAT-061 Phase C: default on). Interactive launches attach
  // to the per-profile session daemon as clients — the TUI spawns the daemon
  // when it is not yet alive, otherwise it connects and treats it as the
  // authority — so every surface co-drives one session and sessions survive
  // any surface exiting. MYPI_TUI_HOSTED=0 forces the embedded runtime,
  // which also remains the automatic fallback for ineligible launches and
  // every failure here.
  const cliArgs = process.argv.slice(2);
  const nonSessionInvocation =
    cliArgs[0] === "chat" ||
    cliArgs.some((arg) =>
      ["--help", "-h", "--version", "-v", "--list-models", "--export", "--print", "-p", "--mode"].includes(arg),
    );
  if (process.env.MYPI_TUI_HOSTED !== "0" && !nonSessionInvocation && process.stdin.isTTY && process.stdout.isTTY) {
    try {
      const { MYPI_DAEMON_PROTOCOL, ensureDaemonRunning } = await import("./mypi-daemon-discovery.mjs");
      const socketPath = await ensureDaemonRunning(process.argv[1]);
      process.env.MYPI_TUI_HOSTED = "1";
      process.env.MYPI_DAEMON_SOCKET = socketPath;
      process.env.MYPI_DAEMON_PROTOCOL = String(MYPI_DAEMON_PROTOCOL);
    } catch (error) {
      delete process.env.MYPI_TUI_HOSTED;
      process.stderr.write(
        `Hosted session unavailable (${error instanceof Error ? error.message : String(error)}); running embedded.\n`,
      );
    }
  }

  const { runWebSearchCommand } = await import("./mypi-web-search-config.mjs");
  try {
    if (!(await runWebSearchCommand(process.argv.slice(2)))) {
      await import("./pi-cli.mjs");
    }
  } catch (error) {
    process.stderr.write(`MyPi web search: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
