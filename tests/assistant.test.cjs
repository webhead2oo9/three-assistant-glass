const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { load } = require('./browser-modules.cjs');
const { fakeClock } = require('./fake-clock.cjs');

const root = path.resolve(__dirname, '..');
const tick = () => new Promise(resolve => setImmediate(resolve));
const snapshot = value => JSON.parse(JSON.stringify(value));
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

async function speakerHarness() {
  const requests = new Map(), sources = [], sentences = [], errors = [];
  let ends = 0;
  class AudioContext {
    state = 'running';
    createAnalyser() { return { connect() {}, fftSize: 512 }; }
    async decodeAudioData(data) { return data; }
    createBufferSource() {
      const source = { connect() {}, start() { sources.push(this); }, stop() { queueMicrotask(() => this.onended()); } };
      return source;
    }
    close() {}
  }
  const module = await load('assistant/tts.js', {
    AudioContext,
    fetch: (_, options) => {
      const request = { ...deferred(), signal: options.signal };
      requests.set(JSON.parse(options.body).text, request);
      // Deliberately ignore abort: cancellation must also tolerate late providers.
      return request.promise;
    },
  });
  const speaker = module.createSpeaker({}, {
    onSentence: text => sentences.push(text), onEnd: () => ends++, onError: err => errors.push(err),
  });
  const ready = text => requests.get(text).resolve({ ok: true, arrayBuffer: async () => text });
  return { speaker, requests, sources, sentences, errors, ready, ends: () => ends };
}

test('synthesis finishing out of order still plays sentences in order', async () => {
  const h = await speakerHarness();
  h.speaker.enqueue('first'); h.speaker.enqueue('second');
  assert.equal(h.speaker.isBusy(), true);
  assert.equal(h.speaker.isSpeaking(), false);
  h.ready('second'); await tick();
  assert.deepEqual(h.sentences, []);
  h.ready('first'); await tick();
  assert.deepEqual(h.sentences, ['first']);
  h.sources[0].onended(); await tick();
  assert.deepEqual(h.sentences, ['first', 'second']);
  h.sources[1].onended(); await tick();
  assert.equal(h.speaker.isBusy(), false);
  h.speaker.destroy();
});

test('a stalled cancelled synthesis cannot block or end the next playback', async () => {
  const h = await speakerHarness();
  h.speaker.enqueue('old'); h.speaker.cancel();
  assert.equal(h.requests.get('old').signal.aborted, true);
  h.speaker.enqueue('new'); h.ready('new'); await tick();
  assert.deepEqual(h.sentences, ['new']);
  h.ready('old'); await tick();
  assert.equal(h.speaker.isBusy(), true);
  assert.equal(h.ends(), 0);
  assert.deepEqual(h.sentences, ['new']);
  h.sources[0].onended(); await tick();
  assert.equal(h.ends(), 1);
  h.speaker.destroy();
});

test('cancelling playback does not let the old consumer steal new sentences', async () => {
  const h = await speakerHarness();
  h.speaker.enqueue('old'); h.ready('old'); await tick();
  h.speaker.cancel();
  h.speaker.enqueue('new first'); h.speaker.enqueue('new second');
  h.ready('new second'); await tick();
  assert.deepEqual(h.sentences, ['old']);
  h.ready('new first'); await tick();
  assert.deepEqual(h.sentences, ['old', 'new first']);
  h.sources[1].onended(); await tick();
  assert.deepEqual(h.sentences, ['old', 'new first', 'new second']);
  h.speaker.destroy();
});

test('late synthesis failures after destruction do not update the UI', async () => {
  const h = await speakerHarness();
  h.speaker.enqueue('old'); h.speaker.destroy();
  h.requests.get('old').reject(new Error('late failure')); await tick();
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.sentences, []);
});

test('browser speech is busy before onstart and ignores cancelled start events', async () => {
  const utterances = [], sentences = [];
  const module = await load('assistant/tts.js', {
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    performance,
    speechSynthesis: { getVoices: () => [], speak: utterance => utterances.push(utterance), cancel() {} },
  });
  const speaker = module.createSpeaker({ ttsProvider: 'browser' }, { onSentence: text => sentences.push(text) });
  speaker.enqueue('old');
  assert.equal(speaker.isBusy(), true);
  assert.equal(speaker.isSpeaking(), false);
  speaker.cancel(); speaker.enqueue('new');
  utterances[0].onstart(); utterances[0].onend();
  assert.deepEqual(sentences, []);
  assert.equal(speaker.isBusy(), true);
  utterances[1].onstart(); utterances[1].onend();
  assert.deepEqual(sentences, ['new']);
  assert.equal(speaker.isBusy(), false);
});

