// Decoding for the character expression model. Mirrors snap_face() and
// decode() in scripts/train_student.py of the character-expression-model
// project, so the face the app shows is the face the model was scored on.
export const CHANNELS = ['happy', 'sad', 'angry', 'relaxed', 'surprised'];
const FORBIDDEN = [['happy', 'sad'], ['happy', 'angry']];
const round2 = v => Math.round(v * 100) / 100;
const snap = v => round2(Math.round(v / 0.05) * 0.05);

export const neutralFace = () => Object.fromEntries(CHANNELS.map(c => [c, 0]));

// holdProb >= threshold keeps the current face. Otherwise the raw weights are
// snapped to the contract: below the deadzone is zero, anything visible is at
// least 0.15 on a 0.05 grid, at most two channels, no happy beside sad or
// angry, and a sum of at most one. A result identical to the current face is a hold.
export function decodeFace(holdProb, raw, current, { threshold = 0.9, deadzone = 0.125 } = {}) {
  const now = { ...neutralFace(), ...current };
  if (!(holdProb < threshold)) return { action: 'hold', weights: now };
  const w = {};
  CHANNELS.forEach((c, i) => {
    const v = Number(raw?.[i]) || 0;
    w[c] = v >= deadzone ? Math.min(1, Math.max(0.15, snap(v))) : 0;
  });
  const nonzero = CHANNELS.filter(c => w[c] > 0).sort((a, b) => w[a] - w[b] || (a < b ? -1 : 1));
  while (nonzero.length > 2) w[nonzero.shift()] = 0;
  for (const [a, b] of FORBIDDEN) if (w[a] > 0 && w[b] > 0) { if (w[a] >= w[b]) w[b] = 0; else w[a] = 0; }
  const sum = CHANNELS.reduce((s, c) => s + w[c], 0);
  if (sum > 1) for (const c of CHANNELS) w[c] = snap(w[c] / sum);
  if (CHANNELS.every(c => Math.abs(w[c] - now[c]) < 1e-6)) return { action: 'hold', weights: now };
  return { action: 'set', weights: w };
}

export const wordCount = text => { const t = String(text || '').trim(); return t ? t.split(/\s+/).length : 0; };

export function describeFace(weights) {
  const parts = CHANNELS.filter(c => weights?.[c] > 0).map(c => `${c} ${weights[c].toFixed(2)}`);
  return parts.length ? parts.join(' + ') : 'neutral';
}

// Runs one reply: feeds the model's own decisions forward and enforces a dwell
// of a few words after any change so the face cannot flicker.
export function createFaceTracker({ threshold = 0.9, deadzone = 0.125, dwell = 6 } = {}) {
  let current = neutralFace(), lastChange = -Infinity;
  return {
    current: () => ({ ...current }),
    reset() { current = neutralFace(); lastChange = -Infinity; },
    step(holdProb, raw, wordPosition) {
      let decision = decodeFace(holdProb, raw, current, { threshold, deadzone });
      if (decision.action === 'set' && wordPosition - lastChange < dwell) decision = { action: 'hold', weights: { ...current } };
      if (decision.action === 'set') { lastChange = wordPosition; current = { ...decision.weights }; }
      return decision;
    },
  };
}
