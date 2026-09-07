const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const express = require('express');
const http = require('node:http');

async function until(predicate) {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(predicate(), 'expected asynchronous operation to complete');
}

class Client extends EventEmitter {
  child = {};
  cwd = require('node:fs').realpathSync(require('node:os').tmpdir());
  calls = [];
  signedIn = true;
  handle = null;
  async request(method, params = {}) {
    this.calls.push({ method, params });
    if (this.handle) {
      const result = this.handle(method, params);
      if (result !== undefined) return result;
    }
    if (method === 'account/read') return { account: this.signedIn
      ? { type: 'chatgpt', email: 'voice@example.test', planType: 'plus', accessToken: 'never-return-this' } : null };
    if (method === 'account/login/start') return { loginId: 'login-1', authUrl: 'https://auth.openai.com/test-login' };
    if (method === 'account/logout') this.signedIn = false;
    if (method === 'thread/start') return { thread: { id: 'thread-1' } };
    if (method === 'thread/realtime/start') {
      this.emit('notification', { method: 'thread/realtime/sdp', params: { threadId: params.threadId, sdp: 'v=0\r\nanswer' } });
    }
    if (method === 'thread/realtime/stop') {
      this.emit('notification', { method: 'thread/realtime/closed', params: { threadId: params.threadId, reason: 'Stopped' } });
    }
    return {};
  }
}

