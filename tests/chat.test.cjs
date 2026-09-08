const { test } = require('node:test');
const assert = require('node:assert/strict');

const encoder = new TextEncoder();
function sse(frames) {
  return frames.map((f) => (typeof f === 'string' ? f : `data: ${JSON.stringify(f)}\n\n`));
}
async function* chunks(parts) {
  for (const part of parts) yield encoder.encode(part);
}
function response(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status < 400,
    status,
    body: chunks(Array.isArray(body) ? body : [text]),
    text: async () => text,
    json: async () => body,
  };
}
function fakeTools(calls = []) {
  return {
    definitions: () => [{ type: 'function', function: { name: 'get_time', description: 'time', parameters: { type: 'object', properties: {} } } }],
    label: (name) => `Running ${name}`,
    async run(name, args) { calls.push({ name, args }); return { time: '3:42 PM' }; },
  };
}
const base = { baseUrl: 'http://llm', apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }] };

test('streaming tool calls are assembled from fragments, run, and fed back before the final answer', async () => {
  const { createChatRunner } = await import('../server/chat.mjs');
  const requests = [];
  const fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    if (requests.length === 1) {
      return response(200, sse([
        { choices: [{ delta: { content: 'Let me check. ' } }] },
        // OpenAI-style: id + name first, arguments spread over frames, all keyed by index
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_', arguments: '' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'time', arguments: '{' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        'data: [DONE]\n\n',
      ]));
    }
    return response(200, sse([{ choices: [{ delta: { content: 'It is 3:42 PM.' } }] }, 'data: [DONE]\n\n']));
  };
  const deltas = [], toolEvents = [], calls = [];
  const runner = createChatRunner({ fetch });
  const text = await runner.run({ ...base, tools: fakeTools(calls), onDelta: (d) => deltas.push(d), onToolCall: (t) => toolEvents.push(t) });

  assert.equal(text, 'It is 3:42 PM.');
  assert.deepEqual(deltas, ['Let me check. ', 'It is 3:42 PM.']);
  assert.deepEqual(toolEvents, [{ name: 'get_time', label: 'Running get_time' }]);
  assert.deepEqual(calls, [{ name: 'get_time', args: {} }]);
  assert.equal(requests.length, 2);
  assert.ok(requests[0].stream && requests[0].tools.length === 1);
  const followUp = requests[1].messages;
  assert.deepEqual(followUp.slice(-2), [
    { role: 'assistant', content: 'Let me check. ', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_time', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: JSON.stringify({ time: '3:42 PM' }) },
  ]);
});

test('non-streaming responses deliver the text as one delta and run tool calls the same way', async () => {
  const { createChatRunner } = await import('../server/chat.mjs');
  const requests = [];
  const fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    if (requests.length === 1) {
      return response(200, { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'abc', type: 'function', function: { name: 'get_time', arguments: '' } }] } }] });
    }
    return response(200, { choices: [{ message: { role: 'assistant', content: 'Quarter to four.' } }] });
  };
  const deltas = [], calls = [];
  const text = await createChatRunner({ fetch }).run({ ...base, stream: false, tools: fakeTools(calls), onDelta: (d) => deltas.push(d) });
  assert.equal(text, 'Quarter to four.');
  assert.deepEqual(deltas, ['Quarter to four.']);
  assert.deepEqual(calls, [{ name: 'get_time', args: {} }]);
  assert.equal(requests[0].stream, false);
  assert.equal(requests[1].messages.at(-1).tool_call_id, 'abc');
});

test('SSE frames split across chunks and servers that omit tool-call indexes still parse', async () => {
  const { readStreamedCompletion } = await import('../server/chat.mjs');
  const frames = sse([
    { choices: [{ delta: { content: 'Hel' } }] },
    { choices: [{ delta: { content: 'lo' } }] },
    { choices: [{ delta: { tool_calls: [{ id: 'x', function: { name: 'open_url', arguments: '{"url":"https://a.b"}' } }] } }] },
  ]).join('');
  const split = [frames.slice(0, 20), frames.slice(20, 61), frames.slice(61)];
  const result = await readStreamedCompletion(chunks(split));
  assert.equal(result.content, 'Hello');
  assert.deepEqual(result.toolCalls, [{ id: 'x', name: 'open_url', arguments: '{"url":"https://a.b"}' }]);
});

