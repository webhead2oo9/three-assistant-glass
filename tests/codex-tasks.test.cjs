const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { realpathSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { load } = require('./browser-modules.cjs');

async function serverHarness() {
  const { createCodexTaskHandler } = await import('../server/codex-tasks.mjs');
  const client = new EventEmitter(), messages = [], replies = [];
  const session = { threadId: 'thread', closed: false };
  const handler = createCodexTaskHandler(client, {
    sessions: new Map([['session', session]]), emit: (s, type, data) => messages.push({ type, ...data }),
  });
  return { session, handler, messages, replies,
    notify: (method, params) => handler.notification({ method, params: { threadId: 'thread', ...params } }),
    ask: (method, params = {}) => client.emit('request', {
      id: 'rpc-id', method, params: { threadId: 'thread', turnId: 'turn', itemId: 'item', ...params },
    }, (result, error) => replies.push({ result, error })),
  };
}

test('web activity labels distinguish searches, page opens, and in-page finds', async () => {
  const h = await serverHarness();
  const cases = [
    [{ query: 'legacy query' }, 'Search: legacy query'],
    [{ query: '', action: { type: 'search', query: 'nested query' } }, 'Search: nested query'],
    [{ action: { type: 'search', queries: ['first query', ' ', 'second query'] } }, 'Search: first query\nsecond query'],
    [{ query: '', action: { type: 'openPage', url: 'https://example.com' } }, 'Open page: https://example.com'],
    [{ query: '', action: { type: 'findInPage', url: 'https://example.com', pattern: 'headset' } }, 'Find in page: headset\nPage: https://example.com'],
    [{ action: { type: 'openPage', url: null } }, 'Open page'],
    [{ action: { type: 'findInPage', pattern: null, url: null } }, 'Find in page'],
    [{ action: { type: 'search', query: null, queries: null } }, 'Web search'],
    [{ query: '', action: { type: 'other' } }, 'Web activity'],
  ];
  for (const [fields, expected] of cases) {
    for (const method of ['item/started', 'item/completed']) {
      h.notify(method, { item: { id: 'web', type: 'webSearch', ...fields } });
      assert.equal(h.messages.at(-1).text, expected);
    }
  }
});

test('file approvals include the full proposed diff and cannot accept missing review data', async () => {
  const h = await serverHarness();
  h.ask('item/fileChange/requestApproval');
  let request = h.messages.at(-1);
  assert.equal(request.decisions.includes('accept'), false);
  assert.throws(() => h.handler.reply(h.session, request.requestId, { decision: 'accept' }), /Invalid approval/);
  h.handler.reply(h.session, request.requestId, { decision: 'decline' });
  const changes = [{ path: '/workspace/example.txt', kind: { type: 'update' }, diff: '-old\n+new' }];
  h.notify('item/started', { item: { id: 'item', type: 'fileChange', changes } });
  h.ask('item/fileChange/requestApproval');
  request = h.messages.at(-1);
  assert.deepEqual(request.details.changes, changes);
  h.handler.reply(h.session, request.requestId, { decision: 'accept' });
  assert.deepEqual(h.replies.at(-1).result, { decision: 'accept' });
});

test('permissions grant only the server-requested access for one turn', async () => {
  const h = await serverHarness();
  const permissions = { network: { enabled: true } };
  h.ask('item/permissions/requestApproval', { permissions });
  const request = h.messages.at(-1);
  h.handler.reply(h.session, request.requestId, { decision: 'accept', permissions: { fileSystem: { write: ['/'] } }, scope: 'session' });
  assert.deepEqual(h.replies[0].result, { permissions, scope: 'turn' });
});

test('clarification answers are validated and native request resolution invalidates stale forms', async () => {
  const h = await serverHarness();
  h.ask('item/tool/requestUserInput', { questions: [{ id: 'choice', question: 'Choose a folder' }] });
  const request = h.messages.at(-1);
  assert.throws(() => h.handler.reply(h.session, request.requestId, { answers: {} }), /Answer each question/);
  h.handler.reply(h.session, request.requestId, { answers: { choice: 'documents', unknown: 'ignored' } });
  assert.equal(JSON.stringify(h.replies[0].result), '{"answers":{"choice":{"answers":["documents"]}}}');
  h.ask('item/tool/requestUserInput', { questions: [{ id: 'choice', question: 'Another question?' }] });
  const stale = h.messages.at(-1);
  h.notify('serverRequest/resolved', { requestId: 'rpc-id' });
  assert.equal(h.messages.at(-1).type, 'codex/task/requestResolved');
  assert.throws(() => h.handler.reply(h.session, stale.requestId, { answers: { choice: 'late' } }), /already ended/);
});

test('unowned and oversized requests fail explicitly without presenting an approval', async () => {
  const h = await serverHarness();
  h.ask('item/tool/call');
  h.ask('item/commandExecution/requestApproval', { threadId: 'other', command: 'test' });
  h.ask('item/commandExecution/requestApproval', { command: 'x'.repeat(100000) });
  assert.equal(h.messages.length, 0);
  assert.deepEqual(h.replies.map(r => r.error.code), [-32601, -32601, -32602]);
});

test('task model and workspace configuration preserve the backing agent instructions', async () => {
  const { codexTaskConfig } = await import('../server/codex-tasks.mjs');
  const config = await codexTaskConfig({ codexWorkspace: tmpdir(), codexTaskModel: 'task-model', codexModel: 'voice-model' }, '/unused');
  assert.equal(config.cwd, realpathSync(tmpdir()));
  assert.equal(config.model, 'task-model');
  assert.equal(config.baseInstructions, undefined);
  await assert.rejects(codexTaskConfig({ codexWorkspace: __filename }, tmpdir()), /not a folder/);
  await assert.rejects(codexTaskConfig({ codexTaskModel: 'bad model' }, tmpdir()), /Invalid task model/);
});

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.textContent = ''; this.value = ''; this.listeners = {}; }
  append(child) { this.children.push(child); child.parent = this; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  click() { if (!this.disabled) this.listeners.click?.(); }
  all(tag) { return this.children.flatMap(c => [...(c.tag === tag ? [c] : []), ...c.all(tag)]); }
  querySelectorAll(tags) { return tags.split(', ').flatMap(tag => this.all(tag)); }
}

