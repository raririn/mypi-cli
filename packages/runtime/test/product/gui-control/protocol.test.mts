import assert from "node:assert/strict";
import test from "node:test";
import { MYPI_CONTROL_PROTOCOL, parseClientFrame, parseServerFrame } from "../../../src/product/gui-control/protocol.ts";

test("managed attachment frames are bounded and advertise explicit local capability", () => {
  const hello = parseClientFrame({
    type: "hello",
    protocol: MYPI_CONTROL_PROTOCOL,
    token: "token",
    connectionId: "connection",
    mode: "tui",
    pid: 1,
    cwd: "/tmp/project",
    sessionId: "session",
    busy: false,
    managedAttachmentTransport: "local-path-v1",
  });
  assert.equal(hello.type, "hello");
  assert.equal(hello.managedAttachmentTransport, "local-path-v1");

  const frame = parseServerFrame({
    type: "send_message",
    requestId: "request",
    message: "inspect this",
    delivery: "auto",
    queuedMessageId: "queue-1",
    attachments: [{
      kind: "image",
      name: "pixel.png",
      mimeType: "image/png",
      fsPath: "/managed/pixel.png",
      sizeBytes: 12,
    }],
  });
  assert.equal(frame.type, "send_message");
  assert.equal(frame.attachments?.[0]?.kind, "image");
  assert.equal(frame.queuedMessageId, "queue-1");
});

test("managed attachment parsing rejects unbounded, malformed, and empty frames", () => {
  assert.throws(() => parseServerFrame({
    type: "send_message", requestId: "request", message: "", delivery: "auto", attachments: [],
  }), /cannot both be empty/);
  assert.throws(() => parseServerFrame({
    type: "send_message",
    requestId: "request",
    message: "x",
    delivery: "auto",
    attachments: [{ kind: "file", name: "x", mimeType: "text/plain", fsPath: "/x", sizeBytes: 20 * 1024 * 1024 }],
  }), /sizeBytes is invalid/);
  assert.throws(() => parseClientFrame({
    type: "hello",
    protocol: MYPI_CONTROL_PROTOCOL,
    token: "token",
    connectionId: "connection",
    mode: "tui",
    pid: 1,
    cwd: "/tmp/project",
    sessionId: "session",
    busy: false,
    managedAttachmentTransport: "remote-path-v1",
  }), /Unknown managed attachment transport/);
});

test("tree, fork, and shutdown operations retain bounded acknowledged payloads", () => {
  assert.deepEqual(parseServerFrame({
    type: "execute_operation",
    requestId: "tree-request",
    operation: { type: "navigate_tree", targetId: "entry-12345678", summarize: false },
  }), {
    type: "execute_operation",
    requestId: "tree-request",
    operation: { type: "navigate_tree", targetId: "entry-12345678", summarize: false },
  });
  assert.deepEqual(parseServerFrame({
    type: "execute_operation",
    requestId: "fork-request",
    operation: { type: "resolve_fork", renderedMessageIndex: 3, renderedMessageText: "exact assistant text" },
  }).operation, { type: "resolve_fork", renderedMessageIndex: 3, renderedMessageText: "exact assistant text" });
  assert.deepEqual(parseServerFrame({
    type: "execute_operation",
    requestId: "shutdown-request",
    operation: { type: "shutdown" },
  }).operation, { type: "shutdown" });
  const response = parseClientFrame({
    type: "operation_result",
    connectionId: "connection",
    requestId: "tree-request",
    accepted: true,
    result: { roots: [], leafId: null },
  });
  assert.equal(response.type, "operation_result");
  assert.deepEqual(response.result, { roots: [], leafId: null });
  assert.throws(() => parseServerFrame({
    type: "execute_operation",
    requestId: "bad-fork",
    operation: { type: "resolve_fork", renderedMessageIndex: -1 },
  }), /non-negative integer/);
});
