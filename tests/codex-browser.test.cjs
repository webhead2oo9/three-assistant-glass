const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./browser-modules.cjs');

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

async function harness({ permission, allocation, answer = true, answerSdp = 'v=0\r\nserver-answer', gathering = false } = {}) {
  const requests = [], sources = [], peers = [], audios = [], contexts = [], ends = [], statuses = [], texts = [], speakers = [];
  const listeners = new Map(), taskHandlers = [];
  const micTrack = { stopped: false, stop() { this.stopped = true; } };
  const mic = { getTracks: () => [micTrack], getAudioTracks: () => [micTrack] };
  let sessionCounter = 0;
  class Events {
    constructor(url) { this.url = url; sources.push(this); queueMicrotask(() => this.emit('ready')); }
    emit(type, fields = {}) { this.onmessage?.({ data: JSON.stringify({ type, ...fields }) }); }
    close() { this.closed = true; }
  }
  class Peer {
    connectionState = 'new';
    iceGatheringState = gathering ? 'gathering' : 'complete';
    constructor(options) { this.options = options; peers.push(this); }
    addTrack() { this.hasTrack = true; }
    createDataChannel(name) {
      this.channel = name;
      return this.dataChannel = { close() { this.closed = true; } };
    }
    async createOffer() {
      assert.equal(this.hasTrack, true);
      assert.equal(this.channel, 'oai-events');
      return { type: 'offer', sdp: 'v=0\r\nbrowser-offer' };
    }
    async setLocalDescription(offer) { this.local = offer; this.localDescription = offer; }
    finishGathering(sdp) {
      this.localDescription = { type: 'offer', sdp };
      this.iceGatheringState = 'complete';
      this.onicegatheringstatechange?.();
    }
    async setRemoteDescription(description) {
      this.remote = description;
      this.ontrack({ track: { kind: 'audio' }, streams: [{}] });
      this.connectionState = 'connected'; this.onconnectionstatechange();
    }
    close() { this.connectionState = 'closed'; this.closed = true; this.onconnectionstatechange?.(); }
  }
  class AudioContext {
    constructor() { contexts.push(this); }
    async resume() {}
    async close() { this.closed = true; }
    createAnalyser() { return { fftSize: 512, getByteTimeDomainData: samples => samples.fill(144) }; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  }
  const api = async (url, body, options) => {
    requests.push({ url, body, options });
    if (url === '/account') return { account: { type: 'chatgpt' } };
    if (url === '/sessions') return allocation ? allocation.promise : { sessionId: `session-${++sessionCounter}` };
    if ((url.endsWith('/start') || url.endsWith('/reconnect')) && answer) sources.at(-1).emit('thread/realtime/sdp', { sdp: answerSdp });
    return {};
  };
  const module = await load('assistant/codex.js', {
    window: { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) },
    navigator: { mediaDevices: { getUserMedia: () => permission ? permission.promise : Promise.resolve(mic) } },
    AudioContext, RTCPeerConnection: Peer, EventSource: Events,
    performance: { now: () => 1000 },
    document: { createElement: () => {
      const audio = { play: async () => { audio.played = true; }, pause() { this.paused = true; } };
      audios.push(audio); return audio;
    } },
  }, { 'assistant/codex-api.js': { codexRequest: api },
    'assistant/codex-tasks.js': { createCodexTaskHandler: id => {
      const handler = { id, messages: [], handle(message) {
        if (!message.type.startsWith('codex/task/')) return false;
        this.messages.push(message); return true;
      }, close(reason) { this.closed = true; this.reason = reason; } };
      taskHandlers.push(handler); return handler;
    } },
  });
  const assistant = module.createCodexAssistant({}, {
    onStatus: text => statuses.push(text), onText: text => texts.push(text),
    onSpeaker: speaker => speakers.push(speaker), onEnd: error => ends.push(error), onError() {},
  });
  return { assistant, requests, sources, peers, audios, contexts, ends, statuses, texts, speakers, mic, micTrack, listeners, taskHandlers };
}