async function browserHarness(api) {
  const body = new Element('body'), calls = [];
  const { createCodexTaskHandler } = await load('assistant/codex-tasks.js', {
    document: { body, createElement: tag => new Element(tag) },
  }, { 'assistant/codex-api.js': { codexRequest: async (url, data) => {
    calls.push({ url, data }); return api?.();
  } } });
  return { body, calls, handler: createCodexTaskHandler('session'), button: text => body.all('button').find(b => b.textContent === text) };
}

test('Codex task panel safely renders results and sends explicit approval choices', async () => {
  const h = await browserHarness();
  h.handler.handle({ type: 'codex/task/output', itemId: 'one', text: '<script>untrusted</script>' });
  assert.equal(h.body.all('script').length, 0);
  assert.equal(h.body.all('pre')[0].textContent, '<script>untrusted</script>');
  h.handler.handle({ type: 'codex/task/request', requestId: 'approve', kind: 'command',
    details: { command: 'npm test', cwd: '/workspace' }, decisions: ['accept', 'decline'] });
  assert.equal(h.calls.length, 0);
  h.button('Allow once').click();
  assert.equal(h.calls[0].url, '/sessions/session/tasks/requests/approve');
  assert.equal(JSON.stringify(h.calls[0].data), '{"decision":"accept"}');
  h.handler.handle({ type: 'codex/task/requestResolved', requestId: 'approve' });
  assert.equal(h.button('Allow once'), undefined);
  h.handler.close();
  assert.equal(h.body.children.length, 0);
});

test('task panel separates cancellation from voice and ignores stale completion events', async () => {
  const h = await browserHarness();
  h.handler.handle({ type: 'codex/task/status', turnId: 'new', status: 'working' });
  h.handler.handle({ type: 'codex/task/status', turnId: 'old', status: 'completed' });
  assert.equal(h.button('Cancel task').hidden, false);
  h.button('Cancel task').click();
  assert.equal(h.calls[0].url, '/sessions/session/tasks/cancel');
  h.handler.handle({ type: 'codex/task/status', turnId: 'new', status: 'interrupted' });
  assert.equal(h.button('Cancel task').hidden, true);
  assert.match(h.body.all('p')[0].textContent, /Voice is still connected/);
  h.handler.close();
});

test('clarification form requires answers and preserves input after a failed submission', async () => {
  const h = await browserHarness(() => { throw new Error('Connection failed'); });
  h.handler.handle({ type: 'codex/task/request', requestId: 'question', kind: 'input', details: {
    questions: [{ id: 'q', question: 'Which output?', options: [{ label: 'PDF', description: 'Document' }] }],
  } });
  h.button('Send answers').click();
  assert.equal(h.calls.length, 0);
  h.button('PDF').click();
  h.button('Send answers').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(JSON.stringify(h.calls[0].data), '{"answers":{"q":"PDF"}}');
  assert.equal(h.body.all('textarea')[0].value, 'PDF');
  assert.equal(h.button('Send answers').disabled, false);
  assert.ok(h.body.all('p').some(p => p.textContent === 'Connection failed'));
  h.handler.close();
});

test('failed voice leaves task results and the error visible with approvals disabled', async () => {
  const h = await browserHarness();
  h.handler.handle({ type: 'codex/task/output', itemId: 'result', text: 'Research completed.' });
  h.handler.handle({ type: 'codex/task/request', requestId: 'approval', kind: 'command',
    details: { command: 'example' }, decisions: ['accept', 'decline'] });
  h.handler.close('Voice transport reset');
  assert.equal(h.body.children.length, 1);
  assert.equal(h.button('Allow once').disabled, true);
  assert.ok(h.body.all('pre').some(el => el.textContent === 'Research completed.'));
  assert.ok(h.body.all('p').some(el => el.textContent === 'Voice transport reset'));
  h.button('Dismiss').click();
  assert.equal(h.body.children.length, 0);
});

test('streamed task output hides partial citation markers and reconciles final text', async () => {
  const h = await serverHarness();
  for (const delta of ['[COM', 'MENTARY]Found it. ci', 'teturn0search1\n', '\u001b[32mReady\u001b[0m']) {
    h.notify('item/agentMessage/delta', { itemId: 'text', delta });
    assert.doesNotMatch(h.messages.at(-1).text, /||turn0search|\u001b|\[COM/);
  }
  assert.equal(h.messages.at(-1).text, 'Found it. \nReady');
  h.notify('item/completed', { item: { id: 'text', type: 'agentMessage', text: 'Final result. citeturn0search1' } });
  assert.equal(h.messages.at(-1).text, 'Final result. ');
});
