// Realtime speech-to-speech (xAI Grok Voice, OpenAI gpt-realtime or OpenAI
// GPT-Live): mic PCM → local server bridge → provider → PCM back. Same surface
// as pipeline.js so main.js can't tell them apart:
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
//
// GPT-Live is full duplex and has no turn events: audio and transcript simply
// stream while the model talks. Reply boundaries are inferred: a new reply
// begins when output resumes after the user spoke, or after a gap on the
// transcript's own timeline; it ends once the transcript has stopped for a
// moment. "Speaking" follows actual voice in the output audio, since the
// stream may carry silence.

import { createRealtimeAudio, decodePcm16, encodePcm16, pcmLevel } from './realtime-audio.js';
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
const LIVE_REPLY_GAP_MS = 2000;  // GPT-Live: no transcript for this long (wall clock) → the reply is over; pauses inside a reply reach 1.2 s
const LIVE_TURN_GAP_MS = 2000;   // GPT-Live: this much silence on the transcript timeline → a new reply
const LIVE_VOICE_GAP_MS = 600;   // GPT-Live: no voiced audio for this long → the character has stopped talking
const LIVE_USER_GAP_MS = 1200;   // GPT-Live: user transcript quiet this long → the utterance is over
const LIVE_VOICE_LEVEL = 0.01;   // RMS below which an output chunk is taken as silence
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
  const provider = ['openai', 'live'].includes(settings.realtimeProvider) ? settings.realtimeProvider : 'xai';
  const live = provider === 'live';
  const AUDIO_APPEND = live ? 'session.input_audio.append' : 'input_audio_buffer.append';
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
  let liveReplyTimer = null; // GPT-Live: fires when the model has stopped producing transcript
  let liveVoiceTimer = null; // GPT-Live: fires when the output audio has gone quiet
  let liveUserTimer = null;  // GPT-Live: fires when the user's transcript has stopped
  let liveOutEndMs = -1;     // GPT-Live: where the last output transcript fragment ended on the session timeline
  let liveUserSince = false; // GPT-Live: the user has spoken since the last output fragment

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
    socket.onopen = () => {
      // GPT-Live takes the conversation so far as startup input, so the bridge
      // needs it before it opens the upstream; it is consumed there, not forwarded.
      if (ws === socket && live) send({ type: 'session.history', items: transcript.map((t) => ({ role: t.role, text: t.text })) });
    };
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
      clearLiveTimers();
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
    if (!first && !resuming && !live) replayTranscript(); // GPT-Live got it as startup input
    for (const item of pendingItems) send(item);
    pendingItems.length = 0;
    for (const frame of ring) send({ type: AUDIO_APPEND, audio: encodePcm16(frame) });
    ring.length = 0;

    if (startWait) {
      const wait = startWait;
      startWait = null;
      wait.resolve();
    }
    // GPT-Live has no way to make the model speak first: an appended instruction
    // was only acted on once the user spoke, which read as a reply to them. So
    // there is no greeting there; the character waits to be spoken to.
    if (first && settings.llmFirstMessage && !live) greet(settings.llmFirstMessage);
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
        if (!ready && !live) onReady(); // GPT-Live's session.updated only acknowledges delegation changes
        break;
      case 'session.started': // GPT-Live
        if (!ready) onReady();
        break;
      case 'session.output_audio.delta': { // GPT-Live: no turn events, so a reply is inferred from the flow
        if (!event.delta) break;
        const voiced = pcmLevel(decodePcm16(event.delta)) >= LIVE_VOICE_LEVEL; // the stream may carry silence
        if (voiced && (!responding || liveUserSince)) liveNewReply(); // before queueing, so the caption is paced from this chunk
        audio?.play(event.delta);
        if (!voiced) break;
        clearTimeout(liveVoiceTimer);
        liveVoiceTimer = setTimeout(liveVoiceDone, LIVE_VOICE_GAP_MS);
        if (!speaking) {
          speaking = true;
          ui.onSpeaker('Character');
          ui.onStatus('Speaking…');
        }
        break;
      }
      case 'session.output_transcript.delta': {
        if (!event.delta) break;
        const start = Number(event.start_ms), end = Number(event.end_ms);
        const gap = Number.isFinite(start) && liveOutEndMs >= 0 ? start - liveOutEndMs : 0;
        if (!responding || liveUserSince || gap > LIVE_TURN_GAP_MS) liveNewReply();
        // Fragments arrive without spaces; a pause between them is a word boundary
        else if (gap > 0 && characterText && !/\s$/.test(characterText) && !/^\s/.test(event.delta)) characterText += ' ';
        characterText += event.delta;
        if (Number.isFinite(end)) liveOutEndMs = end;
        clearTimeout(liveReplyTimer);
        liveReplyTimer = setTimeout(liveReplyDone, LIVE_REPLY_GAP_MS);
        expressions.transcript(characterText, newTurn);
        newTurn = false;
        break;
      }
      case 'session.input_transcript.delta':
        // Full duplex: the user may talk over the model, so this is not treated
        // as an interruption; the model decides whether to yield.
        if (!event.delta) break;
        userText += event.delta;
        liveUserSince = true;
        if (!speaking) { ui.onSpeaker('User'); showText(userText); } // a backchannel shouldn't replace the caption
        clearIdle();
        clearTimeout(liveUserTimer);
        liveUserTimer = setTimeout(liveUserDone, LIVE_USER_GAP_MS);
        break;
      case 'session.delegation.created':
        ui.onStatus('Thinking…');
        break;
      case 'session.closed':
        if (event.reason && event.reason !== 'close_requested') console.warn(`[realtime] live session closed: ${event.reason}`);
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

  // ─── GPT-Live turn inference ────────────────────────────────────────────────

  // A reply begins: the first voiced output, or output after the user spoke
  function liveNewReply() {
    if (responding && characterText === '') return; // already begun by its audio, text still to come
    if (responding) remember('assistant', characterText); // the previous reply ran straight into this one
    responding = true;
    interrupted = false;
    newTurn = true;
    liveUserSince = false;
    beginReply();
    clearIdle();
    if (userText) liveUserDone(); // whatever the user said before the reply is one utterance
  }

  function liveReplyDone() {
    liveReplyTimer = null;
    if (!responding) return;
    responding = false;
    remember('assistant', characterText);
    if (!speaking) { finishReveal(); onQuiet(); }
  }

  function liveVoiceDone() {
    liveVoiceTimer = null;
    if (!speaking) return;
    speaking = false;
    if (!responding) { finishReveal(); onQuiet(); }
    else if (userText) { ui.onSpeaker('User'); showText(userText); }
  }

  function liveUserDone() {
    clearTimeout(liveUserTimer);
    liveUserTimer = null;
    if (!userText) return;
    remember('user', userText);
    userText = '';
    if (!responding && !speaking) onQuiet();
  }

  function clearLiveTimers() {
    clearTimeout(liveReplyTimer);
    clearTimeout(liveVoiceTimer);
    clearTimeout(liveUserTimer);
    liveReplyTimer = liveVoiceTimer = liveUserTimer = null;
    liveOutEndMs = -1;
    liveUserSince = false;
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
      send({ type: AUDIO_APPEND, audio: encodePcm16(frame) });
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
      clearLiveTimers();
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
      const item = live
        // Silent context the Live model may draw on later (500-token limit)
        ? { type: 'session.thinking.append', delegation_id: null, content: content.slice(0, 1500) }
        : {
          type: 'conversation.item.create',
          item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: content }] },
        };
      if (ready) send(item);
      else pendingItems.push(item);
    },

    mouthLevel: () => audio?.mouthLevel() ?? 0,
  };
}