async function harness(t, options = {}) {
  const { createCodexRouter } = await import('../server/codex-routes.mjs');
  const client = new Client();
  const app = express();
  app.use('/api/codex', createCodexRouter(client, options));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/codex`;
  const streams = [];
  t.after(async () => {
    for (const stream of streams) stream.abort();
    client.child = null;
    client.emit('disconnect', new Error('test shutdown'));
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const request = (url, body, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request(base + url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Assistant-Request': '1', ...headers },
    }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        try { resolve({ status: response.statusCode, body: JSON.parse(text) }); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const events = async id => {
    const controller = new AbortController(); streams.push(controller);
    const response = await fetch(`${base}/sessions/${id}/events`, { signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = '';
    return {
      close: () => controller.abort(),
      async next() {
        for (;;) {
          const end = buffer.indexOf('\n\n');
          if (end >= 0) {
            const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            if (frame.startsWith('data: ')) return JSON.parse(frame.slice(6));
          } else {
            const chunk = await reader.read();
            if (chunk.done) throw new Error('event stream ended');
            buffer += decoder.decode(chunk.value, { stream: true });
          }
        }
      },
    };
  };
  return { client, request, events };
}

async function allocate(h) {
  const result = await h.request('/sessions', {});
  assert.equal(result.status, 200);
  const id = result.body.sessionId;
  const events = await h.events(id);
  assert.deepEqual(await events.next(), { type: 'ready' });
  return { id, events };
}

test('Codex routes return account display data without credentials and require ChatGPT login', async t => {
  const h = await harness(t);
  assert.deepEqual((await h.request('/account')).body, {
    account: { type: 'chatgpt', email: 'voice@example.test', planType: 'plus' }, login: null,
  });
  h.client.signedIn = false;
  assert.equal((await h.request('/sessions', {})).status, 401);
});

test('Codex routes reject cross-origin, rebinding and unmarked mutation requests', async t => {
  const h = await harness(t);
  assert.equal((await h.request('/account', undefined, { Origin: 'https://other.example' })).status, 403);
  assert.equal((await h.request('/account', undefined, { Host: 'other.example' })).status, 403);
  assert.equal((await h.request('/account', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await h.request('/login', {}, { 'X-Assistant-Request': '' })).status, 403);
  assert.equal(h.client.calls.length, 0);
});

test('managed login reports completion errors and supports cancellation', async t => {
  const h = await harness(t); h.client.signedIn = false;
  assert.deepEqual((await h.request('/login', {})).body, { loginId: 'login-1', authUrl: 'https://auth.openai.com/test-login' });
  assert.equal((await h.request('/account')).body.login.pending, true);
  h.client.emit('notification', { method: 'account/login/completed', params: { loginId: 'login-1', success: false, error: 'Cancelled in browser' } });
  assert.equal((await h.request('/account')).body.login.error, 'Cancelled in browser');
  await h.request('/login', {}); await h.request('/login/cancel', {});
  assert.equal((await h.request('/account')).body.login, null);
  assert.ok(h.client.calls.some(c => c.method === 'account/login/cancel' && c.params.loginId === 'login-1'));
});

test('voice creates a task-capable thread and negotiates native WebRTC handoff', async t => {
  const h = await harness(t, { getSettings: () => ({ codexInstructions: 'Speak as a friendly character.', codexModel: 'gpt-live-1-codex', codexVoice: 'juniper' }) });
  const { id, events } = await allocate(h);
  const result = await h.request(`/sessions/${id}/start`, { sdp: 'v=0\r\noffer' });
  assert.equal(result.status, 200);
  assert.deepEqual(await events.next(), { type: 'thread/realtime/sdp', threadId: 'thread-1', sdp: 'v=0\r\nanswer' });
  const thread = h.client.calls.find(c => c.method === 'thread/start').params;
  assert.equal(thread.cwd, h.client.cwd);
  assert.equal(thread.ephemeral, true);
  assert.equal(thread.config['features.realtime_conversation'], true);
  assert.equal(thread.sandbox, 'workspace-write');
  assert.equal(thread.environments, undefined);
  assert.equal(thread.approvalsReviewer, 'user');
  assert.equal(thread.baseInstructions, undefined);
  const start = h.client.calls.find(c => c.method === 'thread/realtime/start').params;
  assert.deepEqual(start.transport, { type: 'webrtc', sdp: 'v=0\r\noffer' });
  assert.equal(start.version, 'v3');
  assert.equal(start.includeStartupContext, false);
  assert.equal(start.clientManagedHandoffs, true);
  assert.match(start.prompt, /Speak as a friendly character/);
  assert.match(start.prompt, /Delegate actions/);
  assert.equal(start.model, 'gpt-live-1-codex');
  assert.equal(start.voice, 'juniper');
  h.client.emit('notification', { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', itemId: 'item-1', delta: 'Working on it' } });
  assert.deepEqual(await events.next(), { type: 'codex/task/output', itemId: 'item-1', text: 'Working on it' });
  h.client.emit('notification', { method: 'thread/realtime/transcript/delta', params: { threadId: 'another-thread', role: 'user', delta: 'unrelated' } });
  h.client.emit('notification', { method: 'thread/realtime/transcript/delta', params: { threadId: 'thread-1', role: 'assistant', delta: 'Hello' } });
  assert.deepEqual(await events.next(), { type: 'thread/realtime/transcript/delta', threadId: 'thread-1', role: 'assistant', delta: 'Hello' });
  await h.request(`/sessions/${id}/context`, { text: 'Clipboard context' });
  assert.deepEqual(h.client.calls.at(-1), { method: 'thread/realtime/appendText', params: { threadId: 'thread-1', role: 'developer', text: 'Clipboard context' } });
});

test('backing-agent failures reach the task panel without disconnecting voice', async t => {
  const h = await harness(t);
  const { id, events } = await allocate(h);
  await h.request(`/sessions/${id}/start`, { sdp: 'v=0\r\noffer' });
  await events.next(); // SDP answer
  h.client.emit('notification', { method: 'error', params: {
    threadId: 'another-thread', willRetry: false, error: { message: 'Unrelated failure' },
  } });
  h.client.emit('notification', { method: 'error', params: {
    threadId: 'thread-1', willRetry: true, error: { message: 'Retrying' },
  } });
  assert.equal(h.client.calls.some(c => c.method === 'thread/realtime/stop'), false);
  h.client.emit('notification', { method: 'error', params: {
    threadId: 'thread-1', willRetry: false, error: { message: 'Voice handoff failed' },
  } });
  assert.deepEqual(await events.next(), { type: 'codex/task/error', message: 'Voice handoff failed' });
  assert.equal(h.client.calls.some(c => c.method === 'thread/unsubscribe'), false);
  assert.equal((await h.request(`/sessions/${id}/context`, { text: 'After failure' })).status, 200);
});

test('one browser owns voice, and closing its stream releases the Codex thread', async t => {
  const h = await harness(t);
  const { id, events } = await allocate(h);
  assert.equal((await h.request('/sessions', {})).status, 409);
  await h.request(`/sessions/${id}/start`, { sdp: 'v=0\r\noffer' });
  events.close();
  await until(() => h.client.calls.some(c => c.method === 'thread/unsubscribe'));
  assert.ok(h.client.calls.some(c => c.method === 'thread/realtime/stop'));
  assert.equal((await h.request(`/sessions/${id}/stop`, {})).status, 200);
  assert.equal((await h.request('/sessions', {})).status, 200);
});

test('Stop while thread creation is pending releases the late thread without starting voice', async t => {
  const h = await harness(t);
  let resolve;
  const thread = new Promise(r => { resolve = r; });
  h.client.handle = method => method === 'thread/start' ? thread : undefined;
  const { id, events } = await allocate(h);
  const starting = h.request(`/sessions/${id}/start`, { sdp: 'v=0\r\noffer' });
  await until(() => h.client.calls.some(c => c.method === 'thread/start'));
  const streamEnded = assert.rejects(events.next(), /event stream ended/);
  const stopping = h.request(`/sessions/${id}/stop`, {});
  await streamEnded;
  resolve({ thread: { id: 'late-thread' } });
  await Promise.all([starting, stopping]);
  assert.equal(h.client.calls.some(c => c.method === 'thread/realtime/start'), false);
  assert.ok(h.client.calls.some(c => c.method === 'thread/unsubscribe' && c.params.threadId === 'late-thread'));
});

test('unused session allocations expire and invalid SDP never reaches Codex', async t => {
  const h = await harness(t, { attachTimeoutMs: 20 });
  const allocation = await h.request('/sessions', {});
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal((await h.request(`/sessions/${allocation.body.sessionId}/start`, { sdp: 'v=0' })).status, 404);
  const { id } = await allocate(h);
  assert.equal((await h.request(`/sessions/${id}/start`, { sdp: 'not-sdp' })).status, 400);
  assert.equal(h.client.calls.some(c => c.method === 'thread/start'), false);
});

test('logout stops voice and signs out only through Codex account RPCs', async t => {
  const h = await harness(t);
  const { id, events } = await allocate(h);
  await h.request(`/sessions/${id}/start`, { sdp: 'v=0\r\noffer' });
  await events.next();
  assert.equal((await h.request('/logout', {})).status, 200);
  assert.equal((await events.next()).type, 'thread/realtime/closed');
  const methods = h.client.calls.map(c => c.method);
  assert.ok(methods.indexOf('thread/realtime/stop') < methods.indexOf('account/logout'));
  assert.equal((await h.request('/account')).body.account, null);
});

test('task approvals are scoped, validated, and answered exactly once', async t => {
  const h = await harness(t);
  const { id, events } = await allocate(h);
  await h.request(`/sessions/${id}/start`, { sdp: 'v=0\r\noffer' });
  await events.next();
  h.client.emit('notification', { method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } });
  assert.equal((await events.next()).status, 'working');
  const replies = [];
  h.client.emit('request', { id: 101, method: 'item/commandExecution/requestApproval', params: {
    threadId: 'thread-1', turnId: 'turn-1', itemId: 'cmd', command: 'npm test', cwd: h.client.cwd,
    availableDecisions: ['accept', 'decline'],
  } }, result => replies.push(result));
  const approval = await events.next();
  assert.equal(approval.kind, 'command');
  assert.equal(approval.details.command, 'npm test');
  assert.equal(replies.length, 0);
  const url = `/sessions/${id}/tasks/requests/${approval.requestId}`;
  assert.equal((await h.request(url, { decision: 'acceptForSession' })).status, 400);
  assert.equal((await h.request(url, { decision: 'accept' }, { Origin: 'https://other.example' })).status, 403);
  assert.equal((await h.request(`/sessions/wrong/tasks/requests/${approval.requestId}`, { decision: 'accept' })).status, 404);
  assert.equal((await h.request(url, { decision: 'accept' })).status, 200);
  assert.equal((await events.next()).type, 'codex/task/requestResolved');
  assert.equal((await h.request(url, { decision: 'accept' })).status, 409);
  assert.deepEqual(replies, [{ decision: 'accept' }]);
});

test('task cancellation interrupts the turn, dismisses questions, and leaves voice connected', async t => {
  const h = await harness(t), { id, events } = await allocate(h);
  await h.request(`/sessions/${id}/start`, { sdp: 'v=0\r\noffer' }); await events.next();
  h.client.emit('notification', { method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } });
  await events.next();
  const replies = [];
  h.client.emit('request', { id: 'question', method: 'item/tool/requestUserInput', params: {
    threadId: 'thread-1', turnId: 'turn-1', questions: [{ id: 'folder', question: 'Which folder?' }],
  } }, result => replies.push(result));
  await events.next();
  assert.equal((await h.request(`/sessions/${id}/tasks/cancel`, {})).status, 200);
  assert.deepEqual(h.client.calls.at(-1), { method: 'turn/interrupt', params: { threadId: 'thread-1', turnId: 'turn-1' } });
  assert.deepEqual(replies, [{ answers: {} }]);
  assert.equal(h.client.calls.some(c => c.method === 'thread/realtime/stop'), false);
  assert.equal((await h.request(`/sessions/${id}/context`, { text: 'Keep talking' })).status, 200);
  assert.equal((await h.request(`/sessions/${id}/tasks/cancel`, {})).status, 409);
});

test('stopping voice interrupts running work and rejects pending approvals', async t => {
  const h = await harness(t), { id, events } = await allocate(h);
  await h.request(`/sessions/${id}/start`, { sdp: 'v=0\r\noffer' }); await events.next();
  h.client.emit('notification', { method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-stop' } } });
  await events.next();
  const replies = [];
  h.client.emit('request', { id: 'cmd', method: 'item/commandExecution/requestApproval', params: {
    threadId: 'thread-1', turnId: 'turn-stop', command: 'test',
  } }, result => replies.push(result));
  await events.next();
  await h.request(`/sessions/${id}/stop`, {});
  const methods = h.client.calls.map(c => c.method);
  assert.ok(methods.indexOf('thread/realtime/stop') < methods.indexOf('turn/interrupt'));
  assert.ok(methods.indexOf('turn/interrupt') < methods.indexOf('thread/unsubscribe'));
  assert.deepEqual(replies, [{ decision: 'cancel' }]);
});

test('stop drains a late voice delegation before interrupting and unsubscribing', async t => {
  const h = await harness(t), { id, events } = await allocate(h);
  await h.request(`/sessions/${id}/start`, { sdp: 'v=0\r\noffer' }); await events.next();
  h.client.handle = method => {
    if (method !== 'thread/realtime/stop') return;
    // The RPC acknowledges queuing before the realtime fanout finishes.
    setImmediate(() => {
      h.client.emit('notification', { method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'late-turn' } } });
      h.client.emit('notification', { method: 'thread/realtime/closed', params: { threadId: 'thread-1' } });
    });
    return {};
  };
  await h.request(`/sessions/${id}/stop`, {});
  assert.ok(h.client.calls.some(c => c.method === 'turn/interrupt' && c.params.turnId === 'late-turn'));
  assert.equal(h.client.calls.at(-1).method, 'thread/unsubscribe');
});

test('task workspace and task model are validated separately from voice settings', async t => {
  const h = await harness(t, { getSettings: () => ({ codexWorkspace: 'relative/path' }) });
  const { id } = await allocate(h);
  const response = await h.request(`/sessions/${id}/start`, { sdp: 'v=0\r\noffer' });
  assert.equal(response.status, 400);
  assert.match(response.body.error, /absolute folder/);
  assert.equal(h.client.calls.some(c => c.method === 'thread/start'), false);
});

test('voice transport loss and task completion preserve the same thread across reconnect', async t => {
  const h = await harness(t), { id, events } = await allocate(h);
  await h.request(`/sessions/${id}/start`, { sdp: 'v=0\r\noffer' }); await events.next();
  h.client.emit('notification', { method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'search' } } });
  await events.next();
  const replies = [];
  h.client.emit('request', { id: 'approve', method: 'item/commandExecution/requestApproval', params: {
    threadId: 'thread-1', turnId: 'search', command: 'test',
  } }, result => replies.push(result));
  const approval = await events.next();
  h.client.emit('notification', { method: 'thread/realtime/closed', params: { threadId: 'thread-1', reason: 'transport_closed' } });
  assert.equal((await events.next()).reason, 'transport_closed');
  assert.equal((await h.request(`/sessions/${id}/reconnect`, { sdp: 'v=0\r\nnew-offer' })).status, 200);
  assert.equal((await events.next()).type, 'thread/realtime/sdp');
  assert.equal(h.client.calls.filter(c => c.method === 'thread/start').length, 1);
  assert.equal(h.client.calls.filter(c => c.method === 'thread/realtime/start').length, 2);
  assert.equal(h.client.calls.some(c => c.method === 'turn/interrupt' || c.method === 'thread/unsubscribe'), false);
  assert.equal((await h.request(`/sessions/${id}/tasks/requests/${approval.requestId}`, { decision: 'accept' })).status, 200);
  assert.deepEqual(replies, [{ decision: 'accept' }]);
  await events.next();
  h.client.emit('notification', { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'search', status: 'completed' } } });
  assert.equal((await events.next()).status, 'completed');
  assert.equal((await h.request(`/sessions/${id}/context`, { text: 'Next question' })).status, 200);
});

test('reconnect waits for the previous call to close without treating it as a session stop', async t => {
  const h = await harness(t), { id, events } = await allocate(h);
  await h.request(`/sessions/${id}/start`, { sdp: 'v=0\r\noffer' }); await events.next();
  assert.equal((await h.request(`/sessions/${id}/reconnect`, { sdp: 'v=0\r\nnew-offer' })).status, 200);
  assert.equal((await events.next()).type, 'thread/realtime/sdp');
  assert.equal(h.client.calls.some(c => c.method === 'thread/unsubscribe'), false);
});
