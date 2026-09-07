import express from 'express';
import { Worker } from 'node:worker_threads';
import { localCodexRequest } from './codex-routes.mjs';

export function createEmotionService() {
  let worker = null, pending = null, sequence = 0;
  function close() {
    const old = worker;
    worker = null;
    if (pending) { clearTimeout(pending.timer); pending.reject(new Error('Expression model stopped.')); pending = null; }
    void old?.terminate();
  }
  return {
    close,
    async run(text = '') {
      if (pending) throw Object.assign(new Error('Expression model is busy.'), { status: 429 });
      if (!worker) {
        const current = worker = new Worker(new URL('./emotion-worker.mjs', import.meta.url), { execArgv: process.execArgv.filter(arg => !arg.startsWith('--input-type')) });
        current.on('message', message => {
          if (worker !== current || pending?.id !== message.id) return;
          const request = pending; pending = null; clearTimeout(request.timer);
          if (message.error) request.reject(new Error(message.error)); else request.resolve(message.scores);
        });
        current.on('error', () => { if (worker === current) close(); });
        current.on('exit', () => { if (worker === current) close(); });
        current.unref();
      }
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(close, 120000);
        pending = { id, resolve, reject, timer };
        worker.postMessage({ id, text });
      });
    },
  };
}

export function createEmotionRouter(service, getSettings) {
  const router = express.Router();
  router.use(localCodexRequest, express.json({ limit: '8kb' }));
  router.post('/', async (req, res) => {
    if (getSettings().codexAutoExpressions !== true) return res.status(403).json({ error: 'Automatic expressions are off.' });
    const text = req.body?.text;
    if (typeof text !== 'string' || text.length > 1000) return res.status(400).json({ error: 'Expected up to 1,000 characters.' });
    try {
      const scores = await service.run(text);
      res.json({ scores });
    } catch (error) { res.status(error.status || 503).json({ error: 'Expression model unavailable. Voice can continue.' }); }
  });
  return router;
}
