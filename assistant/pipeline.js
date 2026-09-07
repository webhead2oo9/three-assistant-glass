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
const MAX_HISTORY = 40; // messages kept after the system prompt
const TEXT_UPDATE_MS = 80; // coalesce streamed text so the canvas isn't redrawn per token

export function createAssistant(settings, ui) {
  const bargeIn = settings.bargeIn !== false;
  const history = [];
  let stt = null;
  let speaker = null;
  let abort = null;
  let running = false;
  let responding = false;

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

  function interrupt() {
    if (!bargeIn) return;
    if (!responding && !speaker?.isSpeaking()) return;
    abort?.abort();
    speaker.cancel();
    responding = false;
  }

  async function handleUtterance(text) {
    if (!running) return;
    if (responding || speaker.isSpeaking()) {
      abort?.abort();
      speaker.cancel();
    }
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
    const splitter = createSentenceSplitter(say);

    ui.onSpeaker('Character');
    ui.onStatus('Thinking…');
    try {
      await streamChat(history, {
        signal: controller.signal,
        onDelta: (delta) => {
          text += delta;
          showText(text);
          splitter.push(delta);
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
      history.push({ role: 'system', content: settings.llmSystemPrompt || DEFAULT_SYSTEM_PROMPT });

      speaker = createSpeaker(settings, {
        onStart: () => {
          ui.onSpeaker('Character');
          if (!bargeIn) stt?.setSuppressed(true); // don't transcribe our own voice
        },
        onEnd: () => {
          if (!bargeIn) stt?.setSuppressed(false);
          if (running && !responding) ui.onStatus('Listening…');
        },
        onStatus: ui.onStatus,
        onError: ui.onError,
      });

      stt = createStt(settings, {
        onUtterance: handleUtterance,
        onInterim: (partial) => { ui.onSpeaker('User'); showText(partial); },
        onSpeechStart: interrupt,
        onStatus: ui.onStatus,
        onError: ui.onError,
      });
      await stt.start();
      ui.onStatus('Listening…');

      if (settings.llmFirstMessage) {
        history.push({ role: 'assistant', content: settings.llmFirstMessage });
        ui.onSpeaker('Character');
        showText(settings.llmFirstMessage);
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
