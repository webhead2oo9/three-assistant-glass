// A conservative word boundary for audio providers without word timestamps.
// The caller supplies playback time, never time since the transcript arrived.
export function spokenPrefix(text, seconds, rate) {
  const chars = Math.floor(Math.max(0, seconds) * rate);
  if (chars >= text.length) return text;
  if (chars <= 0 || !Number.isFinite(chars)) return '';
  const boundary = text.lastIndexOf(' ', chars);
  return boundary > 0 ? text.slice(0, boundary) : '';
}

export function trackSpeechProgress(text, elapsed, rate, onProgress) {
  let timer = null, stopped = false, shown = '';
  function emit(prefix) {
    if (stopped || prefix.length <= shown.length) return;
    shown = prefix; onProgress?.(prefix);
  }
  function poll() {
    if (stopped) return;
    // Only the actual ended event confirms the final word was heard.
    const seconds = Math.min(elapsed(), Math.max(0, text.length - 1) / rate);
    emit(spokenPrefix(text, seconds, rate));
    timer = setTimeout(poll, 80);
  }
  if (onProgress) timer = setTimeout(poll, 80);
  return {
    boundary(index) {
      if (!Number.isFinite(index) || index < 0 || index > text.length) return;
      // Native boundary events take precedence over the clock estimate.
      clearTimeout(timer); timer = null;
      emit(text.slice(0, index).trimEnd());
    },
    finish() { emit(text); this.cancel(); },
    cancel() { stopped = true; clearTimeout(timer); timer = null; },
  };
}
