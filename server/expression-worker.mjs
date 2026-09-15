import { parentPort } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AutoTokenizer, env } from '@huggingface/transformers';
import ort from 'onnxruntime-node';

// The character expression model: a roberta-base student trained in the
// character-expression-model project to choose the VRM face from the reply as
// it streams. It reads the recent conversation, the reply so far and the face
// the character is showing, and answers with a hold probability and five raw
// channel weights. Decoding (threshold, snapping, dwell) happens in the
// browser, which owns the turn state. Everything runs on this machine; the
// tokenizer and the INT8 model ship in models/character-expression.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODEL_DIR = path.join(ROOT, 'models', 'character-expression');
const CHANNELS = ['happy', 'sad', 'angry', 'relaxed', 'surprised'];
const MAX_TOKENS = 256; // the student's training window

let loading;
async function load() {
  env.allowRemoteModels = false;
  env.localModelPath = path.join(ROOT, 'models');
  const tokenizer = await AutoTokenizer.from_pretrained('character-expression');
  const [bos, , eos] = tokenizer('a', { add_special_tokens: true }).input_ids.tolist()[0].map(Number);
  const session = await ort.InferenceSession.create(path.join(MODEL_DIR, 'expression-int8.onnx'), { intraOpNumThreads: 2 });
  return { tokenizer, session, bos, eos };
}

// Must match serialize() in scripts/train_student.py of the model project.
export function serialize(context, prefix, current) {
  const face = CHANNELS.map(c => `${c} ${(Number(current?.[c]) || 0).toFixed(2)}`).join(' ');
  const ctx = (context || []).map(t => `${t.role}: ${t.text}`).join(' ');
  return `context: ${ctx}\nreply so far: ${prefix}\nface now: ${face}`;
}

async function infer(model, context, prefix, current) {
  let ids = model.tokenizer(serialize(context, prefix, current), { add_special_tokens: false }).input_ids.tolist()[0].map(Number);
  // Left truncation, as in training: old context goes first, the reply tail and the face never do.
  if (ids.length > MAX_TOKENS - 2) ids = ids.slice(ids.length - (MAX_TOKENS - 2));
  const full = [model.bos, ...ids, model.eos];
  const shape = [1, full.length];
  const output = await model.session.run({
    input_ids: new ort.Tensor('int64', BigInt64Array.from(full.map(BigInt)), shape),
    attention_mask: new ort.Tensor('int64', BigInt64Array.from(full.map(() => 1n)), shape),
  });
  const logit = Number(output.hold_logit.data[0]);
  return { holdProb: 1 / (1 + Math.exp(-logit)), raw: Array.from(output.face.data, Number).slice(0, CHANNELS.length) };
}

parentPort?.on('message', async ({ id, context, prefix, current }) => {
  try {
    loading ||= load();
    const model = await loading;
    const result = prefix ? await infer(model, context, prefix, current) : null;
    parentPort.postMessage({ id, result });
  } catch (error) { parentPort.postMessage({ id, error: error.message }); }
});
