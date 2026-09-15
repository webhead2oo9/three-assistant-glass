const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./browser-modules.cjs');
const { fakeClock } = require('./fake-clock.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));

function fakeTimers() {
  const timers = new Map(); let id = 0;
  return {
    globals: { setTimeout: fn => { timers.set(++id, fn); return id; }, clearTimeout: id => timers.delete(id) },
    flush: () => { const work = [...timers.values()]; timers.clear(); work.forEach(fn => fn()); },
  };
}

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
  const { globals, flush } = fakeTimers();
  const { createAutomaticExpressions } = await load('assistant/automatic-expressions.js', globals);
  const requests = [], commands = []; let resolveScores, resets = 0;
  const face = createAutomaticExpressions({
    getExpressions: () => ['neutral', 'happy'], onExpression: c => commands.push(c), onExpressionReset: () => resets++,
  }, async payload => { requests.push(payload); if (payload.text) return new Promise(resolve => { resolveScores = resolve; }); return { model: 'goemotions', scores: null }; });
  face.transcript('That is wonderful news!', true); flush();
  assert.equal(requests.length, 0);
  await face.setEnabled(true);
  face.transcript('That is wonderful news!', true);
  face.transcript('That is wonderful news! I am so happy for you!');
  flush(); await tick();
  assert.equal(requests.length, 2);
  assert.match(requests[1].text, /happy for you/);
  await face.setEnabled(false);
  resolveScores({ model: 'goemotions', scores: [{ label: 'joy', score: 0.9 }] }); await tick();
  assert.equal(commands.length, 0);
  assert.ok(resets >= 2);
  face.transcript('Another happy sentence after disabling.'); flush();
  assert.equal(requests.length, 2);
});

test('a previous reply cannot change the face during a new reply', async () => {
  const { globals, flush } = fakeTimers();
  const { createAutomaticExpressions } = await load('assistant/automatic-expressions.js', globals);
  const commands = []; let finish;
  const face = createAutomaticExpressions({ getExpressions: () => ['neutral', 'happy'], onExpression: c => commands.push(c) },
    async payload => payload.text ? new Promise(resolve => { finish = resolve; }) : { model: 'goemotions', scores: null });
  await face.setEnabled(true);
  face.transcript('A very happy first reply!', true);
  flush();
  face.transcript('A completely different reply begins.', true);
  finish({ model: 'goemotions', scores: [{ label: 'joy', score: 0.9 }] }); await tick();
  assert.equal(commands.length, 0);
  face.stop();
});

test('the character model gets the whole reply, the context and the current face, and its decisions are decoded with a dwell', async () => {
  const { globals, flush } = fakeTimers();
  const { createAutomaticExpressions } = await load('assistant/automatic-expressions.js', globals);
  const requests = [], faces = [], statuses = []; let resets = 0;
  const answers = [];
  const face = createAutomaticExpressions({
    getExpressions: () => ['neutral', 'happy', 'sad', 'relaxed'],
    onExpressionWeights: w => faces.push(w), onExpressionReset: () => resets++, onExpressionStatus: s => statuses.push(s),
  }, async payload => { requests.push(payload); return payload.prefix ? { model: 'character', face: answers.shift() } : { model: 'character', face: null }; });
  await face.setEnabled(true);
  assert.match(statuses.at(-1), /character model/);
  face.setContext([{ role: 'system', text: 'ignored' }, { role: 'user', text: 'my cat died yesterday' }]);
  answers.push({ holdProb: 0.1, raw: [0.01, 0.43, 0.0, 0.02, 0.0] });
  face.transcript('I am so sorry,', true); flush(); await tick();
  assert.equal(JSON.stringify(requests.at(-1).context), JSON.stringify([{ role: 'user', text: 'my cat died yesterday' }]));
  assert.equal(requests.at(-1).prefix, 'I am so sorry,');
  assert.equal(requests.at(-1).current.sad, 0);
  assert.equal(JSON.stringify(faces.at(-1)), JSON.stringify({ happy: 0, sad: 0.45, angry: 0, relaxed: 0, surprised: 0 }));
  assert.equal(statuses.at(-1), 'Expression: sad 0.45');
  // two words later the model wants relaxed; the dwell keeps sad, and the face it reports back is still sad
  answers.push({ holdProb: 0.1, raw: [0, 0.02, 0, 0.3, 0] });
  face.transcript('I am so sorry, that is'); flush(); await tick();
  assert.equal(requests.at(-1).current.sad, 0.45);
  assert.equal(faces.length, 1);
  // a hold is a hold
  answers.push({ holdProb: 0.97, raw: [0, 0.02, 0, 0.3, 0] });
  face.transcript('I am so sorry, that is a real loss and I'); flush(); await tick();
  assert.equal(faces.length, 1);
  // a new reply starts from neutral
  const before = resets;
  face.transcript('Sure, here is', true);
  assert.equal(resets, before + 1);
  flush(); await tick();
  assert.equal(requests.at(-1).current.sad, 0);
  face.stop();
});

