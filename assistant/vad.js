// Silero VAD running in the browser (via @ricky0123/vad-web + onnxruntime-web).
// Loaded lazily from the CDN as UMD globals, matching how index.html loads Vapi.
// Works in Chrome/Edge/Firefox on Mac, Windows and Linux — no native deps.

const ORT_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/';
const VAD_BASE = 'https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.29/dist/';

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });
}

/**
 * Create a microphone VAD. onSpeechEnd receives a Float32Array of 16 kHz PCM
 * covering the whole utterance (with a little pre-speech padding).
 */
export async function createMicVad({ onSpeechStart, onSpeechEnd, onMisfire }) {
  await loadScript(ORT_BASE + 'ort.wasm.min.js');
  await loadScript(VAD_BASE + 'bundle.min.js');

  return window.vad.MicVAD.new({
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
    getStream: () => navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    }),
    onSpeechStart,
    onSpeechEnd,
    onVADMisfire: onMisfire,
  });
}
