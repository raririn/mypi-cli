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

const readFlag = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const sessionId = readFlag('--session') || 'fake-session-1';
const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let turnActive = false;
let aborted = false;

const state = () => ({
  model: { provider: 'mock', id: 'fake-model' },
  thinkingLevel: 'medium',
  isStreaming: turnActive,
  isCompacting: false,
  steeringMode: 'all',
  followUpMode: 'all',
  sessionFile: `/tmp/fake-engine/${sessionId}.jsonl`,
  sessionId,
  autoCompactionEnabled: true,
  messageCount: 0,
  pendingMessageCount: 0,
});

async function runTurn(promptText) {
  turnActive = true;
  out({ type: 'agent_start' });
  await sleep(10);
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
      recommendedOption: 0,
    });
  }
  await sleep(Number(process.env.FAKE_ENGINE_TURN_MS || 40));
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
      if (mode === 'slow') return;
      out({ id, type: 'response', command: 'get_state', success: true, data: state() });
      return;
    case 'prompt':
      out({ id, type: 'response', command: 'prompt', success: true });
      void runTurn(command.message);
      return;
    case 'abort':
      aborted = turnActive;
      out({ id, type: 'response', command: 'abort', success: true });
      return;
    case 'extension_ui_response':
      out({ type: '__fake_ui_response_received', id: command.id, value: command.value });
      return;
    default:
      out({ id, type: 'response', command: String(type), success: false, error: `Unknown command: ${type}` });
  }
}
