// Realtime speech-to-speech (xAI Grok Voice or OpenAI gpt-realtime): mic PCM →
// local server bridge → provider → PCM back. Same surface as pipeline.js so
// main.js can't tell them apart:
//   start(), stop(), addSystemMessage(text), mouthLevel()
// UI hooks: onText(text), onSpeaker('User'|'Character'), onStatus(text), onError(err)
//
// The server (server/realtime.mjs) owns the key, the session config and tool
// execution; this side streams audio and drives the UI from transcript events.
//
// Realtime is billed while connected, so a session that hears nothing for a
// while hangs up the upstream socket and reconnects on the next sound. xAI
// resumes the conversation by id; otherwise the transcript so far is replayed
// so the model keeps its context.

import { createRealtimeAudio, encodePcm16, pcmLevel } from './realtime-audio.js';
import { createAutomaticExpressions } from './automatic-expressions.js';

const TEXT_UPDATE_MS = 80;
const RING_FRAMES = 50;          // ~1 s of 20 ms frames kept while not connected
const WAKE_LEVEL = 0.02;         // RMS that counts as "someone is talking" while dormant
const WAKE_FRAMES = 5;           // …sustained for 100 ms
const CONNECT_TIMEOUT_MS = 30000;
const DEFAULT_IDLE_SECONDS = 90;
const DEFAULT_CHARS_PER_SECOND = 15; // how fast the transcript is spoken; recalibrated after every reply
const MIN_CHARS_PER_SECOND = 8;
const MAX_CHARS_PER_SECOND = 30;
const MAX_REPLAY = 40;           // transcript turns replayed when a provider can't resume
const IDLE_STATUS = 'Idle — say something to reconnect';

// Seconds of silence before the upstream is hung up; 0 keeps it open
export function idleSeconds(settings) {
  const value = settings.realtimeIdleSeconds;
  if (value === '' || value === null || value === undefined) return DEFAULT_IDLE_SECONDS;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : DEFAULT_IDLE_SECONDS;
}

// The transcript arrives well ahead of the audio. Show only as much as has
// been spoken: `seconds` of playback into this reply at `rate` chars/s, cut
// back to a word boundary so the caption doesn't grow letter by letter.
export function spokenPrefix(text, seconds, rate) {
  const chars = Math.floor(Math.max(0, seconds) * rate);
  if (chars >= text.length) return text;
  if (chars <= 0) return '';
  const boundary = text.lastIndexOf(' ', chars);
  return boundary > 0 ? text.slice(0, boundary) : '';
}

// Providers put a finished transcript in different places
export function transcriptOf(event) {
  if (typeof event.transcript === 'string') return event.transcript;
  if (typeof event.text === 'string') return event.text;
  if (Array.isArray(event.content)) {
    const part = event.content.find((c) => typeof c?.text === 'string' || typeof c?.transcript === 'string');
    if (part) return part.text ?? part.transcript;
  }
  return '';
}

