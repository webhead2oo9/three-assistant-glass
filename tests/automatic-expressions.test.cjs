const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./browser-modules.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('emotion mapping uses confidence, neutral fallback and hysteresis', async () => {
  const { chooseExpression } = await load('assistant/automatic-expressions.js');
  const supported = ['neutral', 'happy', 'sad', 'angry'];
  const score = (label, score) => ({ label, score });
  assert.equal(chooseExpression([score('joy', 0.9)], supported).expression, 'happy');
  assert.equal(chooseExpression([score('anger', 0.2)], supported).expression, 'neutral');
  assert.equal(chooseExpression([score('surprise', 0.9)], supported).expression, 'neutral');
  assert.equal(chooseExpression([score('neutral', 0.8), score('joy', 0.6)], supported).expression, 'neutral');
  assert.equal(chooseExpression([score('sadness', 0.7), score('joy', 0.6)], supported, 'happy').expression, 'happy');
});

test('automatic expressions are opt-in, coalesce streaming text, and discard results after disable', async () => {
  const timers = new Map(); let id = 0;
  const { createAutomaticExpressions } = await load('assistant/automatic-expressions.js', {
    setTimeout: fn => { timers.set(++id, fn); return id; }, clearTimeout: id => timers.delete(id),
  });
  const requests = [], commands = []; let resolveScores, resets = 0;
  const face = createAutomaticExpressions({
    getExpressions: () => ['neutral', 'happy'], onExpression: c => commands.push(c), onExpressionReset: () => resets++,
  }, async text => { requests.push(text); if (text) return new Promise(resolve => { resolveScores = resolve; }); });
  const flush = () => { const work = [...timers.values()]; timers.clear(); work.forEach(fn => fn()); };
  face.transcript('That is wonderful news!', true); flush();
  assert.equal(requests.length, 0);
  await face.setEnabled(true);
  face.transcript('That is wonderful news!', true);
  face.transcript('That is wonderful news! I am so happy for you!');
  flush(); await tick();
  assert.equal(requests.length, 2);
  assert.match(requests[1], /happy for you/);
  await face.setEnabled(false);
  resolveScores([{ label: 'joy', score: 0.9 }]); await tick();
  assert.equal(commands.length, 0);
  assert.ok(resets >= 2);
  face.transcript('Another happy sentence after disabling.'); flush();
  assert.equal(requests.length, 2);
});

test('a previous reply cannot change the face during a new reply', async () => {
  const timers = new Map(); let id = 0;
  const { createAutomaticExpressions } = await load('assistant/automatic-expressions.js', {
    setTimeout: fn => { timers.set(++id, fn); return id; }, clearTimeout: id => timers.delete(id),
  });
  const commands = []; let finish;
  const face = createAutomaticExpressions({ getExpressions: () => ['neutral', 'happy'], onExpression: c => commands.push(c) },
    async text => text ? new Promise(resolve => { finish = resolve; }) : null);
  await face.setEnabled(true);
  face.transcript('A very happy first reply!', true);
  for (const fn of timers.values()) fn(); timers.clear();
  face.transcript('A completely different reply begins.', true);
  finish([{ label: 'joy', score: 0.9 }]); await tick();
  assert.equal(commands.length, 0);
  face.stop();
});

test('the local emotion endpoint refuses inference while disabled and limits input', async () => {
  const express = require('express');
  const { createEmotionRouter } = await import('../server/emotions.mjs');
  let enabled = false, calls = 0;
  const app = express();
  app.use('/api/emotions', createEmotionRouter({ run: async () => { calls++; return [{ label: 'joy', score: 0.9 }]; } }, () => ({ codexAutoExpressions: enabled })));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.on('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/emotions`;
  const post = text => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Assistant-Request': '1' }, body: JSON.stringify({ text }) });
  try {
    assert.equal((await post('Hi')).status, 403); assert.equal(calls, 0);
    enabled = true;
    assert.equal((await post('x'.repeat(1001))).status, 400); assert.equal(calls, 0);
    const response = await post('That is wonderful news!');
    assert.equal(response.status, 200); assert.equal((await response.json()).scores[0].label, 'joy');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
