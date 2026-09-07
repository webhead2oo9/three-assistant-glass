// Silero VAD running in the browser (via @ricky0123/vad-web + onnxruntime-web).
// Loaded lazily from the CDN as UMD globals, matching how index.html loads Vapi.
// Works in Chrome/Edge/Firefox on Mac, Windows and Linux — no native deps.

const ORT_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/';
const VAD_BASE = 'https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.29/dist/';
const scripts = new Map();

function loadScript(src) {
  if (scripts.has(src)) return scripts.get(src);
  const loading = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = () => {
      scripts.delete(src);
      script.remove();
      reject(new Error(`Failed to load ${src}`));
    };
    document.head.appendChild(script);
  });
  scripts.set(src, loading);
  return loading;
}

/**
 * Create a microphone VAD. onSpeechEnd receives a Float32Array of 16 kHz PCM
 * covering the whole utterance (with a little pre-speech padding).
 */
export async function createMicVad({ onSpeechStart, onSpeechEnd, onMisfire, signal }) {
  await loadScript(ORT_BASE + 'ort.wasm.min.js');
  signal?.throwIfAborted();
  await loadScript(VAD_BASE + 'bundle.min.js');
  signal?.throwIfAborted();

  let stream = null;
  const stopTracks = () => stream?.getTracks().forEach((track) => track.stop());
  signal?.addEventListener('abort', stopTracks, { once: true });
  try {
    return await window.vad.MicVAD.new({
      startOnLoad: true, // callers receive a fully initialized instance safe to destroy
      onnxWASMBasePath: ORT_BASE,
      baseAssetPath: VAD_BASE,
      model: 'v5',
      positiveSpeechThreshold: 0.6,
      negativeSpeechThreshold: 0.35,
      redemptionMs: 600,   // silence tolerated before an utterance is considered over
      minSpeechMs: 250,    // ignore very short bursts (coughs, clicks)
      preSpeechPadMs: 300,
      // Echo cancellation is what lets the character talk over the speakers
      // without hearing itself — important for barge-in.
      getStream: async () => {
        signal?.throwIfAborted();
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        if (signal?.aborted) {
          stopTracks();
          signal.throwIfAborted();
        }
        return stream;
      },
      onSpeechStart,
      onSpeechEnd,
      onVADMisfire: onMisfire,
    });
  } catch (err) {
    signal?.removeEventListener('abort', stopTracks);
    stopTracks();
    throw err;
  }
}
