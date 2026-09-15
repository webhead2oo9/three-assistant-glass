const EMOTIONS = ['happy', 'sad', 'angry', 'relaxed', 'surprised'];

// Own only emotional weights; blinking and speech keep their existing channels.
// Targets are a set of channel weights: a single emotion from the tool-calling
// path, or up to two channels from the character expression model.
export function createExpressionController() {
  let manager = null;
  let settling = null;
  const weights = new Map(), channels = new Map(), targets = new Map();
  function reset() {
    settling = null;
    for (const name of weights.keys()) manager?.setValue(name, 0);
    weights.clear();
    targets.clear();
  }
  function aim(channel, strength) {
    targets.set(channel, strength);
    if (!weights.has(channel)) weights.set(channel, 0);
  }
  return {
    bind(next) {
      reset(); manager = next || null; channels.clear();
      for (const name of EMOTIONS) {
        // The bundled VRM 0 models store surprise as a custom capitalized name.
        const channel = manager?.getExpression(name) ? name
          : name === 'surprised' && manager?.getExpression('Surprised') ? 'Surprised' : null;
        if (channel) channels.set(name, channel);
      }
    },
    supported() { return manager ? ['neutral', ...channels.keys()] : []; },
    apply(command) {
      const { expression, intensity: strength = 0.8 } = command || {};
      if (!this.supported().includes(expression)) throw new Error('This character does not support that expression.');
      if (!Number.isFinite(strength) || strength < 0 || strength > 1) throw new Error('Invalid expression strength.');
      settling = null; targets.clear();
      if (expression !== 'neutral') aim(channels.get(expression), strength);
      return { expression };
    },
    // Weights keyed by emotion name on the contract's 0 to 1 scale. Channels
    // this character lacks are dropped; an all-zero face returns to neutral.
    // gain scales the contract's subtle intensities for characters whose
    // blendshapes read faintly; the model still sees the ungained face.
    applyWeights(face, gain = 1) {
      settling = null; targets.clear();
      const applied = {};
      const scale = Number.isFinite(gain) && gain > 0 ? gain : 1;
      for (const [name, channel] of channels) {
        const value = Number(face?.[name]);
        if (Number.isFinite(value) && value > 0) { const v = Math.min(1, value * scale); aim(channel, v); applied[name] = v; }
      }
      return { weights: applied };
    },
    settle(seconds = 1.5) {
      targets.clear();
      settling = { from: new Map(weights), elapsed: 0, duration: Math.max(0.001, seconds) };
    },
    update(delta) {
      if (!manager || !Number.isFinite(delta) || delta <= 0) return;
      if (settling) {
        settling.elapsed += delta;
        const t = Math.min(1, settling.elapsed / settling.duration);
        const remaining = 1 - t * t * (3 - 2 * t);
        for (const [name, from] of settling.from) {
          const value = from * remaining;
          weights.set(name, value); manager.setValue(name, value);
        }
        if (t === 1) { weights.clear(); settling = null; }
        return;
      }
      const blend = 1 - Math.exp(-delta / 0.18);
      for (const [name, weight] of weights) {
        const goal = targets.get(name) ?? 0;
        const value = weight + (goal - weight) * blend;
        manager.setValue(name, value < 0.001 ? 0 : value);
        if (value < 0.001 && !targets.has(name)) weights.delete(name);
        else weights.set(name, value);
      }
    },
    reset,
  };
}
