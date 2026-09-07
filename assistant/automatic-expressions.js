const MAP = {
  joy: 'happy', amusement: 'happy', excitement: 'happy', love: 'happy', gratitude: 'happy', admiration: 'happy', optimism: 'happy', pride: 'happy',
  sadness: 'sad', grief: 'sad', disappointment: 'sad', remorse: 'sad',
  anger: 'angry', annoyance: 'angry', disgust: 'angry',
  caring: 'relaxed', relief: 'relaxed', surprise: 'surprised', neutral: 'neutral',
};

export function chooseExpression(scores, supported, previous = 'neutral') {
  const grouped = { neutral: 0 };
  for (const { label, score } of scores || []) {
    const name = MAP[label];
    if (name && supported.includes(name) && Number.isFinite(score)) grouped[name] = Math.max(grouped[name] || 0, score);
  }
  const [name, confidence] = Object.entries(grouped).sort((a, b) => b[1] - a[1])[0];
  if (confidence < 0.4 || name === 'neutral') return { expression: 'neutral', intensity: 0 };
  // Keep the previous emotion when two plausible classes are nearly tied.
  const expression = grouped[previous] >= 0.4 && confidence - grouped[previous] < 0.15 ? previous : name;
  return { expression, intensity: Math.min(0.85, 0.35 + grouped[expression] * 0.5) };
}

async function classify(text, signal) {
  const response = await fetch('/api/emotions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Assistant-Request': '1' },
    body: JSON.stringify({ text }), signal,
  });
  if (!response.ok) throw new Error('Automatic expressions unavailable');
  return (await response.json()).scores;
}

export function createAutomaticExpressions(ui, request = classify) {
  let enabled = false, ready = false, controller, timer, pending = '', last = '', busy = false, generation = 0, turn = 0, previous = 'neutral';
  function reset() {
    turn++; pending = last = ''; previous = 'neutral'; clearTimeout(timer); timer = null;
    ui.onExpressionReset?.();
  }
  function schedule() {
    if (!timer && pending && ready && !busy) timer = setTimeout(() => { timer = null; void run(); }, 350);
  }
  async function run() {
    if (!enabled || !ready || busy || !pending || pending === last) return;
    const text = pending, version = generation, turnId = turn;
    pending = ''; last = text; busy = true;
    try {
      const scores = await request(text, controller.signal);
      if (!enabled || generation !== version || turn !== turnId) return;
      const command = chooseExpression(scores, ui.getExpressions?.() || [], previous);
      previous = command.expression;
      ui.onExpression?.(command);
      ui.onExpressionStatus?.(`Expression: ${command.expression}`);
    } catch (error) {
      if (enabled && generation === version) { ready = false; reset(); ui.onExpressionStatus?.('Automatic expressions unavailable'); }
    } finally { if (generation === version) { busy = false; schedule(); } }
  }
  return {
    async setEnabled(value) {
      if (enabled === value) return;
      enabled = value; generation++; controller?.abort(); reset(); busy = false; ready = false;
      ui.onExpressionStatus?.('');
      if (!enabled) return;
      controller = new AbortController();
      const version = generation;
      ui.onExpressionStatus?.('Loading automatic expressions…');
      try {
        await request('', controller.signal);
        if (!enabled || generation !== version) return;
        ready = true; ui.onExpressionStatus?.('Automatic expressions ready'); schedule();
      } catch { if (enabled && generation === version) ui.onExpressionStatus?.('Automatic expressions unavailable'); }
    },
    transcript(text, newTurn = false) {
      if (!enabled) return;
      if (newTurn) { turn++; pending = last = ''; }
      const context = text.trim().slice(-600);
      if (context.length < 16 || context === last) return;
      pending = context; schedule();
    },
    reset,
    stop() { void this.setEnabled(false); },
  };
}
