import express from 'express';
import { appendFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { localCodexRequest } from './codex-routes.mjs';

const CHANNELS = ['happy', 'sad', 'angry', 'relaxed', 'surprised'];

export function automaticExpressionsEnabled(settings) {
  return ['llmAutoExpressions', 'realtimeAutoExpressions', 'codexAutoExpressions'].some(key => settings[key] === true);
}

// One lazily started worker per model, one message in flight at a time. The
// worker is unref'd so it never keeps the server alive, and it is torn down
// after two minutes of silence or on any error.
//
// Overlapping calls queue rather than fail. Three surfaces drive expressions
// independently (realtime, codex and the LLM pipeline), each with its own poll
// timer, so their requests do collide - at minimum when two of them warm up at
// once. Rejecting the loser used to switch expressions off on that surface for
// the rest of the session, leaving the avatar frozen on its last face.
const MAX_WAITING = 8;

export function createEmotionService(workerFile = './emotion-worker.mjs') {
  let worker = null, pending = null, sequence = 0, waiting = 0, chain = Promise.resolve();
  function close() {
    const old = worker;
    worker = null;
    if (pending) { clearTimeout(pending.timer); pending.reject(new Error('Expression model stopped.')); pending = null; }
    void old?.terminate();
  }
  function send(payload) {
    if (!worker) {
      const current = worker = new Worker(new URL(workerFile, import.meta.url), { execArgv: process.execArgv.filter(arg => !arg.startsWith('--input-type')) });
      current.on('message', message => {
        if (worker !== current || pending?.id !== message.id) return;
        const request = pending; pending = null; clearTimeout(request.timer);
        if (message.error) request.reject(new Error(message.error)); else request.resolve(message.result);
      });
      current.on('error', () => { if (worker === current) close(); });
      current.on('exit', () => { if (worker === current) close(); });
      current.unref();
    }
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(close, 120000);
      pending = { id, resolve, reject, timer };
      worker.postMessage({ id, ...payload });
    });
  }
  return {
    close,
    async run(payload = {}) {
      // A real pile-up is still a fault worth reporting; a couple of racing pollers is not.
      if (waiting >= MAX_WAITING) throw Object.assign(new Error('Expression model is busy.'), { status: 429 });
      waiting++;
      const mine = chain.then(() => send(payload), () => send(payload));
      chain = mine.catch(() => {});
      try { return await mine; } finally { waiting--; }
    },
  };
}

function cleanContext(turns) {
  if (!Array.isArray(turns)) return [];
  return turns
    .filter(t => t && (t.role === 'user' || t.role === 'assistant') && typeof t.text === 'string' && t.text.trim())
    .slice(-6)
    .map(t => ({ role: t.role, text: t.text.trim().slice(0, 600) }));
}

function cleanWeights(face) {
  const out = {};
  for (const c of CHANNELS) { const v = Number(face?.[c]); out[c] = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0; }
  return out;
}

// One line per model call so a quiet face can be told from a broken one:
// the word count, the hold probability (a change needs it under 0.90) and the
// strongest raw channel. Set THREE_ASSISTANT_EXPRESSION_LOG=0 to silence it.
// Every call is also appended as JSON to ~/.three-assistant-glass/expressions.log
// so a session can be reviewed afterwards without the terminal.
const LOG_FILE = path.join(homedir(), '.three-assistant-glass', 'expressions.log');
let logged = 0;
function logDecision(prefix, face, context) {
  if (process.env.THREE_ASSISTANT_EXPRESSION_LOG === '0') return;
  if (!face) { console.log('[expressions] character model ready'); return; }
  const words = prefix.trim() ? prefix.trim().split(/\s+/).length : 0;
  const top = CHANNELS.map((c, i) => [c, face.raw[i]]).sort((a, b) => b[1] - a[1])[0];
  const wants = face.holdProb < 0.9;
  if (wants || logged++ % 10 === 0) {
    console.log(`[expressions] word ${words}: ${wants ? 'CHANGE' : 'hold'} p(hold)=${face.holdProb.toFixed(2)} top ${top[0]} ${top[1].toFixed(2)} | …${prefix.trim().slice(-50)}`);
  }
  const row = { at: new Date().toISOString(), words, holdProb: Number(face.holdProb.toFixed(4)), raw: face.raw.map(v => Number(v.toFixed(3))),
                user: context.at(-1)?.text?.slice(0, 200) || '', prefix: prefix.slice(-400) };
  appendFile(LOG_FILE, JSON.stringify(row) + '\n').catch(() => {});
}

// POST /api/emotions. The response says which model answered:
//   { model: 'character', face: { holdProb, raw: [5] } | null }   the trained character model
//   { model: 'goemotions', scores: [{ label, score }] | null }     the original GoEmotions classifier
// An empty request warms the model up and returns null for the result.
export function createEmotionRouter(services, getSettings) {
  const router = express.Router();
  router.use(localCodexRequest, express.json({ limit: '64kb' }));
  router.post('/', async (req, res) => {
    const s = getSettings();
    if (!automaticExpressionsEnabled(s)) {
      return res.status(403).json({ error: 'Automatic expressions are off.' });
    }
    const model = s.expressionModel === 'goemotions' ? 'goemotions' : 'character';
    const body = req.body || {};
    const prefix = typeof body.prefix === 'string' ? body.prefix : typeof body.text === 'string' ? body.text : null;
    if (prefix === null || prefix.length > 20000) return res.status(400).json({ error: 'Expected reply text of up to 20,000 characters.' });
    try {
      if (model === 'goemotions') {
        const text = prefix.slice(-1000);
        const scores = await services.goemotions.run({ text });
        return res.json({ model, scores });
      }
      const context = cleanContext(body.context);
      const face = await services.character.run({ prefix, context, current: cleanWeights(body.current) });
      logDecision(prefix, face, context);
      res.json({ model, face });
    } catch (error) {
      console.warn(`[expressions] request failed: ${error.message}`);
      res.status(error.status || 503).json({ error: 'Expression model unavailable. Voice can continue.' });
    }
  });
  return router;
}