async function pipelineHarness(settings = {}, startup = Promise.resolve()) {
  const calls = [], queued = [], statuses = [], errors = [];
  const expressionInputs = [], expressionEvents = [];
  let hooks, speakerHooks, busy = false, cancels = 0;
  const speaker = {
    enqueue(text) { queued.push(text); busy = true; },
    cancel() { cancels++; queued.length = 0; busy = false; },
    destroy() {}, isSpeaking: () => false, isBusy: () => busy,
  };
  const module = await load('assistant/pipeline.js', {}, {
    'assistant/stt.js': { createStt: (_, h) => { hooks = h; return { start: () => startup, stop() {} }; } },
    'assistant/tts.js': { createSpeaker: (_, h) => { speakerHooks = h; return speaker; }, cleanForSpeech: text => text },
    'assistant/automatic-expressions.js': { createAutomaticExpressions: () => ({
      setEnabled() {}, transcript: (text, newTurn) => expressionInputs.push({ text, newTurn }), reset() {}, stop() {},
      interrupt: () => expressionEvents.push('interrupt'), endReply: () => expressionEvents.push('end'),
    }) },
    'assistant/llm.js': { streamChat: (messages, options) => {
      const call = { ...deferred(), messages: snapshot(messages), ...options };
      calls.push(call);
      return call.promise;
    } },
  });
  const ends = [];
  const assistant = module.createAssistant(settings, {
    onText() {}, onSpeaker() {}, onStatus: text => statuses.push(text), onError: err => errors.push(err),
    onEnd: err => ends.push(err),
  });
  return { assistant, calls, queued, statuses, errors, ends, expressionInputs, expressionEvents,
    hooks: () => hooks, speakerHooks: () => speakerHooks, cancels: () => cancels };
}

test('pipeline expressions follow played prefixes across sentences and stop on interruption', async () => {
  const h = await pipelineHarness(); await h.assistant.start();
  try {
    const reply = h.hooks().onUtterance('hello');
    h.calls[0].onDelta('First sentence. Second sentence.'); h.calls[0].resolve(); await reply;
    const voice = h.speakerHooks();
    voice.onSentence('First sentence.');
    assert.deepEqual(h.expressionInputs, []);
    voice.onProgress('First'); voice.onProgress('First sentence.');
    voice.onSentence('Second sentence.'); voice.onProgress('Second');
    assert.deepEqual(h.expressionInputs, [
      { text: 'First', newTurn: true }, { text: 'First sentence.', newTurn: false },
      { text: 'First sentence. Second', newTurn: false },
    ]);
    const next = h.hooks().onUtterance('interrupt');
    assert.ok(h.expressionEvents.includes('interrupt'));
    h.calls[1].resolve(); await next;
  } finally { h.assistant.stop(); }
});

test('buffer speech reports audio-clock progress, freezes on suspension, and cancels stale callbacks', async () => {
  const clock = fakeClock(), sources = [], heard = [];
  let context;
  const module = await load('assistant/tts.js', { ...clock.globals,
    AudioContext: class {
      currentTime = 0; state = 'running';
      constructor() { context = this; }
      createAnalyser() { return { connect() {} }; }
      async decodeAudioData() { return { duration: 4 }; }
      createBufferSource() {
        const node = { connect() {}, start() { sources.push(this); }, stop() {} }; return node;
      }
      close() {}
    },
    fetch: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) }),
  });
  const speaker = module.createSpeaker({}, { onProgress: text => heard.push(text) });
  try {
    speaker.enqueue('One two three four'); await tick();
    clock.advance(1000); assert.deepEqual(heard, []);
    context.currentTime = 1; clock.advance(80); assert.deepEqual(heard, ['One']);
    clock.advance(1000); assert.deepEqual(heard, ['One'], 'wall time cannot advance a suspended audio clock');
    speaker.cancel(); context.currentTime = 4; sources[0].onended(); clock.advance(1000); await tick();
    assert.deepEqual(heard, ['One'], 'cancel cannot reveal the unplayed remainder');
    speaker.enqueue('A new sentence'); await tick();
    context.currentTime = 8; sources[1].onended(); await tick();
    assert.equal(heard.at(-1), 'A new sentence');
  } finally { speaker.destroy(); }
});

