const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./browser-modules.cjs');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tick = () => new Promise((resolve) => setImmediate(resolve));

function frame(amplitude) {
  const pcm = new Int16Array(480);
  for (let i = 0; i < pcm.length; i++) pcm[i] = i % 2 ? amplitude : -amplitude;
  return pcm.buffer;
}

async function harness(settings = {}) {
  const pcm = await load('assistant/realtime-audio.js', { atob, btoa });
  const sockets = [];
  class WebSocket {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    send(text) { this.sent.push(JSON.parse(text)); }
    close(code) { this.readyState = 3; this.closed = code; this.onclose?.({ code }); }
    open() { this.readyState = 1; this.onopen?.(); }
    receive(event) { this.onmessage?.({ data: JSON.stringify(event) }); }
    drop() { this.readyState = 3; this.onclose?.({ code: 1006 }); }
  }
  const audio = { played: [], stops: 0, playing: 0, destroyed: false, hooks: null };
  const fakeAudio = {
    createRealtimeAudio(hooks) {
      audio.hooks = hooks;
      return {
        async start() {},
        play(b64) { audio.played.push(b64); audio.playing++; },
        stopPlayback() { audio.stops++; audio.playing = 0; },
        isPlaying: () => audio.playing > 0,
        mouthLevel: () => 0.5,
        destroy() { audio.destroyed = true; },
      };
    },
    encodePcm16: pcm.encodePcm16,
    pcmLevel: pcm.pcmLevel,
  };
  const ui = { texts: [], speakers: [], statuses: [], errors: [] };
  Object.assign(ui, {
    onText: (t) => ui.texts.push(t),
    onSpeaker: (s) => ui.speakers.push(s),
    onStatus: (s) => ui.statuses.push(s),
    onError: (e) => ui.errors.push(e),
  });
  const module = await load('assistant/realtime.js', { WebSocket, location: { protocol: 'http:', host: 'localhost:3000' } }, {
    'assistant/realtime-audio.js': fakeAudio,
    'assistant/automatic-expressions.js': { createAutomaticExpressions: () => ({ async setEnabled() {}, transcript() {}, reset() {}, stop() {} }) },
  });
  const assistant = module.createRealtimeAssistant({ realtimeFirstMessage: 'Hi there!', ...settings }, ui);
  return { assistant, sockets, audio, ui, module };
}

async function started(h) {
  const starting = h.assistant.start();
  await tick();
  const socket = h.sockets[0];
  socket.open();
  socket.receive({ type: 'conversation.created', conversation: { id: 'conv_1' } });
  socket.receive({ type: 'session.updated', session: {} });
  await starting;
  return socket;
}

test('start resolves on session.updated, flushes buffered audio and queued context, and speaks the first message', async () => {
  const h = await harness();
  const starting = h.assistant.start();
  await tick();
  const socket = h.sockets[0];
  assert.equal(socket.url, 'ws://localhost:3000/api/assistant/realtime');
  socket.open();
  h.audio.hooks.onChunk(frame(1000));        // before the session is ready → held back
  h.assistant.addSystemMessage('Clipboard: hello');
  assert.deepEqual(socket.sent, []);

  socket.receive({ type: 'session.updated', session: {} });
  await starting;
  const types = socket.sent.map((f) => f.type);
  assert.deepEqual(types, ['input_audio_buffer.append', 'conversation.item.create', 'conversation.item.create']);
  assert.equal(socket.sent[0].audio.length, 1280); // 480 samples × 2 bytes, base64
  assert.equal(socket.sent[1].item.role, 'system');
  assert.equal(socket.sent[2].item.type, 'force_message');
  assert.equal(socket.sent[2].item.content[0].text, 'Hi there!');
  assert.equal(h.ui.statuses.at(-1), 'Listening…');

  h.audio.hooks.onChunk(frame(1000));        // live audio goes straight through
  assert.equal(socket.sent.at(-1).type, 'input_audio_buffer.append');
  await sleep(100);
  assert.equal(h.ui.texts.at(-1), 'Hi there!');
  assert.equal(h.assistant.mouthLevel(), 0.5);
});