test('a provider that rejects tools gets one retry without them and is remembered', async () => {
  const { createChatRunner } = await import('../server/chat.mjs');
  const requests = [];
  const fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    if (body.tools) return response(400, '{"error":"llama3.2 does not support tools"}');
    return response(200, sse([{ choices: [{ delta: { content: 'ok' } }] }]));
  };
  const runner = createChatRunner({ fetch });
  assert.equal(await runner.run({ ...base, tools: fakeTools() }), 'ok');
  assert.equal(await runner.run({ ...base, tools: fakeTools() }), 'ok');
  assert.deepEqual(requests.map((r) => Boolean(r.tools)), [true, false, false]);
});

test('other upstream failures surface status and body', async () => {
  const { createChatRunner, UpstreamError } = await import('../server/chat.mjs');
  const fetch = async () => response(401, 'bad key');
  await assert.rejects(createChatRunner({ fetch }).run({ ...base }), (err) => err instanceof UpstreamError && err.status === 401 && err.body === 'bad key');
});

test('malformed tool arguments are reported to the model instead of crashing the turn', async () => {
  const { createChatRunner } = await import('../server/chat.mjs');
  const requests = [];
  const fetch = async (url, options) => {
    requests.push(JSON.parse(options.body));
    if (requests.length === 1) return response(200, { choices: [{ message: { tool_calls: [{ id: '1', function: { name: 'get_time', arguments: '{oops' } }] } }] });
    return response(200, { choices: [{ message: { content: 'done' } }] });
  };
  const calls = [];
  await createChatRunner({ fetch }).run({ ...base, stream: false, tools: fakeTools(calls) });
  assert.equal(calls.length, 0);
  assert.match(requests[1].messages.at(-1).content, /not valid JSON/);
});

test('system prompt placeholders are coarse and unknown ones are left alone', async () => {
  const { promptVariables, renderPrompt, renderSystemMessages } = await import('../server/prompt.mjs');
  const vars = promptVariables({ now: new Date('2026-09-07T22:42:00Z'), timeZone: 'America/Los_Angeles' });
  assert.deepEqual(vars, { date: 'Monday, September 7, 2026', hour: '3 PM', timezone: 'America/Los_Angeles' });
  assert.equal(renderPrompt('It is {{ date }} at about {{hour}} ({{timezone}}) {{minute}}', vars),
    'It is Monday, September 7, 2026 at about 3 PM (America/Los_Angeles) {{minute}}');
  const messages = renderSystemMessages([{ role: 'system', content: '{{date}}' }, { role: 'user', content: '{{date}}' }], vars);
  assert.equal(messages[0].content, 'Monday, September 7, 2026');
  assert.equal(messages[1].content, '{{date}}');
});

test('tools: definitions are stable, open_url only opens http(s), get_time is exact', async () => {
  const { createTools } = await import('../server/tools.mjs');
  const opened = [];
  const tools = createTools({ openUrl: async (u) => opened.push(u), now: () => new Date('2026-09-07T22:42:00Z'), timeZone: 'America/Los_Angeles' });
  assert.deepEqual(JSON.stringify(tools.definitions()), JSON.stringify(tools.definitions()));
  assert.deepEqual(tools.definitions().map((d) => d.function.name), ['get_time', 'open_url']);

  assert.deepEqual(await tools.run('open_url', { url: 'file:///etc/passwd' }), { error: 'Only http and https URLs can be opened' });
  assert.deepEqual(await tools.run('open_url', { url: 'not a url' }), { error: 'Invalid URL' });
  assert.deepEqual(await tools.run('open_url', { url: 'https://example.com' }), { opened: 'https://example.com/' });
  assert.deepEqual(opened, ['https://example.com/']);
  assert.match((await tools.run('nope')).error, /Unknown tool/);
  const time = await tools.run('get_time');
  assert.equal(time.time, '3:42 PM');
  assert.equal(tools.label('open_url'), 'Opening a link…');
});
