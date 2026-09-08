// Microphone capture and playback for the realtime assistant.
//
// One AudioContext at the session's sample rate does both jobs: a worklet
// turns the mic into 20 ms PCM16 frames (onChunk receives the ArrayBuffer),
// and incoming PCM16 is scheduled back-to-back through an analyser so the
// character's mouth follows the voice. Echo cancellation on the mic stream is
// what lets the user talk over the speakers.

const SAMPLE_RATE = 24000;
const FRAME_SAMPLES = 480; // 20 ms at 24 kHz
const LEAD_IN_S = 0.05;    // headroom before the first chunk of a reply plays, so later chunks line up

const WORKLET = `
class PcmCapture extends AudioWorkletProcessor {
  constructor() { super(); this.frame = new Int16Array(${FRAME_SAMPLES}); this.filled = 0; }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      this.frame[this.filled++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.filled === this.frame.length) {
        this.port.postMessage(this.frame.buffer.slice(0));
        this.filled = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
`;

export function createRealtimeAudio({ sampleRate = SAMPLE_RATE, onChunk, onPlaybackEnd } = {}) {
  let ctx = null;
  let stream = null;
  let analyser = null;
  let samples = null;
  let nextTime = 0;
  const playing = new Set();
  let destroyed = false;

  const stopTracks = () => stream?.getTracks().forEach((track) => track.stop());

  return {
    sampleRate,

    async start() {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      if (destroyed) { stopTracks(); return; }
      ctx = new AudioContext({ sampleRate });
      analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.connect(ctx.destination);
      samples = new Uint8Array(analyser.fftSize);

      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
      try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
      if (destroyed) return;
      const capture = new AudioWorkletNode(ctx, 'pcm-capture', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 });
      capture.port.onmessage = (event) => { if (!destroyed) onChunk?.(event.data); };
      ctx.createMediaStreamSource(stream).connect(capture);
      if (ctx.state === 'suspended') await ctx.resume();
    },

    // Queue one base64 PCM16 chunk right after whatever is already scheduled
    play(base64) {
      if (!ctx || destroyed) return;
      const pcm = decodePcm16(base64);
      if (pcm.length === 0) return;
      const buffer = ctx.createBuffer(1, pcm.length, sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < pcm.length; i++) data[i] = pcm[i] / 32768;

      const node = ctx.createBufferSource();
      node.buffer = buffer;
      node.connect(analyser);
      node.onended = () => {
        if (!playing.delete(node)) return; // stopped on purpose
        if (playing.size === 0 && !destroyed) onPlaybackEnd?.();
      };
      const startAt = Math.max(ctx.currentTime + LEAD_IN_S, nextTime);
      playing.add(node);
      node.start(startAt);
      nextTime = startAt + buffer.duration;
    },

    // Drop everything queued (barge-in); onPlaybackEnd is not fired for this
    stopPlayback() {
      const nodes = [...playing];
      playing.clear();
      nextTime = 0;
      for (const node of nodes) { try { node.stop(); } catch { /* already ended */ } }
    },

    isPlaying: () => playing.size > 0,

    mouthLevel() {
      if (playing.size === 0 || !analyser) return 0;
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
      this.stopPlayback();
      stopTracks();
      stream = null;
      ctx?.close().catch(() => {});
      ctx = null;
    },
  };
}

export function decodePcm16(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer, 0, bytes.length >> 1);
}

export function encodePcm16(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

// RMS of a PCM16 frame, 0..1 — used to notice speech while no session is open
export function pcmLevel(buffer) {
  const pcm = new Int16Array(buffer);
  if (pcm.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i] / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / pcm.length);
}