test('browser speech uses native word boundaries and never reveals a cancelled remainder', async () => {
  const clock = fakeClock(), utterances = [], heard = [];
  const module = await load('assistant/tts.js', { ...clock.globals,
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    speechSynthesis: { getVoices: () => [], speak: u => utterances.push(u), cancel() {} },
  });
  const speaker = module.createSpeaker({ ttsProvider: 'browser' }, { onProgress: text => heard.push(text) });
  speaker.enqueue('One two three');
  const utterance = utterances[0]; utterance.onstart(); utterance.onboundary({ charIndex: 0 });
  clock.advance(2000); assert.deepEqual(heard, []);
  utterance.onboundary({ charIndex: 4 }); assert.deepEqual(heard, ['One']);
  speaker.cancel(); utterance.onboundary({ charIndex: 8 }); utterance.onend();
  assert.deepEqual(heard, ['One']); speaker.destroy();
});

test('browser voices without boundaries use a clock estimate that pauses with the utterance', async () => {
  const clock = fakeClock(), utterances = [], heard = [];
  const module = await load('assistant/tts.js', { ...clock.globals,
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    speechSynthesis: { getVoices: () => [], speak: u => utterances.push(u), cancel() {} },
  });
  const speaker = module.createSpeaker({ ttsProvider: 'browser' }, { onProgress: text => heard.push(text) });
  try {
    speaker.enqueue('This is a longer sentence'); utterances[0].onstart();
    clock.advance(400); assert.equal(heard.at(-1), 'This');
    utterances[0].onpause(); clock.advance(2000); assert.equal(heard.at(-1), 'This');
    utterances[0].onresume(); clock.advance(400); assert.equal(heard.at(-1), 'This is a');
    utterances[0].onend(); assert.equal(heard.at(-1), 'This is a longer sentence');
  } finally { speaker.destroy(); }
});

test('a new question cancels audio still synthesizing after the LLM finishes', async () => {
  const h = await pipelineHarness(); await h.assistant.start();
  const first = h.hooks().onUtterance('first question');
  h.calls[0].onDelta('First answer.'); h.calls[0].resolve(); await first;
  assert.deepEqual(h.queued, ['First answer.']);
  const second = h.hooks().onUtterance('second question');
  assert.equal(h.cancels(), 1);
  assert.deepEqual(h.queued, []);
  h.calls[1].resolve(); await second;
  h.assistant.stop();
});

test('interrupted history is finalized before the new request and late deltas are ignored', async () => {
  const h = await pipelineHarness(); await h.assistant.start();
  const first = h.hooks().onUtterance('first question');
  h.calls[0].onDelta('Partial first answer');
  const second = h.hooks().onUtterance('second question');
  assert.equal(h.calls[0].signal.aborted, true);
  assert.deepEqual(h.calls[1].messages.slice(1), [
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'Partial first answer' },
    { role: 'user', content: 'second question' },
  ]);
  h.calls[0].onDelta(' stale sentence. '); h.calls[0].resolve(); await first;
  assert.deepEqual(h.queued, []);
  h.calls[1].onDelta('Second answer.'); h.calls[1].resolve(); await second;
  const third = h.hooks().onUtterance('third question');
  assert.deepEqual(h.calls[2].messages.slice(1).map(m => m.content), [
    'first question', 'Partial first answer', 'second question', 'Second answer.', 'third question',
  ]);
  h.calls[2].resolve(); await third;
  h.assistant.stop();
});

test('stopping during assistant startup suppresses the greeting and listening status', async () => {
  const startup = deferred();
  const h = await pipelineHarness({ llmFirstMessage: 'Hello!' }, startup.promise);
  const starting = h.assistant.start(); h.assistant.stop();
  startup.resolve(); await starting;
  assert.deepEqual(h.statuses, []);
  assert.deepEqual(h.queued, []);
});

test('VAD arriving after stop is destroyed and its callbacks are ignored', async () => {
  const pending = deferred(); let vadHooks, destroys = 0, utterances = 0;
  const module = await load('assistant/stt.js', {}, {
    'assistant/vad.js': { createMicVad: h => { vadHooks = h; return pending.promise; } },
  });
  const stt = module.createStt({}, { onUtterance: () => utterances++ });
  const starting = stt.start(); stt.stop();
  assert.equal(vadHooks.signal.aborted, true);
  pending.resolve({ destroy() { destroys++; } }); await starting;
  await vadHooks.onSpeechEnd(new Float32Array(1));
  assert.equal(destroys, 1);
  assert.equal(utterances, 0);
});