test('browser negotiates WebRTC, plays remote audio, displays transcripts and animates speech', async () => {
  const h = await harness(); await h.assistant.start();
  assert.equal(h.statuses.at(-1), 'Listening…');
  assert.equal(h.peers[0].remote.sdp, 'v=0\r\nserver-answer');
  assert.equal(h.audios[0].played, true);
  assert.equal(typeof h.peers[0].dataChannel.onmessage, 'function');
  assert.equal(h.requests.find(r => r.url.endsWith('/start')).body.sdp, 'v=0\r\nbrowser-offer');
  h.sources[0].emit('thread/realtime/transcript/delta', { role: 'assistant', delta: 'Hello ' });
  h.sources[0].emit('thread/realtime/transcript/delta', { role: 'assistant', delta: 'there' });
  h.sources[0].emit('thread/realtime/transcript/done', { role: 'assistant', text: 'Hello there!' });
  h.sources[0].emit('thread/realtime/transcript/delta', { role: 'user', delta: 'Hi' });
  assert.deepEqual(h.texts, ['Hello ', 'Hello there', 'Hello there!', 'Hi']);
  assert.deepEqual(h.speakers, ['Character', 'Character', 'Character', 'User']);
  assert.ok(h.assistant.mouthLevel() > 0);
  assert.equal(h.statuses.at(-1), 'Speaking…');
  h.assistant.addSystemMessage('Clipboard context');
  assert.equal(h.requests.at(-1).url, '/sessions/session-1/context');
  h.assistant.stop();
  assert.equal(h.micTrack.stopped, true);
  assert.equal(h.peers[0].closed, true);
  assert.equal(h.peers[0].dataChannel.closed, true);
  assert.equal(h.sources[0].closed, true);
  assert.equal(h.contexts[0].closed, true);
  assert.equal(h.audios[0].srcObject, null);
  assert.equal(h.requests.at(-1).options.keepalive, true);
  assert.equal(h.assistant.mouthLevel(), 0);
  assert.equal(h.taskHandlers[0].closed, true);
});

test('task events go only to the dedicated handler and do not replace speech', async () => {
  const h = await harness(); await h.assistant.start();
  h.sources[0].emit('codex/task/output', { itemId: 'task', text: 'Task result' });
  assert.equal(h.taskHandlers[0].messages[0].text, 'Task result');
  assert.deepEqual(h.texts, []);
  assert.equal(h.micTrack.stopped, false);
  h.assistant.stop();
});

test('voice sends the gathered ICE description', async () => {
  const h = await harness({ gathering: true });
  const starting = h.assistant.start();
  await tick();
  assert.equal(h.requests.some(r => r.url.endsWith('/start')), false);
  h.peers[0].finishGathering('v=0\r\ngathered-offer');
  await starting;
  assert.equal(h.requests.find(r => r.url.endsWith('/start')).body.sdp, 'v=0\r\ngathered-offer');
  h.assistant.stop();
});

test('Stop during ICE gathering cannot start a late voice call', async () => {
  const h = await harness({ gathering: true });
  const starting = h.assistant.start();
  const rejected = assert.rejects(starting, { name: 'AbortError' });
  await tick();
  h.assistant.stop();
  await rejected;
  assert.equal(h.requests.some(r => r.url.endsWith('/start')), false);
  assert.equal(h.peers[0].onicegatheringstatechange, null);
  assert.equal(h.micTrack.stopped, true);
});

test('interleaved user transcripts cannot replace a streaming assistant reply', async () => {
  const h = await harness(); await h.assistant.start();
  const emit = (part, role, value) => h.sources[0].emit(`thread/realtime/transcript/${part}`, {
    role, [part === 'done' ? 'text' : 'delta']: value,
  });
  emit('delta', 'user', 'Question');
  emit('delta', 'assistant', 'Answer ');
  emit('delta', 'user', ' revised');
  emit('done', 'user', 'Question revised?');
  emit('delta', 'assistant', 'continues');
  emit('done', 'assistant', 'Answer continues.');
  emit('done', 'user', 'Late question final');
  assert.deepEqual(h.texts, ['Question', 'Answer ', 'Answer continues', 'Answer continues.']);
  emit('delta', 'user', 'Next question');
  emit('done', 'assistant', 'Late answer final');
  assert.equal(h.texts.at(-1), 'Next question');
  assert.equal(h.speakers.at(-1), 'User');
  h.assistant.stop();
});

test('Stop releases a microphone granted after permission was pending', async () => {
  const permission = deferred();
  const h = await harness({ permission });
  const starting = h.assistant.start();
  const rejected = assert.rejects(starting, { name: 'AbortError' });
  await tick(); h.assistant.stop(); permission.resolve(h.mic); await rejected;
  assert.equal(h.micTrack.stopped, true);
  assert.equal(h.requests.some(r => r.url === '/sessions'), false);
});

