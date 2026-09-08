import { parentPort } from 'node:worker_threads';
import { homedir } from 'node:os';
import path from 'node:path';
import { pipeline, env } from '@huggingface/transformers';

// Downloads contain model assets only. Transcript inference stays on this machine.
env.cacheDir = path.join(homedir(), '.three-assistant-glass', 'emotion-models');
let classifier;
parentPort.on('message', async ({ id, text }) => {
  try {
    classifier ||= await pipeline('text-classification', 'SamLowe/roberta-base-go_emotions-onnx', {
      dtype: 'q8', device: 'cpu', session_options: { intraOpNumThreads: 2 },
    });
    const scores = text ? await classifier(text, { top_k: 28, truncation: true, max_length: 128 }) : null;
    parentPort.postMessage({ id, scores });
  } catch (error) { parentPort.postMessage({ id, error: error.message }); }
});