test('transcription completing after stop cannot produce another utterance', async () => {
  const pending = deferred(); let vadHooks, signal, utterances = 0;
  const module = await load('assistant/stt.js', {
    fetch: (_, options) => { signal = options.signal; return pending.promise; },
  }, { 'assistant/vad.js': { createMicVad: async h => { vadHooks = h; return { destroy() {} }; } } });
  const stt = module.createStt({}, { onUtterance: () => utterances++ }); await stt.start();
  const transcribing = vadHooks.onSpeechEnd(new Float32Array(1)); stt.stop();
  assert.equal(signal.aborted, true);
  pending.resolve({ ok: true, json: async () => ({ text: 'late transcript' }) }); await transcribing;
  assert.equal(utterances, 0);
});

test('microphone permission resolving after cancellation releases its tracks', async () => {
  const permission = deferred(); let stops = 0, requested = false;
  const module = await load('assistant/vad.js', {
    document: { createElement: () => ({}), head: { appendChild: script => queueMicrotask(() => script.onload()) } },
    navigator: { mediaDevices: { getUserMedia: () => { requested = true; return permission.promise; } } },
    window: { vad: { MicVAD: { new: async options => { await options.getStream(); return {}; } } } },
  });
  const controller = new AbortController();
  const starting = module.createMicVad({ signal: controller.signal });
  const rejected = assert.rejects(starting, { name: 'AbortError' });
  await tick(); assert.equal(requested, true); controller.abort();
  permission.resolve({ getTracks: () => [{ stop() { stops++; } }] });
  await rejected; assert.ok(stops > 0);
});

test('microphone tracks stop immediately while VAD initialization is still pending', async () => {
  const initialized = deferred(); let stopped = false;
  const module = await load('assistant/vad.js', {
    document: { createElement: () => ({}), head: { appendChild: script => queueMicrotask(() => script.onload()) } },
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() { stopped = true; } }] }) } },
    window: { vad: { MicVAD: { new: async options => { await options.getStream(); return initialized.promise; } } } },
  });
  const controller = new AbortController();
  const starting = module.createMicVad({ signal: controller.signal });
  await tick(); controller.abort(); assert.equal(stopped, true);
  initialized.resolve({}); await starting;
});

test('a restarted session waits for shared VAD scripts to finish loading', async () => {
  const scripts = []; let initialized = 0;
  const module = await load('assistant/vad.js', {
    document: { createElement: () => ({}), head: { appendChild: script => scripts.push(script) } },
    window: { vad: { MicVAD: { new: async () => { initialized++; return {}; } } } },
  });
  const controller = new AbortController();
  const first = module.createMicVad({ signal: controller.signal });
  const rejected = assert.rejects(first, { name: 'AbortError' });
  controller.abort();
  const second = module.createMicVad({ signal: new AbortController().signal });
  await tick();
  assert.equal(scripts.length, 1);
  assert.equal(initialized, 0);
  scripts[0].onload(); await tick();
  assert.equal(scripts.length, 2);
  assert.equal(initialized, 0);
  scripts[1].onload(); await second; await rejected;
  assert.equal(initialized, 1);
});

test('a scheduled browser recognition restart cannot reopen the mic after stop', async () => {
  let recognition, restart, starts = 0;
  class Recognition {
    constructor() { recognition = this; }
    start() { starts++; }
    abort() { this.onend(); }
  }
  const module = await load('assistant/stt.js', {
    window: { SpeechRecognition: Recognition }, navigator: { language: 'en' },
    setTimeout: callback => { restart = callback; return 1; }, clearTimeout() {},
  });
  const stt = module.createStt({ sttProvider: 'browser' }, {}); await stt.start();
  recognition.onend(); stt.stop(); restart();
  assert.equal(starts, 1);
});

// Exercise main.js's session controls without booting the unrelated Three.js scene.
function mainHarness(createAssistant) {
  const requests = [], button = { dataset: {} }, statuses = { dataset: {}, classList: { toggle() {} } };
  const context = vm.createContext({
    console, createAssistant, currentVrm: null,
    window: { addEventListener() {} },
    document: { getElementById: id => id === 'toggleVapi' ? button : statuses },
    updateTextMesh() {}, updateVrmNameDisplay() {},
    fetch: () => { const request = deferred(); requests.push(request); return request.promise; },
  });
  const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  vm.runInContext(source.slice(source.indexOf("let assistantProvider = 'vapi';"), source.indexOf('// Add these functions to start and stop Vapi')), context);
  vm.runInContext("assistantProvider = 'custom'", context);
  return { requests, button, toggle: () => context.toggleAssistant() };
}

test('Stop during settings fetch prevents a late session from starting', async () => {
  let starts = 0;
  const h = mainHarness(() => ({ async start() { starts++; } }));
  const starting = h.toggle(); await h.toggle();
  h.requests[0].resolve({ json: async () => ({}) }); await starting;
  assert.equal(starts, 0);
  assert.equal(h.button.dataset.active, 'false');
});

