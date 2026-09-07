// Text-to-speech "speaker": an ordered playback queue fed one sentence at a
// time. Synthesis for later sentences runs while earlier ones play, so the
// character starts talking after the first sentence rather than the whole
// reply. Surface: enqueue(text), cancel(), isBusy(), isSpeaking(), mouthLevel(), destroy().
// hooks.onSentence(text) fires as each sentence starts playing so the UI can
// show text in sync with the audio.
//
//   xai / openai → server proxy (/api/assistant/tts) returns an audio file
//   kokoro       → in-browser Kokoro-82M
//   browser      → speechSynthesis (OS voices; no audio graph, mouth is faked)

import { createKokoroSynth } from './kokoro.js';

export function createSpeaker(settings, hooks) {
  const provider = settings.ttsProvider || 'xai';
  if (provider === 'browser') return browserSpeaker(settings, hooks);

  const synth = provider === 'kokoro'
    ? createKokoroSynth(settings, hooks.onStatus)
    : serverSynth;
  return bufferSpeaker(synth, hooks);
}

// Strip markdown and other things that read badly aloud.
export function cleanForSpeech(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')          // code blocks
    .replace(/`([^`]*)`/g, '$1')              // inline code
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // links / images
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')       // headings
    .replace(/^\s*[-*+]\s+/gm, '')            // bullets
    .replace(/[*_~]{1,3}/g, '')               // emphasis
    .replace(/\p{Extended_Pictographic}/gu, '') // emoji
    .replace(/\s+/g, ' ')
    .trim();
}

async function serverSynth(text, audioCtx, signal) {
  const res = await fetch('/api/assistant/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    signal,
  });
  if (!res.ok) throw new Error(`Speech synthesis failed (${res.status}): ${await res.text()}`);
  return audioCtx.decodeAudioData(await res.arrayBuffer());
}

// ─── AudioBuffer queue with an analyser for lip sync ─────────────────────────

function bufferSpeaker(synth, hooks) {
  const audioCtx = new AudioContext();
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  analyser.connect(audioCtx.destination);
  const samples = new Uint8Array(analyser.fftSize);

  const queue = [];       // pending { text, buffer: Promise<AudioBuffer|null> }
  let playing = null;     // current AudioBufferSourceNode
  let speaking = false;
  let pumping = false;    // single consumer keeps sentences in order
  let generation = 0;     // bumped on cancel so stale synth results are dropped
  let synthesisAbort = new AbortController();
  let destroyed = false;

  function play(buffer) {
    return new Promise((resolve) => {
      const source = audioCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(analyser);
      source.onended = () => {
        if (playing === source) playing = null;
        resolve();
      };
      playing = source;
      source.start();
    });
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    const gen = generation;
    try {
      while (gen === generation && queue.length > 0) {
        const item = queue.shift();
        const buffer = await item.buffer; // later sentences keep synthesizing meanwhile
        if (gen !== generation) return; // a new consumer owns the queue after cancel
        if (!speaking) { speaking = true; hooks.onStart?.(); }
        hooks.onSentence?.(item.text);    // show the text even if synthesis failed
        if (buffer) await play(buffer);
      }
    } finally {
      if (gen === generation) {
        pumping = false;
        if (speaking && queue.length === 0) { speaking = false; hooks.onEnd?.(); }
      }
    }
  }

  return {
    enqueue(text) {
      if (destroyed) return;
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const { signal } = synthesisAbort;
      const buffer = synth(text, audioCtx, signal).catch((err) => {
        if (!signal.aborted) hooks.onError?.(err);
        return null;
      });
      queue.push({ text, buffer });
      pump();
    },
    cancel() {
      generation++;
      synthesisAbort.abort();
      synthesisAbort = new AbortController();
      queue.length = 0;
      pumping = false;
      if (playing) {
        const source = playing;
        playing = null;
        try { source.stop(); } catch { /* already stopped */ } // resolves play()
      }
      if (speaking) { speaking = false; hooks.onEnd?.(); }
    },
    isSpeaking: () => speaking,
    isBusy: () => pumping || speaking || queue.length > 0,
    mouthLevel() {
      if (!playing) return 0;
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (let i = 0; i < samples.length; i++) {
        const v = (samples[i] - 128) / 128;
        sum += v * v;
      }
      return Math.min(1, Math.sqrt(sum / samples.length) * 4);
    },
    destroy() {
      destroyed = true;
      this.cancel();
      audioCtx.close();
    },
  };
}

// ─── speechSynthesis ──────────────────────────────────────────────────────────

function browserSpeaker(settings, hooks) {
  const queue = [];
  let current = null;
  let speaking = false;

  function pump() {
    if (current || queue.length === 0) return;
    const utterance = new SpeechSynthesisUtterance(queue.shift());
    const voice = speechSynthesis.getVoices().find((v) => v.name === settings.ttsVoice);
    if (voice) utterance.voice = voice;
    utterance.rate = Number(settings.ttsSpeed) || 1;
    utterance.onstart = () => {
      if (current !== utterance) return;
      if (!speaking) { speaking = true; hooks.onStart?.(); }
      hooks.onSentence?.(utterance.text);
    };
    const done = () => {
      if (current !== utterance) return;
      current = null;
      if (queue.length === 0 && speaking) { speaking = false; hooks.onEnd?.(); }
      pump();
    };
    utterance.onend = done;
    utterance.onerror = done;
    current = utterance;
    speechSynthesis.speak(utterance);
  }

  return {
    enqueue(text) { queue.push(text); pump(); },
    cancel() {
      queue.length = 0;
      current = null;
      speechSynthesis.cancel();
      if (speaking) { speaking = false; hooks.onEnd?.(); }
    },
    isSpeaking: () => speaking,
    isBusy: () => current !== null || queue.length > 0,
    // No audio graph to analyse — approximate a talking mouth
    mouthLevel: () => (speaking ? 0.3 + 0.3 * Math.abs(Math.sin(performance.now() / 90)) : 0),
    destroy() { this.cancel(); },
  };
}
