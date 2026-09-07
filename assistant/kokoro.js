// In-browser Kokoro-82M text-to-speech via kokoro-js (ONNX, WebGPU or WASM).
// Fully local and free; the ~90–330 MB model downloads once and is cached by
// the browser. Loaded lazily so it costs nothing unless selected.

const KOKORO_URL = 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js';
const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

export const KOKORO_VOICES = [
  'af_heart', 'af_bella', 'af_nicole', 'af_sarah', 'af_sky',
  'am_adam', 'am_michael', 'am_fenrir',
  'bf_emma', 'bf_isabella', 'bm_george', 'bm_lewis', 'bm_fable',
];

let loading = null;

export function loadKokoro(onProgress) {
  if (!loading) {
    loading = (async () => {
      const { KokoroTTS } = await import(KOKORO_URL);
      const webgpu = !!navigator.gpu;
      return KokoroTTS.from_pretrained(MODEL_ID, {
        dtype: webgpu ? 'fp32' : 'q8',
        device: webgpu ? 'webgpu' : 'wasm',
        progress_callback: onProgress,
      });
    })().catch((err) => {
      loading = null; // allow a retry next time
      throw err;
    });
  }
  return loading;
}

/** Returns synth(text, audioCtx) → AudioBuffer. Generation is serialized. */
export function createKokoroSynth(settings, onStatus) {
  let chain = Promise.resolve();
  const voice = settings.ttsVoice || 'af_heart';
  const speed = Number(settings.ttsSpeed) || 1;

  return async (text, audioCtx) => {
    const tts = await loadKokoro((p) => {
      if (p.status === 'progress' && p.file?.endsWith('.onnx')) {
        onStatus?.(`Loading voice model… ${Math.round(p.progress)}%`);
      }
    });
    const run = chain.then(() => tts.generate(text, { voice, speed }));
    chain = run.catch(() => {});
    const audio = await run;
    const buffer = audioCtx.createBuffer(1, audio.audio.length, audio.sampling_rate);
    buffer.copyToChannel(audio.audio, 0);
    return buffer;
  };
}
