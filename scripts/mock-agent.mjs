#!/usr/bin/env node
// A tiny fake ACP agent over stdio, for developing Knoware without spending tokens.
// Add it to settings.json:  "agents": { "mock": { "command": "node", "args": ["/path/to/scripts/mock-agent.mjs"] } }
// Prompts containing "permission" ask for permission first; "fail" ends the turn with a refusal.
import { createInterface } from 'node:readline';

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pending = new Map();
let nextId = 1;
const request = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    send({ id, method, params });
  });
const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } });

const cwd = process.env.MOCK_CWD || process.cwd();
const sessions = new Map();
let cancelled = false;

async function stream(sessionId, text) {
  for (const word of text.split(/(?<= )/)) {
    if (cancelled) return;
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: word } });
    await sleep(40);
  }
}

async function prompt(id, { sessionId, prompt }) {
  cancelled = false;
  const text = prompt.map((b) => b.text ?? '').join(' ');
  const s = sessions.get(sessionId) ?? { used: 8000 };
  sessions.set(sessionId, s);
  update(sessionId, { sessionUpdate: 'plan', entries: [
    { content: 'Read the code', status: 'completed', priority: 'medium' },
    { content: 'Make the change', status: 'in_progress', priority: 'medium' },
    { content: 'Run the tests', status: 'pending', priority: 'medium' },
  ] });
  await stream(sessionId, `Looking into: ${text}. `);
  const call = `call-${nextId}`;
  update(sessionId, { sessionUpdate: 'tool_call', toolCallId: call, title: 'pnpm test src/auth', kind: 'execute', status: 'pending' });
  if (/permission/i.test(text)) {
    const res = await request('session/request_permission', {
      sessionId,
      toolCall: { toolCallId: call, title: 'psql -c "CREATE INDEX…"' },
      options: [
        { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    });
    const chosen = res?.outcome?.optionId;
    await stream(sessionId, chosen && chosen !== 'reject' ? 'Permission granted, running it. ' : 'Okay, skipping that. ');
  }
  await sleep(600);
  update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: call, status: cancelled ? 'failed' : 'completed' });
  s.used += 12000;
  update(sessionId, { sessionUpdate: 'usage_update', used: s.used, size: 200000 });
  await stream(sessionId, 'Done.\nAll 42 tests pass.');
  const stopReason = cancelled ? 'cancelled' : /fail/i.test(text) ? 'refusal' : 'end_turn';
  send({ id, result: { stopReason } });
}

const handlers = {
  initialize: () => ({
    protocolVersion: 1,
    agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, fork: {} } },
    authMethods: [],
  }),
  'session/new': () => {
    const sessionId = `mock-${Date.now().toString(36)}`;
    sessions.set(sessionId, { used: 8000 });
    return { sessionId };
  },
  'session/list': () => ({
    sessions: [
      { sessionId: 'mock-old-spike', cwd, title: 'old-spike-experiment', updatedAt: new Date(Date.now() - 9 * 864e5).toISOString() },
      { sessionId: 'mock-weekly', cwd, title: 'weekly-notes', updatedAt: new Date(Date.now() - 30 * 36e5).toISOString() },
    ],
  }),
  'session/load': async ({ sessionId }) => {
    update(sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Earlier question' } });
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Earlier answer, replayed.' } });
    return {};
  },
  'session/fork': () => ({ sessionId: `mock-fork-${Date.now().toString(36)}` }),
};

createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === undefined) {
    pending.get(msg.id)?.(msg.result);
    pending.delete(msg.id);
    return;
  }
  if (msg.method === 'session/cancel') {
    cancelled = true;
    return;
  }
  if (msg.method === 'session/prompt') return prompt(msg.id, msg.params);
  const handler = handlers[msg.method];
  if (!handler) return send({ id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });
  send({ id: msg.id, result: await handler(msg.params) });
});
