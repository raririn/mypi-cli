#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  archiveChat,
  deleteArchivedChat,
  ensureChatRoots,
  eraseChatAssets,
  listChats,
  resolveChatPaths,
  restoreChat,
} from "@earendil-works/pi-coding-agent";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const piRoot = resolve(scriptDirectory, "..");
const piCli = join(piRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const args = process.argv.slice(2);

if (args[0] !== "chat") {
  await runPi(args, process.cwd(), process.env);
  process.exitCode = 0;
} else {
  await runChat(args.slice(1));
}

async function runChat(chatArgs) {
  const agentDir = resolve(process.env.MYPI_AGENT_DIR || process.env.MYPI_CODING_AGENT_DIR || join(homedir(), ".mypi", "agent"));
  let paths = resolveChatPaths(agentDir);
  await ensureChatRoots(paths);
  paths = resolveChatPaths(agentDir);
  const [command, ...rest] = chatArgs;

  if (command === "--help" || command === "-h" || command === "help") {
    printChatHelp();
    return;
  }
  if (["list", "archive", "restore", "erase-assets", "delete"].includes(command)) {
    await runStorageCommand(command, rest, paths);
    return;
  }

  rejectProfileOverrides(chatArgs);
  const launch = await resolveChatLaunch(chatArgs, paths);
  await mkdir(launch.cwd, { recursive: true });
  if (launch.create) await writeFile(join(launch.cwd, "canvas.md"), "", { flag: "wx" });

  const forwarded = [
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--tools", "read_canvas,edit_canvas,replace_canvas,list_attachments,read_attachment,calculate,web_search,web_fetch",
    "--session-dir", paths.activeHistory,
    ...launch.args,
  ];
  await runPi(forwarded, launch.cwd, {
    ...process.env,
    MYPI_RUNTIME_PROFILE: "chat",
    PI_GUI_CHAT_ROOT: paths.root,
  });
}

async function resolveChatLaunch(chatArgs, paths) {
  const records = await listChats("active", paths);
  if (chatArgs.some((arg) => arg === "--continue" || arg === "-c")) {
    const latest = records.find((record) => record.assetDirectory);
    if (latest?.assetDirectory) {
      return {
        cwd: latest.assetDirectory,
        create: false,
        args: [...chatArgs.filter((arg) => arg !== "--continue" && arg !== "-c"), "--session", latest.session.path],
      };
    }
    return { cwd: join(paths.activeAssets, randomUUID()), create: true, args: chatArgs };
  }

  const selector = sessionSelector(chatArgs);
  if (selector) {
    const resolvedSelector = resolve(selector);
    const selected = records.find(
      (record) => record.session.id === selector || resolve(record.session.path) === resolvedSelector,
    );
    if (!selected?.assetDirectory) throw new Error(`No active Chat found for --session ${selector}.`);
    return { cwd: selected.assetDirectory, create: false, args: chatArgs };
  }

  const resumesExisting = chatArgs.some((arg) => ["--resume", "-r"].includes(arg));
  return resumesExisting
    ? { cwd: paths.activeAssets, create: false, args: chatArgs }
    : { cwd: join(paths.activeAssets, randomUUID()), create: true, args: chatArgs };
}

function sessionSelector(args) {
  const inline = args.find((arg) => arg.startsWith("--session="));
  if (inline) return inline.slice("--session=".length);
  const index = args.indexOf("--session");
  return index >= 0 ? args[index + 1] : undefined;
}

async function runStorageCommand(command, args, paths) {
  if (command === "list") {
    const stateArg = args.find((arg) => arg.startsWith("--state="))?.slice("--state=".length);
    const state = ["active", "archived", "all"].includes(stateArg) ? stateArg : "all";
    const records = await listChats(state, paths);
    const rows = records.map((record) => ({
      state: record.state,
      sessionId: record.session.id,
      name: record.session.name ?? null,
      modifiedAt: record.session.modified.toISOString(),
      preview: record.session.firstMessage || null,
      historyBytes: record.historyBytes,
      assetBytes: record.assetBytes,
      attachmentCount: record.attachmentCount,
    }));
    if (args.includes("--json")) console.log(JSON.stringify(rows));
    else for (const row of rows) console.log(`${row.state}\t${row.sessionId}\t${row.historyBytes + row.assetBytes} bytes\t${row.name || row.preview || "Untitled Chat"}`);
    return;
  }

  const sessionId = args.find((arg) => !arg.startsWith("-"));
  if (!sessionId) throw new Error(`mypi chat ${command} requires a session ID.`);
  if (command === "archive") console.log(JSON.stringify(await archiveChat(sessionId, paths)));
  else if (command === "restore") console.log(JSON.stringify(await restoreChat(sessionId, paths)));
  else if (command === "erase-assets") {
    requireConfirmation(args, "erase Chat canvas and attachments");
    console.log(JSON.stringify({ erased: await eraseChatAssets(sessionId, paths) }));
  } else if (command === "delete") {
    requireConfirmation(args, "permanently delete archived Chat history and assets");
    await deleteArchivedChat(sessionId, paths);
    console.log(JSON.stringify({ deleted: sessionId }));
  }
}

function rejectProfileOverrides(args) {
  if (args.includes("--fork")) {
    throw new Error("mypi chat does not support --fork; create a new Chat instead.");
  }
  const forbidden = new Set(["--extension", "-e", "--skill", "--prompt-template", "--tools", "-t", "--exclude-tools", "-xt", "--no-tools", "-nt", "--session-dir"]);
  const found = args.find((arg) => forbidden.has(arg));
  if (found) throw new Error(`mypi chat owns its security profile; ${found} cannot be overridden.`);
}

function requireConfirmation(args, operation) {
  if (!args.includes("--confirm")) throw new Error(`Refusing to ${operation} without --confirm.`);
}

async function runPi(forwarded, cwd, env) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [piCli, ...forwarded], { cwd, env, stdio: "inherit" });
    const forwardInterrupt = () => child.kill("SIGINT");
    const forwardTerminate = () => child.kill("SIGTERM");
    process.on("SIGINT", forwardInterrupt);
    process.on("SIGTERM", forwardTerminate);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      process.off("SIGINT", forwardInterrupt);
      process.off("SIGTERM", forwardTerminate);
      if (signal) reject(new Error(`Pi exited from ${signal}.`));
      else if (code === 0) resolvePromise();
      else reject(new Error(`Pi exited with status ${code ?? "unknown"}.`));
    });
  });
}

function printChatHelp() {
  console.log(`Usage: mypi chat [Pi options or prompt]
       mypi chat --resume
       mypi chat list [--json] [--state=active|archived|all]
       mypi chat archive <session-id>
       mypi chat restore <session-id>
       mypi chat erase-assets <session-id> --confirm
       mypi chat delete <archived-session-id> --confirm

MyPi Chat starts a focused bundled runtime with public web research, a calculator, copied-attachment reading, and one owned canvas.md.`);
}