test('replies play and caption as they stream; speaking over one drops its remaining audio', async () => {
  const h = await harness();
  const socket = await started(h);
  socket.receive({ type: 'response.created', response: { id: 'r1' } });
  assert.equal(h.ui.statuses.at(-1), 'Thinking…');
  socket.receive({ type: 'response.output_audio.delta', delta: 'AAAA' });
  socket.receive({ type: 'response.output_audio_transcript.delta', delta: 'The weather ' });
  socket.receive({ type: 'response.output_audio_transcript.delta', delta: 'is sunny.' });
  assert.deepEqual(h.audio.played, ['AAAA']);
  assert.equal(h.ui.statuses.at(-1), 'Speaking…');
  assert.equal(h.ui.speakers.at(-1), 'Character');
  await sleep(100);
  assert.equal(h.ui.texts.at(-1), 'The weather is sunny.');

  socket.receive({ type: 'input_audio_buffer.speech_started', audio_start_ms: 10 });
  assert.equal(h.audio.stops, 1);
  assert.equal(h.ui.speakers.at(-1), 'User');
  socket.receive({ type: 'response.output_audio.delta', delta: 'BBBB' }); // tail of the interrupted reply
  assert.deepEqual(h.audio.played, ['AAAA']);
  socket.receive({ type: 'conversation.item.input_audio_transcription.updated', transcript: 'Actually, ' });
  socket.receive({ type: 'response.done', response: { id: 'r1' } });
  assert.equal(h.ui.statuses.at(-1), 'Listening…');

  socket.receive({ type: 'response.created', response: { id: 'r2' } });
  socket.receive({ type: 'response.output_audio.delta', delta: 'CCCC' });
  assert.deepEqual(h.audio.played, ['AAAA', 'CCCC']);
  socket.receive({ type: 'response.done', response: { id: 'r2' } });
  assert.equal(h.ui.statuses.at(-1), 'Speaking…'); // still playing the buffered audio
  h.audio.playing = 0;
  h.audio.hooks.onPlaybackEnd();
  assert.equal(h.ui.statuses.at(-1), 'Listening…');
  socket.receive({ type: 'tool', tool: { name: 'get_time', label: 'Checking the time…' } });
  assert.equal(h.ui.statuses.at(-1), 'Checking the time…');
});

test('an idle session hangs up and reconnects with the conversation id when someone talks', async () => {
  const h = await harness({ realtimeIdleSeconds: 0.05 });
  const socket = await started(h);
  await sleep(90);
  assert.equal(socket.closed, 1000);
  assert.match(h.ui.statuses.at(-1), /^Idle/);
  assert.equal(h.sockets.length, 1);

  for (let i = 0; i < 3; i++) h.audio.hooks.onChunk(frame(0));    // silence: stay dormant
  assert.equal(h.sockets.length, 1);
  for (let i = 0; i < 5; i++) h.audio.hooks.onChunk(frame(8000)); // speech: reconnect
  assert.equal(h.sockets.length, 2);
  const resumed = h.sockets[1];
  assert.equal(resumed.url, 'ws://localhost:3000/api/assistant/realtime?conversation_id=conv_1');
  assert.equal(h.ui.statuses.at(-1), 'Connecting…');
  resumed.open();
  resumed.receive({ type: 'session.updated', session: {} });
  // The frames heard while reconnecting arrive first; no second greeting
  assert.ok(resumed.sent.length >= 5);
  assert.ok(resumed.sent.every((f) => f.type === 'input_audio_buffer.append'));
  assert.equal(h.ui.statuses.at(-1), 'Listening…');
  h.assistant.stop();
  assert.equal(h.audio.destroyed, true);
});

test('a failed first connection rejects start with the server\'s reason; a later drop just waits for speech', async () => {
  const h = await harness();
  const starting = h.assistant.start();
  await tick();
  const socket = h.sockets[0];
  socket.open();
  socket.receive({ type: 'error', error: { message: 'xAI realtime 401: bad key' } });
  socket.drop();
  await assert.rejects(starting, /401: bad key/);
  assert.deepEqual(h.ui.errors, []); // reported once, through start()
  h.assistant.stop();

  const later = await harness();
  const live = await started(later);
  live.drop();
  assert.deepEqual(later.ui.errors, []);
  assert.match(later.ui.statuses.at(-1), /^Disconnected/);
  for (let i = 0; i < 5; i++) later.audio.hooks.onChunk(frame(8000));
  assert.equal(later.sockets.length, 2);
  later.assistant.stop();
});
