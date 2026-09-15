const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./browser-modules.cjs');

test('face decoding follows the contract: threshold, deadzone, grid, two channels, forbidden pairs', async () => {
  const { decodeFace, neutralFace } = await load('assistant/expression-decoder.js');
  const zero = neutralFace();
  assert.equal(decodeFace(0.95, [0.9, 0, 0, 0, 0], zero).action, 'hold');
  const set = decodeFace(0.2, [0.43, 0.01, 0.0, 0.13, 0.0], zero);
  assert.equal(set.action, 'set');
  assert.equal(JSON.stringify(set.weights), JSON.stringify({ happy: 0.45, sad: 0, angry: 0, relaxed: 0.15, surprised: 0 }));
  // three channels above the deadzone keep the two strongest
  assert.equal(JSON.stringify(decodeFace(0.1, [0, 0.4, 0, 0.2, 0.3], zero).weights), JSON.stringify({ happy: 0, sad: 0.4, angry: 0, relaxed: 0, surprised: 0.3 }));
  // happy never beside sad; the stronger one wins
  assert.equal(JSON.stringify(decodeFace(0.1, [0.3, 0.5, 0, 0, 0], zero).weights), JSON.stringify({ happy: 0, sad: 0.5, angry: 0, relaxed: 0, surprised: 0 }));
  // a decoded face equal to the current one is a hold, not a twitch
  const current = { happy: 0.45, sad: 0, angry: 0, relaxed: 0.15, surprised: 0 };
  assert.equal(decodeFace(0.2, [0.44, 0, 0, 0.14, 0], current).action, 'hold');
  // all below the deadzone from a visible face is a return to neutral
  assert.equal(JSON.stringify(decodeFace(0.2, [0.05, 0.1, 0, 0, 0], current).weights), JSON.stringify(zero));
});

test('the face tracker feeds its own decisions forward and enforces a dwell', async () => {
  const { createFaceTracker, wordCount, describeFace } = await load('assistant/expression-decoder.js');
  const tracker = createFaceTracker({ dwell: 6 });
  assert.equal(tracker.step(0.1, [0.4, 0, 0, 0, 0], 3).action, 'set');
  assert.equal(tracker.current().happy, 0.4);
  // a change two words later is suppressed by the dwell, and the current face is unchanged
  assert.equal(tracker.step(0.1, [0, 0.4, 0, 0, 0], 5).action, 'hold');
  assert.equal(tracker.current().happy, 0.4);
  assert.equal(tracker.step(0.1, [0, 0.4, 0, 0, 0], 9).action, 'set');
  assert.equal(describeFace(tracker.current()), 'sad 0.40');
  tracker.reset();
  assert.equal(describeFace(tracker.current()), 'neutral');
  assert.equal(wordCount('  two words '), 2);
  assert.equal(wordCount(''), 0);
});
