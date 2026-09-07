// Speech-to-text adapters. Every adapter exposes the same surface:
//   start(), stop(), setSuppressed(bool)
// and reports through hooks: onUtterance(text), onInterim(text),
// onSpeechStart(), onSpeechCancel(), onStatus(text), onError(err).
//
//   xai / openai  → browser VAD segments speech, server proxy transcribes it
//   browser       → Chrome's Web Speech API (zero install, audio goes to Google)

import { createMicVad } from './vad.js';

export function createStt(settings, hooks) {
  const provider = settings.sttProvider || 'xai';
  return provider === 'browser' ? browserStt(settings, hooks) : serverStt(settings, hooks);
}

// ─── VAD + server transcription ───────────────────────────────────────────────

function serverStt(settings, hooks) {
  let vad = null;
  let suppressed = false;
  let session = null;

  return {
    async start() {
      const controller = new AbortController();
      session = controller;
      const active = () => session === controller && !controller.signal.aborted;
      hooks.onStatus?.('Loading voice detection…');
      try {
        const instance = await createMicVad({
          signal: controller.signal,
          onSpeechStart: () => {
            if (active() && !suppressed) hooks.onSpeechStart?.();
          },
          onSpeechEnd: async (audio) => {
            if (!active() || suppressed) return;
            hooks.onStatus?.('Transcribing…');
            try {
              const text = await transcribe(audio, controller.signal);
              if (!active() || suppressed) return;
              if (text) hooks.onUtterance(text);
              else hooks.onSpeechCancel?.();
            } catch (err) {
              if (!active()) return;
              hooks.onSpeechCancel?.();
              hooks.onError?.(err);
            }
          },
          onMisfire: () => { if (active()) hooks.onSpeechCancel?.(); },
        });
        // MicVAD.new starts capture before resolving. Dispose late arrivals.
        if (!active()) { await instance.destroy(); return; }
        vad = instance;
      } catch (err) {
        if (active()) throw err;
      }
    },
    stop() {
      session?.abort();
      session = null;
      vad?.destroy();
      vad = null;
    },
    setSuppressed(value) {
      suppressed = value;
    },
  };
}

async function transcribe(float32, signal) {
  const res = await fetch('/api/assistant/stt', {
    method: 'POST',
    headers: { 'Content-Type': 'audio/wav' },
    body: encodeWav(float32, 16000),
    signal,
  });
  if (!res.ok) throw new Error(`Transcription failed (${res.status}): ${await res.text()}`);
  const { text } = await res.json();
  return (text || '').trim();
}

// Float32 PCM → 16-bit mono WAV
export function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeString = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);          // PCM
  view.setUint16(22, 1, true);          // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

// ─── Web Speech API ───────────────────────────────────────────────────────────

function browserStt(settings, hooks) {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null;
  let active = false;
  let suppressed = false;
  let restartTimer = null;

  function listen() {
    if (!active) return;
    recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = settings.assistantLanguage || navigator.language;

    recognition.onresult = (event) => {
      if (!active || suppressed) return;
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0].transcript.trim();
        if (!text) continue;
        if (result.isFinal) {
          hooks.onUtterance(text);
        } else {
          hooks.onSpeechStart?.();
          hooks.onInterim?.(text);
        }
      }
    };
    recognition.onerror = (event) => {
      if (!active) return;
      if (event.error === 'not-allowed') {
        active = false;
        hooks.onError?.(new Error('Microphone permission denied'));
      }
      // 'no-speech' / 'aborted' are routine; onend restarts us
    };
    // Chrome ends continuous sessions after a while — keep listening
    recognition.onend = () => {
      if (active) {
        hooks.onSpeechCancel?.();
        restartTimer = setTimeout(listen, 200);
      }
    };
    recognition.start();
  }

  return {
    async start() {
      if (!Recognition) {
        throw new Error('Web Speech API is not available in this browser — use Chrome, or pick another STT provider.');
      }
      active = true;
      listen();
    },
    stop() {
      active = false;
      clearTimeout(restartTimer);
      recognition?.abort();
      recognition = null;
    },
    setSuppressed(value) {
      suppressed = value;
    },
  };
}
