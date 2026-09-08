// Runs one assistant turn against an OpenAI-compatible chat completions API:
// sends the messages (plus tool definitions), executes any tool calls the
// model makes, feeds the results back and repeats until the model answers in
// plain text. Works with streaming and non-streaming upstreams; the caller
// sees the same onDelta / onToolCall callbacks either way.
//
// Providers that reject the `tools` field (e.g. Ollama with a model that has
// no tool support) get one retry without tools, and the (baseUrl, model) pair
// is remembered so later turns skip the failed request.

const MAX_TOOL_ROUNDS = 5;

export class UpstreamError extends Error {
  constructor(status, body) {
    super(`upstream ${status}: ${body.slice(0, 500)}`);
    this.status = status;
    this.body = body;
  }
}

export function createChatRunner({ fetch: fetchImpl = globalThis.fetch } = {}) {
  const toolsUnsupported = new Set();

  async function request({ baseUrl, apiKey, model, messages, tools, stream, signal }) {
    const body = { model, messages, stream };
    if (tools) body.tools = tools;
    return fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal,
    });
  }

  return {
    async run({ baseUrl, apiKey, model, messages, tools = null, stream = true, signal, onDelta, onToolCall }) {
      const key = `${baseUrl}|${model}`;
      const history = [...messages];
      let definitions = tools && !toolsUnsupported.has(key) ? tools.definitions() : null;
      if (definitions && definitions.length === 0) definitions = null;

      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        let upstream = await request({ baseUrl, apiKey, model, messages: history, tools: definitions, stream, signal });
        if (!upstream.ok && definitions && looksLikeToolRejection(upstream.status)) {
          console.warn(`[assistant/chat] ${model} rejected tools (${upstream.status}); retrying without them`);
          toolsUnsupported.add(key);
          definitions = null;
          upstream = await request({ baseUrl, apiKey, model, messages: history, tools: null, stream, signal });
        }
        if (!upstream.ok) throw new UpstreamError(upstream.status, await upstream.text());

        const turn = stream
          ? await readStreamedCompletion(upstream.body, onDelta)
          : readCompletion(await upstream.json(), onDelta);

        if (!definitions || turn.toolCalls.length === 0) return turn.content;

        history.push({
          role: 'assistant',
          content: turn.content || null,
          tool_calls: turn.toolCalls.map((call) => ({
            id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments },
          })),
        });
        for (const call of turn.toolCalls) {
          onToolCall?.({ name: call.name, label: tools.label(call.name) });
          const args = parseArguments(call.arguments);
          const result = args.error ? args : await tools.run(call.name, args.value);
          history.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
        }
      }
      throw new Error(`Gave up after ${MAX_TOOL_ROUNDS} rounds of tool calls`);
    },
  };
}

function looksLikeToolRejection(status) {
  return status === 400 || status === 404 || status === 422;
}

export function parseArguments(text) {
  if (!text || !text.trim()) return { value: {} };
  try {
    const value = JSON.parse(text);
    return typeof value === 'object' && value !== null ? { value } : { error: 'Tool arguments must be a JSON object' };
  } catch {
    return { error: `Tool arguments were not valid JSON: ${text.slice(0, 200)}` };
  }
}

// ─── Response parsing ─────────────────────────────────────────────────────────

// Non-streaming: one JSON body with the full message
export function readCompletion(json, onDelta) {
  const message = json?.choices?.[0]?.message || {};
  const content = typeof message.content === 'string' ? message.content : '';
  if (content) onDelta?.(content);
  const toolCalls = (message.tool_calls || [])
    .filter((call) => call?.function?.name)
    .map((call, index) => ({
      id: call.id || `call_${index}`,
      name: call.function.name,
      arguments: call.function.arguments || '',
    }));
  return { content, toolCalls };
}

// Streaming: SSE frames with content deltas and tool-call fragments. A call's
// name and arguments arrive spread over many frames, keyed by `index`; some
// servers omit the index and send each call in one frame.
export async function readStreamedCompletion(body, onDelta) {
  let content = '';
  const calls = new Map(); // index → { id, name, arguments }

  for await (const data of sseData(body)) {
    let json;
    try { json = JSON.parse(data); } catch { continue; }
    const delta = json.choices?.[0]?.delta;
    if (!delta) continue;
    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content;
      onDelta?.(delta.content);
    }
    for (const [position, fragment] of (delta.tool_calls || []).entries()) {
      const index = Number.isInteger(fragment.index) ? fragment.index : calls.size + position;
      const call = calls.get(index) || { id: '', name: '', arguments: '' };
      if (fragment.id) call.id = fragment.id;
      if (fragment.function?.name) call.name += fragment.function.name;
      if (fragment.function?.arguments) call.arguments += fragment.function.arguments;
      calls.set(index, call);
    }
  }

  const toolCalls = [...calls.entries()]
    .sort(([a], [b]) => a - b)
    .filter(([, call]) => call.name)
    .map(([index, call]) => ({ ...call, id: call.id || `call_${index}` }));
  return { content, toolCalls };
}

// Yields the payload of each `data:` line, handling frames split across chunks
export async function* sseData(body) {
  const decoder = new TextDecoder();
  let pending = '';
  for await (const chunk of body) {
    pending += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data && data !== '[DONE]') yield data;
    }
  }
  const last = pending.trim();
  if (last.startsWith('data:')) {
    const data = last.slice(5).trim();
    if (data && data !== '[DONE]') yield data;
  }
}
