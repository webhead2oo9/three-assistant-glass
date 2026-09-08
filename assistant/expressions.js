const EMOTIONS = ['happy', 'sad', 'angry', 'relaxed', 'surprised'];

// Own only emotional weights; blinking and speech keep their existing channels.
export function createExpressionController() {
  let manager = null, target = null, intensity = 0;
  const weights = new Map(), channels = new Map();
  function reset() {
    for (const name of weights.keys()) manager?.setValue(name, 0);
    weights.clear();
    target = null;
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
      target = expression === 'neutral' ? null : channels.get(expression);
      intensity = strength;
      if (target && !weights.has(target)) weights.set(target, 0);
      return { expression };
    },
    update(delta) {
      if (!manager || !Number.isFinite(delta) || delta <= 0) return;
      const blend = 1 - Math.exp(-delta / 0.18);
      for (const [name, weight] of weights) {
        const value = weight + ((name === target ? intensity : 0) - weight) * blend;
        manager.setValue(name, value < 0.001 ? 0 : value);
        if (value < 0.001 && name !== target) weights.delete(name);
        else weights.set(name, value);
      }
    },
    reset,
  };
}