export function createRealtimeAssistant(settings, ui) {
  const provider = settings.realtimeProvider === 'openai' ? 'openai' : 'xai';
  const expressions = createAutomaticExpressions(ui);
  const idleMs = idleSeconds(settings) * 1000;
  let running = false;
  let audio = null;
  let ws = null;
  let ready = false;         // session.updated received on the current socket
  let established = false;   // a session has worked at least once → later drops just go dormant
  let dormant = false;       // hung up on purpose; waiting for sound
  let hangingUp = false;
  let conversationId = null; // xAI resume token
  let resuming = false;      // this socket was opened with the resume token
  let responding = false;    // between response.created and response.done
  let interrupted = false;   // user spoke over this response: ignore the rest of it
  let speaking = false;      // audio of a reply is playing
  let newTurn = false;
  let characterText = '';    // full transcript of the current reply
  let shownText = '';        // the part of it revealed so far
  let userText = '';
  let replyStart = 0;        // timeline position (seconds) where this reply's audio begins
  let charsPerSecond = DEFAULT_CHARS_PER_SECOND;
  let revealTimer = null;
  let loudFrames = 0;
  let lastError = null;
  const ring = [];
  const pendingItems = [];
  const transcript = [];     // { role, text } — replayed on reconnect when the provider can't resume
  let idleTimer = null;
  let startWait = null;

  // Throttled text display
  let pendingText = null;
  let textTimer = null;
  function showText(text) {
    pendingText = text;
    if (textTimer) return;
    textTimer = setTimeout(() => {
      textTimer = null;
      if (pendingText !== null && running) ui.onText(pendingText);
      pendingText = null;
    }, TEXT_UPDATE_MS);
  }

  function remember(role, text) {
    if (!text) return;
    transcript.push({ role, text });
    while (transcript.length > MAX_REPLAY) transcript.shift();
  }

  // ─── Caption pacing ─────────────────────────────────────────────────────────

  // A new reply's text starts revealing once playback reaches its audio
  function beginReply(text = '') {
    characterText = text;
    shownText = '';
    replyStart = audio?.timeline().received ?? 0;
    startReveal();
  }

  function reveal() {
    if (!audio || !characterText) return;
    const { played } = audio.timeline();
    const prefix = spokenPrefix(characterText, played - replyStart, charsPerSecond);
    if (prefix.length <= shownText.length) return; // nothing new spoken yet; keep what's on screen
    shownText = prefix;
    ui.onSpeaker('Character');
    showText(shownText);
  }

  function startReveal() {
    if (!revealTimer) revealTimer = setInterval(reveal, TEXT_UPDATE_MS);
  }

  function stopReveal() {
    clearInterval(revealTimer);
    revealTimer = null;
  }

  // The reply has been heard in full: show all of it and learn how fast it was spoken
  function finishReveal() {
    stopReveal();
    if (!characterText) return;
    const seconds = (audio?.timeline().received ?? 0) - replyStart;
    if (seconds >= 1 && characterText.length >= 20) {
      const measured = characterText.length / seconds;
      charsPerSecond = Math.min(MAX_CHARS_PER_SECOND, Math.max(MIN_CHARS_PER_SECOND, (charsPerSecond + measured) / 2));
    }
    if (shownText !== characterText) {
      shownText = characterText;
      ui.onSpeaker('Character');
      showText(shownText);
    }
  }

  // ─── Connection ─────────────────────────────────────────────────────────────

  function send(payload) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(payload));
  }

  function connect() {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    resuming = Boolean(conversationId);
    const query = resuming ? `?conversation_id=${encodeURIComponent(conversationId)}` : '';
    const socket = new WebSocket(`${scheme}://${location.host}/api/assistant/realtime${query}`);
    ws = socket;
    ready = false;
    hangingUp = false;
    socket.onmessage = (message) => {
      if (ws !== socket) return;
      let event;
      try { event = JSON.parse(message.data); } catch { return; }
      if (event && typeof event.type === 'string') handleEvent(event);
    };
    socket.onclose = () => {
      if (ws !== socket) return;
      ws = null;
      const wasReady = ready;
      ready = false;
      speaking = false;
      responding = false;
      stopReveal();
      if (!running || hangingUp) return;
      if (!established) {
        fail(lastError || new Error('Realtime session could not be started'));
        return;
      }
      // A resume the upstream refused (expired id) should not be retried forever
      if (!wasReady) conversationId = null;
      audio?.stopPlayback();
      goDormant('Disconnected — say something to reconnect');
    };
    socket.onerror = () => { /* close follows */ };
  }

  function fail(error) {
    clearTimeout(idleTimer);
    idleTimer = null;
    if (startWait) {
      const wait = startWait;
      startWait = null;
      wait.reject(error);
    } else {
      ui.onError(error);
    }
  }

  function greet(text) {
    if (provider === 'xai') {
      // A force message is spoken as-is with no model turn
      send({
        type: 'conversation.item.create',
        item: { type: 'force_message', role: 'assistant', interruptible: true, content: [{ type: 'output_text', text }] },
      });
      beginReply(text);
    } else {
      send({ type: 'response.create', response: { instructions: `Greet the user by saying exactly this, nothing else: "${text}"` } });
    }
    remember('assistant', text);
  }

  // The provider has no memory of this conversation: hand it the transcript so far
  function replayTranscript() {
    for (const turn of transcript) {
      send({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: turn.role,
          content: [{ type: turn.role === 'assistant' ? 'output_text' : 'input_text', text: turn.text }],
        },
      });
    }
  }

  function onReady() {
    ready = true;
    dormant = false;
    loudFrames = 0;
    const first = !established;
    established = true;
    if (!first && !resuming) replayTranscript();
    for (const item of pendingItems) send(item);
    pendingItems.length = 0;
    for (const frame of ring) send({ type: 'input_audio_buffer.append', audio: encodePcm16(frame) });
    ring.length = 0;

    if (startWait) {
      const wait = startWait;
      startWait = null;
      wait.resolve();
    }
    if (first && settings.llmFirstMessage) greet(settings.llmFirstMessage);
    ui.onStatus('Listening…');
    armIdle();
  }

  // ─── Events ─────────────────────────────────────────────────────────────────

  function handleEvent(event) {
    switch (event.type) {
      case 'conversation.created': // only xAI can resume by id; OpenAI sends one too
        if (provider === 'xai' && event.conversation?.id) conversationId = event.conversation.id;
        break;
      case 'session.created':
        if (provider === 'xai' && event.session?.conversation_id) conversationId = event.session.conversation_id;
        break;
      case 'session.updated':
        if (!ready) onReady();
        break;
      case 'input_audio_buffer.speech_started':
        onUserSpeech();
        break;
      case 'conversation.item.input_audio_transcription.delta': // OpenAI: pieces
        if (event.delta) { userText += event.delta; ui.onSpeaker('User'); showText(userText); }
        break;
      case 'conversation.item.input_audio_transcription.updated': // xAI: cumulative
      case 'conversation.item.input_audio_transcription.completed': {
        const text = transcriptOf(event);
        if (text) { userText = text; ui.onSpeaker('User'); showText(text); }
        if (event.type.endsWith('completed')) remember('user', text);
        break;
      }
      case 'response.created':
        responding = true;
        interrupted = false;
        newTurn = true;
        beginReply();
        clearIdle();
        ui.onStatus('Thinking…');
        break;
      case 'response.output_audio.delta':
        if (interrupted || !event.delta) break;
        audio?.play(event.delta);
        if (!speaking) {
          speaking = true;
          ui.onSpeaker('Character');
          ui.onStatus('Speaking…');
        }
        break;
      case 'response.output_audio_transcript.delta':
        if (interrupted || !event.delta) break;
        characterText += event.delta; // revealed by the timer as the audio plays
        expressions.transcript(characterText, newTurn);
        newTurn = false;
        break;
      case 'response.done':
        responding = false;
        remember('assistant', characterText);
        if (!speaking) { finishReveal(); onQuiet(); }
        break;
      case 'tool':
        ui.onStatus(event.tool?.label || 'Working…');
        break;
      case 'error': {
        const error = new Error(event.error?.message || 'Realtime error');
        if (established) ui.onError(error);
        else lastError = error; // start() reports it once the socket closes
        break;
      }
      default:
        break;
    }
  }

  function onUserSpeech() {
    interrupted = responding || speaking;
    stopReveal(); // the caption keeps what was actually heard
    audio?.stopPlayback();
    speaking = false;
    userText = '';
    clearIdle();
    ui.onSpeaker('User');
    ui.onStatus('Listening…');
  }

  // The reply has been spoken and nothing is pending: back to listening, idle clock running
  function onQuiet() {
    if (!running || !ready) return;
    ui.onStatus('Listening…');
    armIdle();
  }

  function onPlaybackEnd() {
    speaking = false;
    if (!responding) { finishReveal(); onQuiet(); }
  }

  function onChunk(frame) {
    if (!running) return;
    if (ready && ws?.readyState === 1) {
      send({ type: 'input_audio_buffer.append', audio: encodePcm16(frame) });
      return;
    }
    ring.push(frame);
    if (ring.length > RING_FRAMES) ring.shift();
    if (!dormant) return;
    if (pcmLevel(frame) > WAKE_LEVEL) {
      if (++loudFrames >= WAKE_FRAMES) wake();
    } else {
      loudFrames = 0;
    }
  }

  // ─── Idle hang-up ───────────────────────────────────────────────────────────

  function armIdle() {
    clearIdle();
    if (idleMs > 0) idleTimer = setTimeout(hangUp, idleMs);
  }

  function clearIdle() {
    clearTimeout(idleTimer);
    idleTimer = null;
  }

  function hangUp() {
    idleTimer = null;
    if (!running || !ws) return;
    if (responding || speaking) { armIdle(); return; }
    hangingUp = true;
    const socket = ws;
    ws = null;
    ready = false;
    socket.close(1000);
    goDormant(IDLE_STATUS);
  }

  function goDormant(status) {
    dormant = true;
    loudFrames = 0;
    ui.onStatus(status);
  }

  function wake() {
    dormant = false;
    loudFrames = 0;
    ui.onStatus('Connecting…');
    connect();
  }

  return {
    async start() {
      running = true;
      established = false;
      dormant = false;
      conversationId = null;
      lastError = null;
      characterText = '';
      shownText = '';
      userText = '';
      charsPerSecond = DEFAULT_CHARS_PER_SECOND;
      ring.length = 0;
      pendingItems.length = 0;
      transcript.length = 0;
      ui.onStatus('Connecting…');
      void expressions.setEnabled(settings.realtimeAutoExpressions === true);

      audio = createRealtimeAudio({ onChunk, onPlaybackEnd });
      await audio.start(); // microphone permission
      if (!running) return;

      const connected = new Promise((resolve, reject) => { startWait = { resolve, reject }; });
      const timeout = setTimeout(() => fail(new Error('Timed out connecting to the realtime API. Try starting again.')), CONNECT_TIMEOUT_MS);
      connect();
      try {
        await connected;
      } finally {
        clearTimeout(timeout);
      }
    },

    stop() {
      running = false;
      clearIdle();
      stopReveal();
      hangingUp = true;
      const socket = ws;
      ws = null;
      socket?.close(1000);
      audio?.destroy();
      audio = null;
      expressions.stop();
      clearTimeout(textTimer);
      textTimer = null;
      pendingText = null;
      if (startWait) {
        const wait = startWait;
        startWait = null;
        wait.reject(new Error('Stopped'));
      }
    },

    // Mirrors Vapi's add-message: context the model sees on its next turn
    addSystemMessage(content) {
      if (!running) return;
      const item = {
        type: 'conversation.item.create',
        item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: content }] },
      };
      if (ready) send(item);
      else pendingItems.push(item);
    },

    mouthLevel: () => audio?.mouthLevel() ?? 0,
  };
}
