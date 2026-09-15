import { CHANNELS, createFaceTracker, describeFace, wordCount } from './expression-decoder.js';

// GoEmotions labels folded onto the character's channels (the original classifier).
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

// The strongest channel of a multi-channel face, for characters wired only for single expressions.
function dominant(weights) {
  const name = CHANNELS.filter(c => weights[c] > 0).sort((a, b) => weights[b] - weights[a])[0];
  return name ? { expression: name, intensity: weights[name] } : { expression: 'neutral', intensity: 0 };
}

async function classify(payload, signal) {
  const response = await fetch('/api/emotions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Assistant-Request': '1' },
    body: JSON.stringify(payload), signal,
  });
  if (!response.ok) throw new Error('Automatic expressions unavailable');
  return response.json();
}

// The server picks the model (Settings → Assistant → Expression model) and says
// which one answered. With the character model every request carries the whole
// reply so far, the recent context and the face being shown, and the answer is
// decoded here at one decision per step with a dwell against flicker. With
// GoEmotions the last 600 characters are classified and mapped as before.
export function createAutomaticExpressions(ui, request = classify) {
  let enabled = false, ready = false, controller, timer, pending = '', last = '', inFlight = null, generation = 0, turn = 0;
  let settleTimer = null, ended = false;
  let previous = 'neutral', model = 'goemotions', context = [], recovery = null;
  const face = createFaceTracker();
  const character = () => model === 'character';
  function cancelWork() {
    turn++; pending = last = ''; clearTimeout(timer); timer = null;
    inFlight?.controller.abort(); inFlight = null;
  }
  function reset() {
    cancelWork(); clearTimeout(settleTimer); settleTimer = null; ended = false;
    previous = 'neutral'; face.reset();
    ui.onExpressionReset?.();
  }
  function endReply() {
    if (!enabled || ended) return;
    ended = true;
    // Let the final spoken prefix finish inference, then retire this turn before fading.
    const turnId = turn;
    settleTimer = setTimeout(() => {
      settleTimer = null;
      if (!enabled || turn !== turnId) return;
      cancelWork(); face.reset(); previous = 'neutral';
      if (ui.onExpressionSettle) ui.onExpressionSettle(1.5);
      else if (ui.onExpressionWeights) ui.onExpressionWeights(face.current());
      else ui.onExpression?.({ expression: 'neutral', intensity: 0 });
      ui.onExpressionStatus?.('Expression: neutral');
    }, 2000);
  }
  function schedule() {
    if (!timer && pending && ready && !inFlight) timer = setTimeout(() => { timer = null; void run(); }, 350);
  }
  const payloadFor = text => (character() ? { prefix: text, context, current: face.current() } : { text });
  async function run() {
    if (!enabled || !ready || inFlight || !pending || pending === last) return;
    const text = pending, version = generation, turnId = turn, words = wordCount(text);
    const job = { controller: new AbortController() };
    pending = ''; last = text; inFlight = job;
    try {
      const response = await request(payloadFor(text), job.controller.signal);
      if (!enabled || generation !== version || turn !== turnId) return;
      if (response && !Array.isArray(response) && 'face' in response) {
        if (!response.face) return;
        const decision = face.step(Number(response.face.holdProb), response.face.raw, words);
        console.debug(`[expressions] word ${words}: ${decision.action} p(hold)=${Number(response.face.holdProb).toFixed(2)} face ${describeFace(decision.weights)}`);
        if (decision.action !== 'set') return;
        if (ui.onExpressionWeights) ui.onExpressionWeights(decision.weights); else ui.onExpression?.(dominant(decision.weights));
        console.info(`[expressions] set ${describeFace(decision.weights)} at word ${words}`);
        ui.onExpressionStatus?.(`Expression: ${describeFace(decision.weights)}`);
      } else {
        const scores = Array.isArray(response) ? response : response?.scores;
        const command = chooseExpression(scores, ui.getExpressions?.() || [], previous);
        previous = command.expression;
        ui.onExpression?.(command);
        ui.onExpressionStatus?.(`Expression: ${command.expression}`);
      }
    } catch (error) {
      if (enabled && generation === version && turn === turnId) { ready = false; reset(); ui.onExpressionStatus?.('Automatic expressions unavailable'); recover(version); }
    } finally { if (inFlight === job) { inFlight = null; schedule(); } }
  }
  // One failed request is usually a collision or a hiccup, not a dead model, so try to
  // come back rather than leaving the face frozen until the setting is toggled.
  function recover(version, attempt = 1) {
    if (!enabled || generation !== version || recovery || attempt > 5) return;
    recovery = setTimeout(async () => {
      recovery = null;
      if (!enabled || generation !== version) return;
      try {
        const warm = await request({ text: '', prefix: '' }, controller.signal);
        if (!enabled || generation !== version) return;
        model = warm && !Array.isArray(warm) && warm.model === 'character' ? 'character' : 'goemotions';
        ready = true;
        ui.onExpressionStatus?.(`Automatic expressions ready (${character() ? 'character model' : 'GoEmotions'})`);
        schedule();
      } catch { recover(version, attempt + 1); }
    }, Math.min(8000, 500 * 2 ** (attempt - 1)));
  }
  return {
    async setEnabled(value) {
      if (enabled === value) return;
      enabled = value; generation++; controller?.abort(); reset(); ready = false;
      clearTimeout(recovery); recovery = null;
      ui.onExpressionStatus?.('');
      if (!enabled) return;
      controller = new AbortController();
      const version = generation;
      ui.onExpressionStatus?.('Loading automatic expressions…');
      try {
        const warm = await request({ text: '', prefix: '' }, controller.signal);
        if (!enabled || generation !== version) return;
        model = warm && !Array.isArray(warm) && warm.model === 'character' ? 'character' : 'goemotions';
        ready = true; ui.onExpressionStatus?.(`Automatic expressions ready (${character() ? 'character model' : 'GoEmotions'})`); schedule();
      } catch { if (enabled && generation === version) ui.onExpressionStatus?.('Automatic expressions unavailable'); }
    },
    // Recent conversation turns, oldest first; the character model reads them.
    setContext(turns) {
      context = (Array.isArray(turns) ? turns : [])
        .filter(t => t && (t.role === 'user' || t.role === 'assistant') && typeof t.text === 'string' && t.text.trim())
        .slice(-6).map(t => ({ role: t.role, text: t.text.trim().slice(0, 600) }));
    },
    transcript(text, newTurn = false) {
      if (!enabled) return;
      if (newTurn) {
        // Every trained trajectory starts a reply from neutral.
        reset();
      }
      if (ended) return;
      const body = text.trim();
      const chunk = character() ? body.slice(-12000) : body.slice(-600);
      if (chunk.length < (character() ? 1 : 16) || chunk === last) return;
      pending = chunk; schedule();
    },
    reset,
    interrupt: reset,
    endReply,
    stop() { void this.setEnabled(false); },
  };
}
