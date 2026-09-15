// Deterministic playback/timer tests; no wall-clock sleeps at turn boundaries.
function fakeClock() {
  let now = 0, sequence = 0;
  const timers = new Map();
  function schedule(fn, delay = 0, interval = 0) {
    const id = ++sequence;
    timers.set(id, { fn, at: now + delay, interval });
    return id;
  }
  return {
    now: () => now,
    globals: {
      performance: { now: () => now },
      setTimeout: (fn, delay) => schedule(fn, delay),
      clearTimeout: id => timers.delete(id),
      setInterval: (fn, delay) => schedule(fn, delay, delay),
      clearInterval: id => timers.delete(id),
    },
    advance(ms) {
      const end = now + ms;
      while (true) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next || next[1].at > end) break;
        const [id, timer] = next;
        now = timer.at;
        if (timer.interval) timer.at += timer.interval;
        else timers.delete(id);
        timer.fn();
      }
      now = end;
    },
  };
}

module.exports = { fakeClock };
