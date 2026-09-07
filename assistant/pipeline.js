// The "custom" voice assistant: mic → VAD → STT → LLM (streamed) → sentence
// splitter → TTS queue → speakers, with barge-in. Exposes the same surface a
// future realtime (speech-to-speech) adapter would:
//   start(), stop(), addSystemMessage(text), mouthLevel()
// UI hooks: onText(text), onSpeaker('User'|'Character'), onStatus(text), onError(err)

import { streamChat } from './llm.js';
import { createStt } from './stt.js';
import { createSpeaker, cleanForSpeech } from './tts.js';
import { createSentenceSplitter } from './sentences.js';

const DEFAULT_SYSTEM_PROMPT =
  'You are a friendly voice assistant. Reply in short, natural spoken sentences. ' +
  'Do not use markdown, lists or emoji — everything you write will be read aloud.';
const MAX_HISTORY = 40;     // messages kept after the system prompt
const TEXT_UPDATE_MS = 80;  // coalesce text updates so the canvas isn't redrawn per token
const ECHO_WINDOW_MS = 20000;
const ECHO_OVERLAP = 0.7;   // share of transcript words also in recent speech → it's our own voice

function words(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
}

/**
 * True when a transcript is mostly made of what the character just said —
 * the microphone picking up the speakers. Only consulted for utterances that
 * began while the character was talking.
 */
export function isEcho(transcript, recentSpeech) {
  const heard = words(transcript);
  if (heard.length === 0) return true;
  const spoken = new Set(words(recentSpeech));
  if (spoken.size === 0) return false;
  const hits = heard.filter((w) => spoken.has(w)).length;
  return hits / heard.length >= ECHO_OVERLAP;
}

export function createAssistant(settings, ui) {
  const bargeIn = settings.bargeIn !== false;
  const history = [];
  let stt = null;
  let speaker = null;
  let abort = null;
  let running = false;
  let responding = false;
  let spokenText = '';          // what's been said aloud for the current reply
  let spokenLog = [];           // { text, at } — for echo detection
  let heardWhileSpeaking = false;

  // Throttled text display
  let pendingText = null;
  let textTimer = null;
  function showText(text) {
    pendingText = text;
    if (textTimer) return;
    textTimer = setTimeout(() => {
      textTimer = null;
      if (pendingText !== null) ui.onText(pendingText);
      pendingText = null;
    }, TEXT_UPDATE_MS);
  }

  function say(text) {
    const clean = cleanForSpeech(text);
    if (clean) speaker.enqueue(clean);
  }

  function recentSpeech() {
    const cutoff = Date.now() - ECHO_WINDOW_MS;
    spokenLog = spokenLog.filter((e) => e.at > cutoff);
    return spokenLog.map((e) => e.text).join(' ');
  }

  function cancelReply() {
    abort?.abort();
    speaker.cancel();
    responding = false;
  }

  async function handleUtterance(text) {
    if (!running) return;
    const busy = responding || speaker.isSpeaking();
    const startedWhileSpeaking = heardWhileSpeaking;
    heardWhileSpeaking = false;

    if (startedWhileSpeaking && isEcho(text, recentSpeech())) {
      console.log(`[assistant] ignored echo of own voice: "${text}"`);
      ui.onStatus(busy ? 'Speaking…' : 'Listening…');
      return;
    }
    console.log(`[assistant] heard: "${text}"`);
    if (busy) cancelReply(); // real barge-in

    ui.onSpeaker('User');
    showText(text);
    history.push({ role: 'user', content: text });
    trimHistory();
    await respond();
  }

  async function respond() {
    responding = true;
    const controller = new AbortController();
    abort = controller;
    let text = '';
    spokenText = '';
    const splitter = createSentenceSplitter(say);

    ui.onStatus('Thinking…');
    try {
      await streamChat(history, {
        signal: controller.signal,
        onDelta: (delta) => {
          text += delta;
          splitter.push(delta); // the bubble updates as sentences are *spoken*
        },
      });
      splitter.flush();
    } catch (err) {
      if (err.name !== 'AbortError') ui.onError(err);
    } finally {
      if (text) history.push({ role: 'assistant', content: text });
      if (abort === controller) { responding = false; abort = null; }
    }
  }

  function trimHistory() {
    while (history.length > MAX_HISTORY + 1) history.splice(1, 1);
  }

  return {
    async start() {
      running = true;
      history.length = 0;
      spokenLog = [];
      history.push({ role: 'system', content: settings.llmSystemPrompt || DEFAULT_SYSTEM_PROMPT });

      speaker = createSpeaker(settings, {
        onStart: () => {
          ui.onSpeaker('Character');
          ui.onStatus('Speaking…');
          if (!bargeIn) stt?.setSuppressed(true); // don't transcribe our own voice
        },
        onSentence: (sentence) => {
          spokenLog.push({ text: sentence, at: Date.now() });
          spokenText = spokenText ? `${spokenText} ${sentence}` : sentence;
          ui.onSpeaker('Character');
          showText(spokenText);
        },
        onEnd: () => {
          if (!bargeIn) stt?.setSuppressed(false);
          if (running && !responding) ui.onStatus('Listening…');
        },
        onStatus: ui.onStatus,
        onError: (err) => { // a failed sentence shouldn't wipe the conversation
          console.error('[assistant] voice error:', err);
          ui.onStatus('Voice error — see console');
        },
      });

      stt = createStt(settings, {
        onUtterance: handleUtterance,
        onInterim: (partial) => {
          if (!heardWhileSpeaking) { ui.onSpeaker('User'); showText(partial); }
        },
        onSpeechStart: () => {
          heardWhileSpeaking = speaker.isSpeaking() || responding;
        },
        onSpeechCancel: () => { heardWhileSpeaking = false; },
        onStatus: ui.onStatus,
        onError: ui.onError,
      });
      await stt.start();
      ui.onStatus('Listening…');

      if (settings.llmFirstMessage) {
        history.push({ role: 'assistant', content: settings.llmFirstMessage });
        spokenText = '';
        say(settings.llmFirstMessage);
      }
    },

    stop() {
      running = false;
      abort?.abort();
      stt?.stop();
      speaker?.destroy();
      stt = null;
      speaker = null;
      responding = false;
    },

    // Mirrors Vapi's add-message: context the model sees on its next turn
    addSystemMessage(content) {
      if (!running) return;
      history.push({ role: 'system', content });
      trimHistory();
    },

    mouthLevel: () => speaker?.mouthLevel() ?? 0,
  };
}
