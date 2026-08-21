// Adversarial MCP STDIO fixture server for Slice A client tests.
// Modes (argv): --slow-tool <ms>, --crash-on-call, --oversized-list,
// --paginate <pages>, --wrong-protocol, --no-cancel-ack, --list-changed,
// --client-request-probe
import process from "node:process";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? Number(args[index + 1]) : fallback;
};

const slowToolMs = value("--slow-tool", 0);
const paginatePages = value("--paginate", 1);
const cancelled = new Set();
let clientRejectionSeen = false;

const TOOLS = [
  { name: "echo", description: "Echo the text back", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "write_note", description: "Pretend to write a note", inputSchema: { type: "object", properties: { path: { type: "string" }, text: { type: "string" } } } },
  { name: "weird/na me", description: "Name needing normalization", inputSchema: { type: "object", properties: {} } },
  { name: "bad_schema", description: "Rejected by schema bounds", inputSchema: { type: "object", $ref: "#/defs/x" } },
  { name: "client_probe", description: "Reports whether the client rejected our sampling request", inputSchema: { type: "object", properties: {} } },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let newline = buffer.indexOf("\n");
  while (newline !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\n");
    if (line.trim()) handle(JSON.parse(line));
  }
});

function handle(message) {
  if (message.method === "initialize") {
    reply(message.id, {
      protocolVersion: flag("--wrong-protocol") ? "1999-01-01" : message.params.protocolVersion,
      capabilities: { tools: { listChanged: true }, resources: {} },
      serverInfo: { name: "mypi-fixture", version: "1.0.0" },
    });
    return;
  }
  if (message.method === "notifications/initialized") {
    if (flag("--list-changed")) send({ jsonrpc: "2.0", method: "notifications/tools/list_changed", params: {} });
    if (flag("--client-request-probe")) {
      send({ jsonrpc: "2.0", id: "server-req-1", method: "sampling/createMessage", params: {} });
    }
    return;
  }
  if (message.method === "notifications/cancelled") {
    if (!flag("--no-cancel-ack")) {
      const requestId = message.params?.requestId;
      cancelled.add(requestId);
      send({ jsonrpc: "2.0", id: requestId, error: { code: -32800, message: "cancelled" } });
    }
    return;
  }
  if (message.id === "server-req-1" || (message.error && message.id === "server-req-1")) {
    clientRejectionSeen = message.error?.code === -32601;
    return;
  }
  if (message.method === "tools/list") {
    if (flag("--oversized-list")) {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "big", description: "x".repeat(5 * 1024 * 1024), inputSchema: { type: "object" } }] } })}\n`);
      return;
    }
    const cursor = message.params?.cursor ? Number(message.params.cursor) : 0;
    const perPage = Math.ceil(TOOLS.length / paginatePages);
    const page = TOOLS.slice(cursor * perPage, (cursor + 1) * perPage);
    const next = cursor + 1 < paginatePages ? String(cursor + 1) : undefined;
    reply(message.id, { tools: page, ...(next ? { nextCursor: next } : {}) });
    return;
  }
  if (message.method === "resources/list") {
    reply(message.id, { resources: [
      { uri: "fixture://notes/readme", name: "Readme", description: "Fixture readme", mimeType: "text/plain" },
    ] });
    return;
  }
  if (message.method === "resources/templates/list") {
    reply(message.id, { resourceTemplates: [
      { uriTemplate: "fixture://notes/{id}", name: "Note by ID", description: "Template" },
    ] });
    return;
  }
  if (message.method === "resources/read") {
    reply(message.id, { contents: [{ uri: message.params.uri, mimeType: "text/plain", text: `contents of ${message.params.uri}` }] });
    return;
  }
  if (message.method === "tools/call") {
    if (flag("--crash-on-call")) process.exit(7);
    const { name, arguments: toolArgs } = message.params;
    const finish = () => {
      if (cancelled.has(message.id)) return;
      if (name === "echo") {
        reply(message.id, { content: [{ type: "text", text: `echo: ${toolArgs.text}` }], isError: false });
      } else if (name === "client_probe") {
        reply(message.id, { content: [{ type: "text", text: `client-rejected-sampling=${clientRejectionSeen}` }], isError: false });
      } else if (name === "write_note") {
        reply(message.id, { content: [{ type: "text", text: "wrote" }], isError: false });
      } else {
        reply(message.id, { content: [{ type: "text", text: "unknown tool" }], isError: true });
      }
    };
    if (slowToolMs > 0) setTimeout(finish, slowToolMs);
    else finish();
    return;
  }
  if (message.id !== undefined) {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `unsupported: ${message.method}` } });
  }
}