test('Stop releases a server allocation returned after cancellation', async () => {
  const allocation = deferred();
  const h = await harness({ allocation });
  const starting = h.assistant.start();
  const rejected = assert.rejects(starting, { name: 'AbortError' });
  await tick(); h.assistant.stop(); allocation.resolve({ sessionId: 'late-session' }); await rejected;
  assert.equal(h.requests.at(-1).url, '/sessions/late-session/stop');
  assert.equal(h.sources.length, 0);
  assert.equal(h.micTrack.stopped, true);
});

test('Stop during SDP negotiation rejects startup and ignores late signaling', async () => {
  const h = await harness({ answer: false });
  const starting = h.assistant.start();
  const rejected = assert.rejects(starting, { name: 'AbortError' });
  await tick(); h.assistant.stop();
  h.sources[0].emit('thread/realtime/sdp', { sdp: 'v=0\r\nlate' });
  await rejected;
  assert.equal(h.peers[0].remote, undefined);
  assert.equal(h.audios[0].played, undefined);
  assert.equal(h.micTrack.stopped, true);
});

test('fatal control errors close media, retain the error, and notify the main UI', async () => {
  const h = await harness(); await h.assistant.start();
  h.sources[0].emit('error', { message: 'Voice access unavailable' });
  assert.equal(h.ends[0].message, 'Voice access unavailable');
  assert.equal(h.micTrack.stopped, true);
  assert.equal(h.taskHandlers[0].reason, 'Voice access unavailable');
  h.sources[0].emit('thread/realtime/transcript/delta', { role: 'assistant', delta: 'stale' });
  assert.deepEqual(h.texts, []);
});

test('lost realtime transport reconnects without losing the mic, task panel, or local session', async () => {
  const h = await harness(); await h.assistant.start();
  h.sources[0].emit('codex/task/output', { itemId: 'task', text: 'Search result' });
  h.sources[0].emit('thread/realtime/closed', { reason: 'transport_closed' });
  await tick();
  assert.equal(h.requests.filter(r => r.url.endsWith('/reconnect')).length, 1);
  assert.equal(h.requests.filter(r => r.url === '/sessions').length, 1);
  assert.equal(h.requests.some(r => r.url.endsWith('/stop')), false);
  assert.equal(h.peers.length, 2);
  assert.equal(h.peers[0].closed, true);
  assert.equal(h.peers[1].connectionState, 'connected');
  assert.equal(h.micTrack.stopped, false);
  assert.equal(h.taskHandlers.length, 1);
  assert.equal(h.taskHandlers[0].closed, undefined);
  assert.deepEqual(h.ends, []);
  h.sources[0].emit('codex/task/status', { turnId: 'turn', status: 'completed' });
  assert.equal(h.requests.some(r => r.url.endsWith('/stop')), false);
  h.assistant.stop();
});

test('repeated transport failure is bounded and leaves a persistent error', async () => {
  const h = await harness(); await h.assistant.start();
  for (let i = 0; i < 3; i++) {
    h.sources[0].emit('thread/realtime/closed', { reason: 'transport_closed' });
    await tick();
  }
  assert.equal(h.requests.filter(r => r.url.endsWith('/reconnect')).length, 2);
  assert.equal(h.ends.length, 1);
  assert.match(h.taskHandlers[0].reason, /transport_closed/);
  assert.equal(h.micTrack.stopped, true);
});

test('SSE errors during startup preserve the useful error and release resources', async () => {
  const h = await harness({ answer: false });
  const starting = h.assistant.start();
  const rejected = assert.rejects(starting, /Voice connection was lost/);
  await tick(); h.sources[0].onerror(); await rejected;
  assert.equal(h.micTrack.stopped, true);
  assert.equal(h.peers[0].closed, true);
});

test('page exit stops the server session and old callbacks cannot stop a restarted adapter', async () => {
  const h = await harness(); await h.assistant.start();
  const oldSource = h.sources[0];
  h.listeners.get('pagehide')();
  assert.equal(h.requests.at(-1).url, '/sessions/session-1/stop');
  await h.assistant.start();
  oldSource.onerror();
  assert.equal(h.peers[1].closed, undefined);
  assert.deepEqual(h.ends, []);
  h.assistant.stop();
});