test('the local emotion endpoint refuses inference while disabled, limits input, and routes by the chosen model', async () => {
  const express = require('express');
  const { createEmotionRouter } = await import('../server/emotions.mjs');
  let enabled = false, model = 'character'; const calls = { goemotions: 0, character: 0 }; let seen;
  const app = express();
  app.use('/api/emotions', createEmotionRouter({
    goemotions: { run: async () => { calls.goemotions++; return [{ label: 'joy', score: 0.9 }]; } },
    character: { run: async payload => { calls.character++; seen = payload; return payload.prefix ? { holdProb: 0.1, raw: [0.4, 0, 0, 0, 0] } : null; } },
  }, () => ({ codexAutoExpressions: enabled, expressionModel: model })));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.on('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/emotions`;
  const post = body => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Assistant-Request': '1' }, body: JSON.stringify(body) });
  try {
    assert.equal((await post({ text: 'Hi' })).status, 403); assert.equal(calls.character, 0);
    enabled = true;
    assert.equal((await post({ prefix: 'x'.repeat(20001) })).status, 400);
    let response = await post({ prefix: 'That is wonderful news!', context: [{ role: 'user', text: ' hi ' }, { role: 'bot', text: 'no' }], current: { happy: 2, sad: 'x' } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { model: 'character', face: { holdProb: 0.1, raw: [0.4, 0, 0, 0, 0] } });
    assert.deepEqual(seen.context, [{ role: 'user', text: 'hi' }]);
    assert.deepEqual(seen.current, { happy: 1, sad: 0, angry: 0, relaxed: 0, surprised: 0 });
    response = await post({ text: '', prefix: '' });
    assert.deepEqual(await response.json(), { model: 'character', face: null });
    model = 'goemotions';
    response = await post({ text: 'That is wonderful news!' });
    assert.equal((await response.json()).scores[0].label, 'joy');
    assert.equal(calls.goemotions, 1);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('a failed request does not end expressions for the session: it warms up again', async () => {
  const { globals, flush } = fakeTimers();
  const { createAutomaticExpressions } = await load('assistant/automatic-expressions.js', globals);
  const statuses = [], faces = [];
  let calls = 0;
  const expressions = createAutomaticExpressions({
    onExpressionStatus: s => statuses.push(s),
    onExpressionWeights: w => faces.push(w),
  }, async () => {
    calls++;
    if (calls === 2) throw new Error('Automatic expressions unavailable'); // a collision with another surface
    if (calls === 1 || calls === 3) return { model: 'character', face: null }; // warm-ups
    return { model: 'character', face: { holdProb: 0.1, raw: [0.4, 0, 0, 0, 0] } };
  });

  await expressions.setEnabled(true);
  expressions.transcript('I am glad you said that', true);
  flush(); await tick(); await tick();
  assert.ok(statuses.includes('Automatic expressions unavailable'), 'the failure is reported');

  flush(); await tick(); await tick();            // the recovery warm-up
  assert.equal(statuses.filter(s => s.startsWith('Automatic expressions ready')).length, 2, 'it comes back');

  expressions.transcript('I am glad you said that today', true);
  flush(); await tick(); await tick();
  assert.equal(faces.length, 1, 'and drives the face again');
  assert.equal(faces[0].happy, 0.4);
  expressions.stop();
});

test('saving settings must keep expression workers available for every enabled assistant', async () => {
  const { automaticExpressionsEnabled } = await import('../server/emotions.mjs');
  assert.equal(automaticExpressionsEnabled({ codexAutoExpressions: false, llmAutoExpressions: true }), true);
  assert.equal(automaticExpressionsEnabled({ codexAutoExpressions: false, realtimeAutoExpressions: true }), true);
  assert.equal(automaticExpressionsEnabled({ codexAutoExpressions: true }), true);
  assert.equal(automaticExpressionsEnabled({ codexAutoExpressions: false, llmAutoExpressions: false, realtimeAutoExpressions: false }), false);
  assert.equal(automaticExpressionsEnabled({}), false);
});

test('an interrupted request cannot fail or overwrite the next reply, even if abort is ignored', async () => {
  const clock = fakeClock(), requests = [], faces = [], statuses = [];
  const { createAutomaticExpressions } = await load('assistant/automatic-expressions.js', clock.globals);
  const expressions = createAutomaticExpressions({
    onExpressionWeights: w => faces.push(w), onExpressionStatus: s => statuses.push(s),
  }, (payload, signal) => !payload.prefix ? Promise.resolve({ model: 'character', face: null })
    : new Promise((resolve, reject) => requests.push({ payload, signal, resolve, reject })));
  try {
    await expressions.setEnabled(true);
    expressions.transcript('This is the old reply', true); clock.advance(350);
    expressions.interrupt();
    assert.equal(requests[0].signal.aborted, true);
    expressions.transcript('This is the new reply', true); clock.advance(350);
    assert.equal(requests.length, 2, 'the new reply does not wait for an aborted request');
    requests[0].reject(new Error('old failure')); await tick();
    requests[1].resolve({ model: 'character', face: { holdProb: 0.1, raw: [0.4, 0, 0, 0, 0] } }); await tick();
    assert.equal(faces.at(-1).happy, 0.4);
    assert.ok(!statuses.includes('Automatic expressions unavailable'));
    expressions.transcript('The new reply continues a little further'); clock.advance(350);
    expressions.interrupt();
    requests[2].resolve({ model: 'character', face: { holdProb: 0.1, raw: [0, 0.4, 0, 0, 0] } }); await tick();
    assert.equal(faces.length, 1, 'late success is discarded too');
  } finally { expressions.stop(); }
});

test('the last spoken prefix may finish, then the face settles; new replies cancel the old settling timer', async () => {
  const clock = fakeClock(), faces = [], settles = [];
  let resolveFace;
  const { createAutomaticExpressions } = await load('assistant/automatic-expressions.js', clock.globals);
  const expressions = createAutomaticExpressions({ onExpressionWeights: w => faces.push(w), onExpressionSettle: s => settles.push(s) },
    payload => !payload.prefix ? Promise.resolve({ model: 'character', face: null }) : new Promise(resolve => { resolveFace = resolve; }));
  try {
    await expressions.setEnabled(true);
    expressions.transcript('I am happy to hear that', true); expressions.endReply();
    clock.advance(350);
    resolveFace({ model: 'character', face: { holdProb: 0.1, raw: [0.4, 0, 0, 0, 0] } }); await tick();
    assert.equal(faces.at(-1).happy, 0.4);
    clock.advance(1649); assert.deepEqual(settles, []);
    clock.advance(1); assert.deepEqual(settles, [1.5]);
    expressions.transcript('Another reply', true); expressions.endReply();
    clock.advance(1000);
    expressions.transcript('The next reply starts', true);
    clock.advance(1000);
    assert.deepEqual(settles, [1.5], 'the preceding reply cannot settle the current face');
  } finally { expressions.stop(); }
});
