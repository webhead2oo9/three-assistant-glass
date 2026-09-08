const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const CONNECTING = 0, OPEN = 1, CLOSED = 3;
const tick = () => new Promise((resolve) => setImmediate(resolve));

class FakeSocket extends EventEmitter {
  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.readyState = CONNECTING;
    this.sent = [];
    this.closed = null;
    this.terminated = false;
  }
  open() { this.readyState = OPEN; this.emit('open'); }
  send(text) { this.sent.push(text); }
  close(code, reason) { this.readyState = CLOSED; this.closed = { code, reason }; this.emit('close', code); }
  terminate() { this.terminated = true; this.readyState = CLOSED; this.emit('close', 1006); }
  frames() { return this.sent.map((text) => JSON.parse(text)); }
  receive(payload) { this.emit('message', Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload))); }
}

function fakeTools(calls = []) {
  return {
    definitions: () => [{ type: 'function', function: { name: 'get_time', description: 'time', parameters: { type: 'object', properties: {} } } }],
    label: (name) => `Running ${name}`,
    async run(name, args) { calls.push({ name, args }); return { time: '3:42 PM' }; },
  };
}

async function harness(settings, { tools = fakeTools(), request } = {}) {
  const { createRealtimeBridge, realtimeConfig } = await import('../server/realtime.mjs');
  const upstreams = [];
  const bridge = createRealtimeBridge({
    config: () => realtimeConfig(settings),
    tools,
    WebSocketImpl: class extends FakeSocket { constructor(...args) { super(...args); upstreams.push(this); } },
    log: { log() {}, error() {} },
  });
  const browser = new FakeSocket('ws://localhost/api/assistant/realtime');
  browser.readyState = OPEN;
  bridge.connect(browser, request || { url: '/api/assistant/realtime' });
  return { browser, upstream: upstreams[0], upstreams };
}

test('opens xAI with the key, model and resume id, then configures the session with rendered instructions and flat tools', async () => {
  const h = await harness(
    { llmApiKey: 'xai-key', realtimeVoice: 'ara', realtimeInstructions: 'Today is {{date}}. Be brief.', assistantLanguage: 'en-US' },
    { request: { url: '/api/assistant/realtime?conversation_id=conv_1' } },
  );
  const url = new URL(h.upstream.url);
  assert.equal(url.origin + url.pathname, 'wss://api.x.ai/v1/realtime');
  assert.equal(url.searchParams.get('model'), 'grok-voice-latest');
  assert.equal(url.searchParams.get('conversation_id'), 'conv_1');
  assert.equal(h.upstream.options.headers.Authorization, 'Bearer xai-key');

  h.upstream.open();
  const [update] = h.upstream.frames();
  assert.equal(update.type, 'session.update');
  assert.equal(update.session.voice, 'ara');
  assert.match(update.session.instructions, /^Today is \w+, \w+ \d+, \d{4}\. Be brief\.$/);
  assert.deepEqual(update.session.turn_detection, { type: 'server_vad' });
  assert.deepEqual(update.session.audio.input.format, { type: 'audio/pcm', rate: 24000 });
  assert.equal(update.session.audio.input.transcription.language_hint, 'en-US');
  assert.deepEqual(update.session.tools, [{ type: 'function', name: 'get_time', description: 'time', parameters: { type: 'object', properties: {} } }]);
  assert.deepEqual(update.session.resumption, { enabled: true });
});

test('the realtime key overrides the chat key, tools can be turned off, and instructions fall back to the chat prompt', async () => {
  const h = await harness({ llmApiKey: 'chat-key', realtimeApiKey: 'voice-key', realtimeTools: false, llmSystemPrompt: 'Chat prompt', realtimeModel: 'grok-voice-think-fast-2.0' });
  assert.equal(h.upstream.options.headers.Authorization, 'Bearer voice-key');
  assert.equal(new URL(h.upstream.url).searchParams.get('model'), 'grok-voice-think-fast-2.0');
  h.upstream.open();
  const [update] = h.upstream.frames();
  assert.equal(update.session.instructions, 'Chat prompt');
  assert.equal(update.session.tools, undefined);
  assert.equal(update.session.audio.input.transcription, undefined);
});

test('browser frames sent before the upstream opens are delivered after the session config, and events flow back verbatim', async () => {
  const h = await harness({ llmApiKey: 'k' });
  h.browser.receive({ type: 'input_audio_buffer.append', audio: 'AAAA' });
  assert.deepEqual(h.upstream.sent, []);
  h.upstream.open();
  assert.deepEqual(h.upstream.frames().map((f) => f.type), ['session.update', 'input_audio_buffer.append']);

  h.browser.receive({ type: 'response.cancel' });
  assert.equal(h.upstream.frames().at(-1).type, 'response.cancel');

  h.upstream.receive({ type: 'response.output_audio.delta', delta: 'UklG' });
  assert.deepEqual(h.browser.frames(), [{ type: 'response.output_audio.delta', delta: 'UklG' }]);
});

test('function calls run on the server, feed the result back and ask for the next response', async () => {
  const calls = [];
  const h = await harness({ llmApiKey: 'k' }, { tools: fakeTools(calls) });
  h.upstream.open();
  h.upstream.receive({ type: 'response.function_call_arguments.done', call_id: 'call_9', name: 'get_time', arguments: '{}' });
  await tick();
  assert.deepEqual(calls, [{ name: 'get_time', args: {} }]);
  const frames = h.upstream.frames().slice(1);
  assert.deepEqual(frames, [
    { type: 'conversation.item.create', item: { type: 'function_call_output', call_id: 'call_9', output: JSON.stringify({ time: '3:42 PM' }) } },
    { type: 'response.create' },
  ]);
  assert.deepEqual(h.browser.frames().map((f) => f.type), ['response.function_call_arguments.done', 'tool']);
  assert.deepEqual(h.browser.frames()[1].tool, { name: 'get_time', label: 'Running get_time' });

  h.upstream.receive({ type: 'response.function_call_arguments.done', call_id: 'call_10', name: 'get_time', arguments: '{bad' });
  await tick();
  assert.equal(calls.length, 1);
  assert.match(JSON.parse(h.upstream.frames().at(-2).item.output).error, /not valid JSON/);
});

test('a missing key or a refused handshake reaches the browser as an error before the socket closes', async () => {
  const none = await harness({});
  assert.equal(none.upstreams.length, 0);
  assert.match(none.browser.frames()[0].error.message, /No xAI API key/);
  assert.equal(none.browser.closed.code, 1011);

  const h = await harness({ llmApiKey: 'bad' });
  const res = new EventEmitter();
  res.statusCode = 401;
  h.upstream.emit('unexpected-response', {}, res);
  res.emit('data', '{"error":"Invalid API key"}');
  res.emit('end');
  assert.deepEqual(h.browser.frames()[0], { type: 'error', error: { message: 'xAI realtime 401: {"error":"Invalid API key"}' } });
  assert.equal(h.browser.closed.code, 1011);
});

test('closing either side closes the other', async () => {
  const a = await harness({ llmApiKey: 'k' });
  a.upstream.open();
  a.browser.close(1000);
  assert.equal(a.upstream.closed.code, 1000);

  const b = await harness({ llmApiKey: 'k' });
  b.browser.close(1000); // hung up while still connecting
  assert.equal(b.upstream.terminated, true);

  const c = await harness({ llmApiKey: 'k' });
  c.upstream.open();
  c.upstream.close(1000);
  assert.equal(c.browser.closed.code, 1000);
});
