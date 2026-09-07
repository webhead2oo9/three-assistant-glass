const { test } = require('node:test');
const assert = require('node:assert/strict');
const tick = () => new Promise(resolve => setImmediate(resolve));

async function harness() {
  const { createCodexVoiceOutput } = await import('../server/codex-voice-output.mjs');
  const calls = [], errors = [];
  const session = { threadId: 'thread', tasks: { turnId: 'turn', requests: new Map() } };
  const voice = createCodexVoiceOutput({ request: async (method, params) => { calls.push({ method, params }); } },
    (s, type, data) => errors.push({ type, ...data }));
  voice.ready(session);
  return { voice, session, calls, errors,
    notify: (method, params) => voice.notification(session, { method, params }) };
}

test('search deltas and citation fragments never go to voice; the completed result is sent once', async () => {
  const h = await harness();
  h.notify('turn/started', { turn: { id: 'turn' } });
  for (const delta of ['Search result ci', 'teturn0search', '1']) {
    h.notify('item/agentMessage/delta', { itemId: 'text', delta });
  }
  assert.equal(h.calls.length, 0);
  h.notify('item/completed', { item: { type: 'agentMessage', id: 'text', phase: 'final_answer',
    text: 'Search result citeturn0search1. [Source](https://example.com)' } });
  assert.equal(h.calls.length, 0);
  h.notify('turn/completed', { turn: { id: 'turn', status: 'completed' } });
  await tick();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].method, 'thread/realtime/appendSpeech');
  assert.equal(h.calls[0].params.role, undefined);
  assert.match(h.calls[0].params.text, /Task completed\. Search result/);
  assert.doesNotMatch(h.calls[0].params.text, /|turn0search|https:/);
  assert.doesNotMatch(h.calls[0].params.text, /\[BACKEND\]|Give a brief/);
});

test('approval notifications use a brief notice without command or protocol JSON', async () => {
  const h = await harness();
  h.voice.request(h.session, 'approval');
  await tick();
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0].params.text, /waiting for approval/);
  assert.doesNotMatch(h.calls[0].params.text, /exec_approval|call_id|\{/);
});

test('disconnected voice buffers results and resumes cleanly without replaying the task', async () => {
  const h = await harness();
  h.notify('thread/realtime/transcript/done', { role: 'user', text: 'Search the web.' });
  h.voice.disconnected(h.session);
  h.notify('item/completed', { item: { type: 'agentMessage', text: 'Found the answer. citeturn1view2' } });
  h.notify('turn/completed', { turn: { id: 'turn', status: 'completed' } });
  h.session.tasks.turnId = null;
  assert.equal(h.calls.length, 0);
  const context = h.voice.context(h.session);
  assert.equal(context.initialItems[0].text, 'Search the web.');
  assert.match(context.initialItems.at(-1).text, /Continuity context only, not a new task/);
  assert.doesNotMatch(JSON.stringify(context), /turn1view|/);
  h.voice.ready(h.session);
  await tick();
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0].params.text, /Found the answer/);
});

test('resolved requests and stopped sessions cannot deliver stale notices', async () => {
  const h = await harness();
  h.voice.disconnected(h.session);
  h.voice.request(h.session, 'input');
  h.voice.requestResolved(h.session);
  h.voice.ready(h.session);
  await tick();
  assert.equal(h.calls.length, 0);
  h.voice.disconnected(h.session);
  h.notify('turn/completed', { turn: { status: 'interrupted' } });
  h.voice.stop(h.session);
  h.voice.ready(h.session);
  await tick();
  assert.equal(h.calls.length, 0);
});
