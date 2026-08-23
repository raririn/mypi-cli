#!/usr/bin/env node
/**
 * Dependency-free stand-in for `mypi --mode rpc` used by session-host tests.
 *
 * Speaks the JSONL protocol of the RPC mode: commands on stdin,
 * `{type:'response'}` acks plus interleaved AgentSessionEvents on stdout.
 * Behavior variants are selected with FAKE_ENGINE_MODE:
 *   (unset)          happy path
 *   ask-user         emit a mypiAskUser extension_ui_request during the turn
 *   crash-mid-turn   exit 1 after the first streamed delta
 *   slow             never answer get_state
 */

const args = process.argv.slice(2);
const mode = process.env.FAKE_ENGINE_MODE || 'happy';
const { randomUUID } = require('node:crypto');
const { join } = require('node:path');
const { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } = require('node:fs');

const readFlag = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

let sessionId = readFlag('--session') || 'fake-session-1';
let newSessionCounter = 0;
const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let turnActive = false;
let aborted = false;
let sessionStartAnnounced = false;
let safetyMode = 'full';
let pendingSafetyMode;
let queuedCounter = 0;
let queuedItems = [];

const emitQueue = () => out({
  type: 'queue_update',
  steering: queuedItems.filter((item) => item.mode === 'steer').map((item) => item.message),
  followUp: queuedItems.filter((item) => item.mode === 'followUp').map((item) => item.message),
  steeringItems: queuedItems.filter((item) => item.mode === 'steer'),
  followUpItems: queuedItems.filter((item) => item.mode === 'followUp'),
});

const sessionDir = join(process.cwd(), 'persisted-sessions');
const sessionPath = () => {
  if (existsSync(sessionDir)) {
    for (const name of readdirSync(sessionDir)) {
      if (!name.endsWith('.jsonl')) continue;
      const candidate = join(sessionDir, name);
      try {
        const firstLine = readFileSync(candidate, 'utf8').split('\n', 1)[0];
        if (JSON.parse(firstLine).id === sessionId) return candidate;
      } catch {
        // Ignore unrelated or mid-write fixtures.
      }
    }
  }
  return join(sessionDir, `${sessionId}.jsonl`);
};
const state = () => ({
  model: { provider: 'mock', id: 'fake-model' },
  thinkingLevel: 'medium',
  safetyPolicyEnabled: true,
  safetyMode,
  ...(pendingSafetyMode ? { pendingSafetyMode } : {}),
  isStreaming: turnActive,
  isCompacting: false,
  steeringMode: 'all',
  followUpMode: 'all',
  sessionFile: sessionPath(),
  sessionId,
  autoCompactionEnabled: true,
  messageCount: 0,
  pendingMessageCount: 0,
  cwd: process.cwd(),
  sessionDir,
  usesDefaultSessionDir: false,
  isPersisted: true,
});

const ensurePersistedSession = () => {
  if (!process.env.FAKE_ENGINE_PERSIST_TURNS) return;
  mkdirSync(sessionDir, { recursive: true });
  if (!existsSync(sessionPath())) {
    writeFileSync(sessionPath(), `${JSON.stringify({ type: 'session', version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: process.cwd() })}\n`);
  }
};

const readEntries = () => {
  if (!existsSync(sessionPath())) return [];
  return readFileSync(sessionPath(), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
};

const messageText = (content) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((part) => part?.type === 'text').map((part) => part.text || '').join('');
};