test('failure from a stopped startup cannot stop a newer session', async () => {
  const first = deferred(); let created = 0, newStops = 0;
  const h = mainHarness(() => ++created === 1
    ? { start: () => first.promise, stop() {} }
    : { async start() {}, stop() { newStops++; } });
  const starting = h.toggle(); h.requests[0].resolve({ json: async () => ({}) }); await tick();
  await h.toggle();
  const restarting = h.toggle(); h.requests[1].resolve({ json: async () => ({}) }); await restarting;
  first.reject(new Error('old startup failed')); await starting;
  assert.equal(newStops, 0);
  assert.equal(h.button.dataset.active, 'true');
});

test('streamChat surfaces tool events and server-side errors from the SSE stream', async () => {
  const frames = [
    'data: {"choices":[{"delta":{"content":"Let me check. "}}]}\n\n',
    'data: {"tool":{"name":"get_time","label":"Checking the time…"}}\n\n',
    'data: {"choices":[{"delta":{"content":"It is noon."}}]}\n\ndata: [DONE]\n\n',
  ];
  const encoder = new TextEncoder();
  const body = (parts) => ({ getReader() {
    const queue = [...parts];
    return { read: async () => queue.length ? { done: false, value: encoder.encode(queue.shift()) } : { done: true } };
  } });
  const module = await load('assistant/llm.js', { fetch: async () => ({ ok: true, body: body(frames) }), TextDecoder });
  const deltas = [], tools = [];
  const text = await module.streamChat([], { onDelta: (d) => deltas.push(d), onTool: (t) => tools.push(t) });
  assert.equal(text, 'Let me check. It is noon.');
  assert.deepEqual(snapshot(tools), [{ name: 'get_time', label: 'Checking the time…' }]);

  const failing = await load('assistant/llm.js', { fetch: async () => ({ ok: true, body: body(['data: {"error":"tool exploded"}\n\n']) }), TextDecoder });
  await assert.rejects(failing.streamChat([]), /tool exploded/);
});

test('losing the microphone for good ends the session rather than reporting and listening on', async () => {
  const h = await pipelineHarness(); await h.assistant.start();
  const denied = new Error('Microphone permission denied');
  h.hooks().onFatal(denied);
  assert.deepEqual(h.ends, [denied]);
  assert.deepEqual(h.errors, []);
  h.assistant.stop();
  // A fatal error arriving after stop belongs to a session nobody is watching.
  h.hooks().onFatal(new Error('too late'));
  assert.equal(h.ends.length, 1);
});

test('a denied microphone is fatal, not a routine recognition error', async () => {
  let recognition;
  class Recognition {
    constructor() { recognition = this; }
    start() {}
    abort() {}
  }
  const fatal = [], errors = [], cancels = [];
  const module = await load('assistant/stt.js', {
    window: { SpeechRecognition: Recognition }, navigator: { language: 'en' },
    setTimeout: () => 1, clearTimeout() {},
  }, { 'assistant/vad.js': { createMicVad: () => ({}) } });
  const stt = module.createStt({ sttProvider: 'browser' }, {
    onFatal: err => fatal.push(err), onError: err => errors.push(err), onSpeechCancel: () => cancels.push(1),
  });
  await stt.start();
  recognition.onerror({ error: 'no-speech' });
  assert.deepEqual(fatal, []);
  recognition.onerror({ error: 'not-allowed' });
  assert.equal(fatal.length, 1);
  assert.match(fatal[0].message, /permission denied/i);
  assert.deepEqual(errors, []);
  // Listening is over, so onend must not schedule another restart.
  recognition.onend();
  assert.deepEqual(cancels, []);
});

test('an ElevenLabs speaker is just the server proxy: the browser needs no provider knowledge', async () => {
  const calls = [];
  const module = await load('assistant/tts.js', {
    AudioContext: class {
      state = 'running';
      createAnalyser() { return { connect() {}, fftSize: 512 }; }
      async decodeAudioData(data) { return data; }
      createBufferSource() { return { connect() {}, start() {}, stop() {} }; }
      close() {}
    },
    fetch: async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return { ok: true, arrayBuffer: async () => 'mp3' }; },
  });
  const speaker = module.createSpeaker({ ttsProvider: 'elevenlabs' }, { onSentence() {}, onEnd() {}, onError() {} });
  speaker.enqueue('Hello');
  await tick();
  assert.deepEqual(calls, [{ url: '/api/assistant/tts', body: { text: 'Hello' } }]);
  speaker.destroy();
});
