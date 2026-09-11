const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./browser-modules.cjs');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tick = () => new Promise((resolve) => setImmediate(resolve));
const SETTLE_MS = 200; // reveal interval + caption throttle
const assistants = [];
afterEach(() => { for (const assistant of assistants.splice(0)) assistant.stop(); }); // a failed test must not leak timers

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
  // Fake audio with a controllable timeline: `played` / `received` seconds
  const audio = { played: [], stops: 0, playing: 0, destroyed: false, hooks: null, playedSeconds: 0, receivedSeconds: 0 };
  const fakeAudio = {
    createRealtimeAudio(hooks) {
      audio.hooks = hooks;
      return {
        async start() {},
        play(b64) { audio.played.push(b64); audio.playing++; audio.receivedSeconds += 1; },
        stopPlayback() { audio.stops++; audio.playing = 0; audio.receivedSeconds = audio.playedSeconds; },
        isPlaying: () => audio.playing > 0,
        timeline: () => ({ played: audio.playedSeconds, received: audio.receivedSeconds }),
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
  const module = await load('assistant/realtime.js', {
    WebSocket, setInterval, clearInterval, location: { protocol: 'http:', host: 'localhost:3000' },
  }, {
    'assistant/realtime-audio.js': fakeAudio,
    'assistant/automatic-expressions.js': { createAutomaticExpressions: () => ({ async setEnabled() {}, transcript() {}, reset() {}, stop() {} }) },
  });
  const assistant = module.createRealtimeAssistant({ llmFirstMessage: 'Hi there!', ...settings }, ui);
  assistants.push(assistant);
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

test('start resolves on session.updated, flushes buffered audio and queued context, and greets with a force message on xAI', async () => {
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
  assert.deepEqual(types, ['conversation.item.create', 'input_audio_buffer.append', 'conversation.item.create']);
  assert.equal(socket.sent[0].item.role, 'system');
  assert.equal(socket.sent[1].audio.length, 1280); // 480 samples × 2 bytes, base64
  assert.equal(socket.sent[2].item.type, 'force_message');
  assert.equal(socket.sent[2].item.content[0].text, 'Hi there!');
  assert.equal(h.ui.statuses.at(-1), 'Listening…');

  h.audio.hooks.onChunk(frame(1000));        // live audio goes straight through
  assert.equal(socket.sent.at(-1).type, 'input_audio_buffer.append');
  assert.equal(h.assistant.mouthLevel(), 0.5);
  // The greeting is captioned as its audio plays, not up front
  await sleep(100);
  assert.deepEqual(h.ui.texts, []);
  h.audio.playedSeconds = 5;
  await sleep(SETTLE_MS);
  assert.equal(h.ui.texts.at(-1), 'Hi there!');
  h.assistant.stop();
});

test('OpenAI greets through a response and shows user transcript deltas as they come', async () => {
  const h = await harness({ realtimeProvider: 'openai' });
  const socket = await started(h);
  assert.equal(socket.sent.at(-1).type, 'response.create');
  assert.match(socket.sent.at(-1).response.instructions, /Hi there!/);
  socket.receive({ type: 'input_audio_buffer.speech_started' });
  socket.receive({ type: 'conversation.item.input_audio_transcription.delta', delta: 'What ' });
  socket.receive({ type: 'conversation.item.input_audio_transcription.delta', delta: 'time is it?' });
  await sleep(100);
  assert.equal(h.ui.texts.at(-1), 'What time is it?');
  assert.equal(h.ui.speakers.at(-1), 'User');
  h.assistant.stop();
});

test('captions keep pace with playback; speaking over a reply drops its remaining audio and freezes the caption', async () => {
  const h = await harness({ llmFirstMessage: '' });
  const socket = await started(h);
  socket.receive({ type: 'response.created', response: { id: 'r1' } });
  assert.equal(h.ui.statuses.at(-1), 'Thinking…');
  socket.receive({ type: 'response.output_audio.delta', delta: 'AAAA' });
  socket.receive({ type: 'response.output_audio_transcript.delta', delta: 'The weather today ' });
  socket.receive({ type: 'response.output_audio_transcript.delta', delta: 'is sunny and warm.' });
  assert.deepEqual(h.audio.played, ['AAAA']);
  assert.equal(h.ui.statuses.at(-1), 'Speaking…');
  assert.equal(h.ui.speakers.at(-1), 'Character');
  await sleep(100);
  assert.deepEqual(h.ui.texts, []);                      // nothing heard yet
  h.audio.playedSeconds = 1;                             // 15 chars/s → "The weather" (cut at a word)
  await sleep(SETTLE_MS);
  assert.equal(h.ui.texts.at(-1), 'The weather');

  socket.receive({ type: 'input_audio_buffer.speech_started', audio_start_ms: 10 });
  assert.equal(h.audio.stops, 1);
  assert.equal(h.ui.speakers.at(-1), 'User');
  socket.receive({ type: 'response.output_audio.delta', delta: 'BBBB' }); // tail of the interrupted reply
  assert.deepEqual(h.audio.played, ['AAAA']);
  h.audio.playedSeconds = 3;
  await sleep(SETTLE_MS);
  assert.equal(h.ui.texts.at(-1), 'The weather');        // frozen where it was interrupted
  socket.receive({ type: 'response.done', response: { id: 'r1' } });
  assert.equal(h.ui.statuses.at(-1), 'Listening…');

  socket.receive({ type: 'response.created', response: { id: 'r2' } });
  socket.receive({ type: 'response.output_audio.delta', delta: 'CCCC' });
  socket.receive({ type: 'response.output_audio_transcript.delta', delta: 'Sure, anything else you need today?' });
  assert.deepEqual(h.audio.played, ['AAAA', 'CCCC']);
  socket.receive({ type: 'response.done', response: { id: 'r2' } });
  assert.equal(h.ui.statuses.at(-1), 'Speaking…');       // still playing the buffered audio
  h.audio.playing = 0;
  h.audio.playedSeconds = h.audio.receivedSeconds;
  h.audio.hooks.onPlaybackEnd();
  await sleep(SETTLE_MS);
  assert.equal(h.ui.texts.at(-1), 'Sure, anything else you need today?'); // full text once heard
  assert.equal(h.ui.statuses.at(-1), 'Listening…');
  socket.receive({ type: 'tool', tool: { name: 'get_time', label: 'Checking the time…' } });
  assert.equal(h.ui.statuses.at(-1), 'Checking the time…');
  h.assistant.stop();
});

test('an idle xAI session hangs up and reconnects with the conversation id when someone talks', async () => {
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
  // The frames heard while reconnecting arrive first; no replay, no second greeting
  assert.ok(resumed.sent.length >= 5);
  assert.ok(resumed.sent.every((f) => f.type === 'input_audio_buffer.append'));
  assert.equal(h.ui.statuses.at(-1), 'Listening…');
  h.assistant.stop();
  assert.equal(h.audio.destroyed, true);
});

test('an idle OpenAI session replays the transcript when it reconnects', async () => {
  const h = await harness({ realtimeProvider: 'openai', realtimeIdleSeconds: 0.05 });
  const socket = await started(h);
  socket.receive({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'What time is it?' });
  socket.receive({ type: 'response.created', response: { id: 'r1' } });
  socket.receive({ type: 'response.output_audio_transcript.delta', delta: 'It is noon.' });
  socket.receive({ type: 'response.done', response: { id: 'r1' } });
  await sleep(90);
  assert.equal(socket.closed, 1000);
  for (let i = 0; i < 5; i++) h.audio.hooks.onChunk(frame(8000));
  const resumed = h.sockets[1];
  assert.equal(resumed.url, 'ws://localhost:3000/api/assistant/realtime');
  resumed.open();
  resumed.receive({ type: 'session.updated', session: {} });
  const items = resumed.sent.filter((f) => f.type === 'conversation.item.create').map((f) => [f.item.role, f.item.content[0].type, f.item.content[0].text]);
  assert.deepEqual(items, [
    ['assistant', 'output_text', 'Hi there!'],
    ['user', 'input_text', 'What time is it?'],
    ['assistant', 'output_text', 'It is noon.'],
  ]);
  assert.equal(resumed.sent.findIndex((f) => f.type === 'input_audio_buffer.append') > 2, true);
  h.assistant.stop();
});

test('a failed first connection rejects start with the server\'s reason; a later drop just waits for speech', async () => {
  const h = await harness();
  const starting = h.assistant.start();
  await tick();
  const socket = h.sockets[0];
  socket.open();
  socket.receive({ type: 'error', error: { message: 'xai realtime 401: bad key' } });
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
