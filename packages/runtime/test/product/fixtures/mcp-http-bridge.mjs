// Test-only STDIO <-> Streamable HTTP bridge. Forwards each newline-delimited
// JSON-RPC message from stdin as an HTTP POST and writes JSON responses back
// to stdout. Lets the Slice A STDIO client exercise public reference servers
// (Slice B owns native HTTP). Not part of the shipped runtime.
import process from "node:process";

const endpoint = process.argv[2];
if (!endpoint || !/^https:\/\//u.test(endpoint)) {
  process.stderr.write("usage: mcp-http-bridge.mjs <https-endpoint>\n");
  process.exit(2);
}
let sessionId;

async function forward(line) {
  const message = JSON.parse(line);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(message),
  });
  const newSession = response.headers.get("mcp-session-id");
  if (newSession) sessionId = newSession;
  if (message.id === undefined) return; // notification: ignore the ack body
  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.text();
  if (contentType.includes("text/event-stream")) {
    for (const chunk of body.split("\n\n")) {
      for (const eventLine of chunk.split("\n")) {
        if (eventLine.startsWith("data: ")) process.stdout.write(`${eventLine.slice(6)}\n`);
      }
    }
    return;
  }
  if (body.trim()) process.stdout.write(`${body.trim().replace(/\n/gu, " ")}\n`);
}

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let newline = buffer.indexOf("\n");
  while (newline !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\n");
    if (!line.trim()) continue;
    forward(line).catch((error) => {
      const id = (() => { try { return JSON.parse(line).id; } catch { return undefined; } })();
      if (id !== undefined) {
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: String(error?.message ?? error) } })}\n`);
      }
    });
  }
});
