import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const MAX_SECRET_BYTES = 8 * 1024;

export async function runWebSearchCommand(
  argv,
  {
    env = process.env,
    stdin = process.stdin,
    stdout = process.stdout,
    readSecret = () => readHiddenSecret(stdin, stdout),
  } = {},
) {
  if (argv[0] !== "web-search") return false;
  const action = argv[1] ?? "help";
  if (action === "help" || action === "--help" || action === "-h") {
    stdout.write(webSearchHelp());
    return true;
  }

  const agentDir = effectiveAgentDir(env);
  if (action === "status") {
    stdout.write(
      existsSync(braveSearchConfigPath(agentDir))
        ? `Brave Search credential is configured in ${braveSearchConfigPath(agentDir)}.\n`
        : `Brave Search credential is not configured; built-in curl fallbacks remain available. Run for Brave: mypi web-search configure\n`,
    );
    return true;
  }

  if (action !== "configure") throw new Error(`Unknown web-search action: ${action}`);
  let country = "US";
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === "--country") {
      country = argv[++index] ?? "";
      continue;
    }
    throw new Error("Usage: mypi web-search configure [--country CC]. The API key is read privately, never from argv.");
  }
  stdout.write("Brave Search API key (input hidden): ");
  const apiKey = await readSecret();
  writeBraveSearchConfig(agentDir, apiKey, country);
  stdout.write(`Brave Search credential saved with owner-only permissions in ${braveSearchConfigPath(agentDir)}.\n`);
  return true;
}

export function effectiveAgentDir(env = process.env) {
  return resolve(env.MYPI_AGENT_DIR || env.MYPI_CODING_AGENT_DIR || join(homedir(), ".mypi", "agent"));
}

export function braveSearchConfigPath(agentDir) {
  return join(resolve(agentDir), "brave-search.json");
}

export function writeBraveSearchConfig(agentDir, rawApiKey, rawCountry = "US") {
  const apiKey = validateApiKey(rawApiKey);
  const defaultCountry = validateCountry(rawCountry);
  const resolvedAgentDir = resolve(agentDir);
  if (existsSync(resolvedAgentDir)) {
    const agentStat = lstatSync(resolvedAgentDir);
    if (!agentStat.isDirectory() || agentStat.isSymbolicLink()) {
      throw new Error("Refusing to write a credential through an unsafe MyPi agent directory.");
    }
  } else {
    mkdirSync(resolvedAgentDir, { recursive: true, mode: 0o700 });
  }

  const destination = braveSearchConfigPath(resolvedAgentDir);
  if (existsSync(destination)) {
    const destinationStat = lstatSync(destination);
    if (!destinationStat.isFile() || destinationStat.isSymbolicLink()) {
      throw new Error("Refusing to replace an unsafe Brave Search credential path.");
    }
  }

  const temporary = join(resolvedAgentDir, `.brave-search.${process.pid}.${Date.now()}.tmp`);
  const descriptor = openSync(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  try {
    writeFileSync(descriptor, `${JSON.stringify({ version: 1, apiKey, defaultCountry }, null, 2)}\n`, "utf8");
  } finally {
    closeSync(descriptor);
  }
  chmodSync(temporary, 0o600);
  renameSync(temporary, destination);
}

function validateApiKey(value) {
  const apiKey = typeof value === "string" ? value.trim() : "";
  if (apiKey.length < 16 || Buffer.byteLength(apiKey, "utf8") > MAX_SECRET_BYTES || /[\x00-\x1f\x7f]/.test(apiKey)) {
    throw new Error("The Brave Search API key is empty or invalid.");
  }
  return apiKey;
}

function validateCountry(value) {
  const country = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!/^[A-Z]{2}$/.test(country)) throw new Error("Country must be a two-letter code such as US.");
  return country;
}

async function readHiddenSecret(stdin, stdout) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    const chunks = [];
    let size = 0;
    for await (const chunk of stdin) {
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_SECRET_BYTES) throw new Error("Credential input is too large.");
      chunks.push(buffer);
    }
    stdout.write("\n");
    return Buffer.concat(chunks).toString("utf8").split(/\r?\n/, 1)[0] ?? "";
  }

  return new Promise((resolveSecret, rejectSecret) => {
    let secret = "";
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
      if (error) rejectSecret(error);
      else resolveSecret(secret);
    };
    const onData = (chunk) => {
      const text = Buffer.from(chunk).toString("utf8");
      if (text.includes("\u0003")) {
        finish(new Error("Credential entry cancelled."));
        return;
      }
      const newlineIndex = text.search(/[\r\n]/);
      const input = newlineIndex >= 0 ? text.slice(0, newlineIndex) : text;
      if (input === "\u007f" || input === "\b") {
        secret = Array.from(secret).slice(0, -1).join("");
      } else {
        secret += input.replace(/[\x00-\x1f\x7f]/g, "");
      }
      if (newlineIndex >= 0) {
        finish();
        return;
      }
      if (Buffer.byteLength(secret, "utf8") > MAX_SECRET_BYTES) finish(new Error("Credential input is too large."));
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

function webSearchHelp() {
  return `MyPi optional Brave Search credential setup\n\n` +
    `  mypi web-search configure [--country CC]\n` +
    `  mypi web-search status\n\n` +
    `Web search is built into MyPi and uses bounded curl fallbacks when Brave is not configured. The optional API key is read from hidden TTY input (or standard input for automation), never argv, and is written atomically with mode 0600. BRAVE_API_KEY remains supported and takes precedence at runtime.\n`;
}
