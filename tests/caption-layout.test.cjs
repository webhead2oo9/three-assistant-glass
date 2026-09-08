const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./browser-modules.cjs');

const measure = (s) => s.length * 10; // 10px per character
const snapshot = (value) => JSON.parse(JSON.stringify(value)); // arrays cross the vm realm

test('caption wraps on width, honours newlines, and breaks words wider than the plate', async () => {
  const { wrapLines } = await load('caption-layout.js');
  assert.deepEqual(snapshot(wrapLines('one two three four', measure, 100)), ['one two', 'three four']);
  assert.deepEqual(snapshot(wrapLines('Call started\n\nCall ended.', measure, 200)), ['Call started', '', 'Call ended.']);
  assert.deepEqual(snapshot(wrapLines('see https://example.com/x', measure, 100)), ['see', 'https://ex', 'ample.com/', 'x']);
  assert.deepEqual(snapshot(wrapLines('', measure, 100)), ['']);
});

test('caption keeps only the newest lines that fit on the plate', async () => {
  const { layoutCaption } = await load('caption-layout.js');
  const text = ['line 1', 'line 2', 'line 3', 'line 4', 'line 5'].join('\n');
  assert.deepEqual(snapshot(layoutCaption(text, { measure, maxWidth: 100, maxLines: 3 })), ['line 3', 'line 4', 'line 5']);
  assert.deepEqual(layoutCaption(text, { measure, maxWidth: 100, maxLines: 10 }).length, 5);
  // Never fewer than one line, even if the plate is absurdly short
  assert.deepEqual(snapshot(layoutCaption(text, { measure, maxWidth: 100, maxLines: 0 })), ['line 5']);
});