const materializeTarget = (entries, parentSession) => {
  mkdirSync(sessionDir, { recursive: true });
  const targetId = randomUUID();
  const timestamp = new Date().toISOString();
  const targetPath = join(sessionDir, `${timestamp.replace(/[:.]/g, '-')}_${targetId}.jsonl`);
  const header = {
    type: 'session',
    version: 3,
    id: targetId,
    timestamp,
    cwd: process.cwd(),
    ...(parentSession ? { parentSession } : {}),
  };
  writeFileSync(targetPath, `${[header, ...entries].map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  return { sessionId: targetId, sessionFile: targetPath, cwd: process.cwd() };
};

const branchTo = (entries, leafId) => {
  if (!leafId) return [];
  const byId = new Map(entries.filter((entry) => entry.id).map((entry) => [entry.id, entry]));
  const branch = [];
  let current = byId.get(leafId);
  while (current) {
    branch.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  branch.reverse();
  let parentId = null;
  return branch
    .filter((entry) => entry.type !== 'label')
    .map((entry) => {
      const copy = { ...entry, parentId };
      parentId = entry.id;
      return copy;
    });
};

async function runTurn(promptText, structuredOutput, requestId) {
  turnActive = true;
  out({ type: 'agent_start' });
  const userMessage = { role: 'user', content: [{ type: 'text', text: promptText }], timestamp: Date.now() };
  ensurePersistedSession();
  if (process.env.FAKE_ENGINE_PERSIST_TURNS) {
    appendFileSync(sessionPath(), `${JSON.stringify({ type: 'message', id: `user-${requestId}`, parentId: null, timestamp: new Date().toISOString(), message: userMessage })}\n`);
  }
  out({ type: 'message_start', message: userMessage });
  out({ type: 'message_end', message: userMessage });
  await sleep(typeof promptText === 'string' && promptText.startsWith('write-tracked') ? 100 : 10);
  if (typeof promptText === 'string' && promptText.startsWith('write-tracked')) {
    const path = join(process.cwd(), 'tracked.txt');
    const content = `${promptText}\n`;
    out({ type: 'tool_execution_start', toolCallId: `write-${requestId}`, toolName: 'write', args: { path, content } });
    writeFileSync(path, content);
    out({
      type: 'tool_execution_end',
      toolCallId: `write-${requestId}`,
      toolName: 'write',
      result: { content: [{ type: 'text', text: `Successfully wrote ${content.length} bytes to ${path}` }] },
      isError: false,
    });
  }
  out({
    type: 'message_update',
    message: { role: 'assistant', content: [] },
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: `echo:${promptText}` },
  });
  if (mode === 'crash-mid-turn') process.exit(1);
  if (mode === 'ask-user') {
    out({
      type: 'extension_ui_request',
      id: 'ask-1',
      method: 'mypiAskUser',
      question: 'Proceed?',
      options: [
        { label: 'Yes', description: 'Continue' },
        { label: 'No', description: 'Stop' },
      ],
      recommendedOption: 1,
    });
  }
  await sleep(Number(process.env.FAKE_ENGINE_TURN_MS || 40));
  if (structuredOutput) {
    out({
      type: 'structured_result',
      result: {
        value: { echo: promptText },
        schemaHash: 'fake-schema-hash',
        method: 'native',
        attempts: 1,
        requestId,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
    });
  }
  out({ type: 'agent_settled', outcome: { kind: aborted ? 'aborted' : 'success' } });
  turnActive = false;
  aborted = false;
}

let stdinBuffer = '';
process.stdin.on('data', (chunk) => {
  stdinBuffer += chunk.toString();
  const lines = stdinBuffer.split('\n');
  stdinBuffer = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    let command;
    try {
      command = JSON.parse(line);
    } catch {
      continue;
    }
    void handleCommand(command);
  }
});

process.stdin.on('end', () => process.exit(0));

async function handleCommand(command) {
  const { id, type } = command;
  switch (type) {
    case 'get_state':
      if (process.env.FAKE_ENGINE_FAIL_SESSION === sessionId) {
        if (process.env.FAKE_ENGINE_OWNERSHIP_CONFLICT) {
          const conflict = JSON.parse(process.env.FAKE_ENGINE_OWNERSHIP_CONFLICT);
          await new Promise((resolve) => process.stderr.write(
            `@@MYPI_OWNERSHIP_CONFLICT@@${JSON.stringify({ protocol: 1, ...conflict })}\n`,
            resolve,
          ));
        }
        out({
          type: 'extension_ui_request',
          method: 'notify',
          notifyType: 'error',
          message: `fake ownership conflict for ${sessionId}`,
        });
        process.exit(1);
      }
      if (mode === 'slow') return;
      ensurePersistedSession();
      if (!sessionStartAnnounced && process.env.MYPI_DAEMON_SESSION_START) {
        sessionStartAnnounced = true;
        out({ type: '__fake_session_start', value: JSON.parse(process.env.MYPI_DAEMON_SESSION_START) });
      }
      out({ id, type: 'response', command: 'get_state', success: true, data: state() });
      return;
    case 'prompt':
      out({ id, type: 'response', command: 'prompt', success: true });
	  if (typeof command.message === 'string' && command.message.startsWith('/safety ')) {
		pendingSafetyMode = command.message.slice('/safety '.length).trim();
		if (pendingSafetyMode === safetyMode) pendingSafetyMode = undefined;
		out({ type: 'safety_mode_changed', effective: safetyMode, ...(pendingSafetyMode ? { pending: pendingSafetyMode } : {}) });
		return;
	  }
      void runTurn(command.message, command.structuredOutput, id);
      return;
    case 'steer':
    case 'follow_up': {
      const queueId = `fake-queue-${(queuedCounter += 1)}`;
      queuedItems.push({ id: queueId, message: command.message, mode: type === 'steer' ? 'steer' : 'followUp', hasImages: Boolean(command.images?.length) });
      emitQueue();
      out({ id, type: 'response', command: type, success: true, data: { queueId } });
      return;
    }
    case 'remove_queued': {
      const index = queuedItems.findIndex((item) => item.id === command.queueId);
      if (index < 0) {
        out({ id, type: 'response', command: type, success: false, error: `Queued message not found: ${command.queueId}` });
        return;
      }
      const [removed] = queuedItems.splice(index, 1);
      emitQueue();
      out({ id, type: 'response', command: type, success: true, data: removed });
      return;
    }
    case 'update_queued': {
      const index = queuedItems.findIndex((item) => item.id === command.queueId);
      if (index < 0) {
        out({ id, type: 'response', command: type, success: false, error: `Queued message not found: ${command.queueId}` });
        return;
      }
      queuedItems[index] = { ...queuedItems[index], message: command.message };
      emitQueue();
      out({ id, type: 'response', command: type, success: true, data: queuedItems[index] });
      return;
    }
    case 'abort':
      aborted = turnActive;
      out({ id, type: 'response', command: 'abort', success: true });
      return;
    case 'notify_parent_detached':
      if (process.env.FAKE_ENGINE_DETACH_MARKER) writeFileSync(process.env.FAKE_ENGINE_DETACH_MARKER, `${Date.now()}\n`);
      out({ id, type: 'response', command: 'notify_parent_detached', success: true });
      return;
    case 'extension_ui_response':
      out({ type: '__fake_ui_response_received', id: command.id, value: command.value });
      return;
    case 'new_session':
      sessionId = `fake-new-${(newSessionCounter += 1)}`;
      out({ id, type: 'response', command: 'new_session', success: true, data: { cancelled: false } });
      return;
    case 'prepare_new_session': {
      const data = { cancelled: false };
      if (command.materialize === true) {
        data.target = materializeTarget([], command.parentSession);
      }
      out({ id, type: 'response', command: 'prepare_new_session', success: true, data });
      return;
    }
    case 'prepare_fork': {
      const sourceEntries = readEntries();
      const selected = sourceEntries.find((entry) => entry.id === command.entryId);
      if (!selected) {
        out({ id, type: 'response', command: 'prepare_fork', success: false, error: 'Invalid entry ID for forking' });
        return;
      }
      if ((command.position || 'before') === 'at') {
        const data = { cancelled: false, targetLeafId: selected.id };
        if (command.materialize === true) {
          data.target = materializeTarget(branchTo(sourceEntries, selected.id), sessionPath());
        }
        out({
          id,
          type: 'response',
          command: 'prepare_fork',
          success: true,
          data,
        });
        return;
      }
      if (selected.type !== 'message' || selected.message?.role !== 'user') {
        out({ id, type: 'response', command: 'prepare_fork', success: false, error: 'Invalid entry ID for forking' });
        return;
      }
      const data = {
        cancelled: false,
        targetLeafId: selected.parentId,
        text: messageText(selected.message.content),
      };
      if (command.materialize === true) {
        data.target = materializeTarget(branchTo(sourceEntries, selected.parentId), sessionPath());
      }
      out({
        id,
        type: 'response',
        command: 'prepare_fork',
        success: true,
        data,
      });
      return;
    }
    case 'get_messages':
      out({ id, type: 'response', command: 'get_messages', success: true, data: { messages: [] } });
      return;
    case 'get_system_prompt':
      out({ id, type: 'response', command: 'get_system_prompt', success: true, data: { systemPrompt: 'fake system prompt' } });
      return;
    case 'get_commands':
      out({
        id,
        type: 'response',
        command: 'get_commands',
        success: true,
        data: {
          commands: [
            {
              name: 'plan',
              invocationName: 'plan',
              description: 'Fake plan command',
              source: 'extension',
              sourceInfo: { source: 'auto', scope: 'user', origin: 'package', path: '<fake>' },
            },
          ],
        },
      });
      return;
    case 'set_thinking_level':
      out({ id, type: 'response', command: 'set_thinking_level', success: true });
      out({ type: 'thinking_level_changed', level: command.level });
      return;
    default:
      out({ id, type: 'response', command: String(type), success: false, error: `Unknown command: ${type}` });
  }
}
