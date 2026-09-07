const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');

class Process extends EventEmitter {
  constructor(handle) {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.messages = [];
    this.killed = false;
    this.stdin = new Writable({ write: (chunk, encoding, callback) => {
      const message = JSON.parse(chunk.toString());
      this.messages.push(message);
      queueMicrotask(() => {
        if (message.method === 'initialize') this.reply(message.id, { userAgent: 'test' });
        else handle?.(message, this);
      });
      callback();
    } });
  }
  reply(id, result) { this.stdout.write(JSON.stringify({ id, result }) + '\n'); }
  kill() { this.killed = true; queueMicrotask(() => this.emit('exit', 0)); }
}

async function harness(t, handle, options = {}) {
  const { CodexClient } = await import('../server/codex-client.mjs');
  const home = await mkdtemp(path.join(tmpdir(), 'three-codex-test-'));
  const processes = [], spawns = [];
  const client = new CodexClient({ home, timeoutMs: 2000, spawnProcess: (...args) => {
    spawns.push(args);
    const child = new Process(handle); processes.push(child); return child;
  }, ...options });
  t.after(async () => { client.close(); await rm(home, { recursive: true, force: true }); });
  return { client, processes, spawns, home };
}

test('Codex initializes once for concurrent requests and keeps auth isolated', async t => {
  const h = await harness(t, (m, child) => { if (m.id) child.reply(m.id, { name: m.method }); });
  const results = await Promise.all([h.client.request('account/read'), h.client.request('account/read')]);
  assert.equal(h.processes.length, 1);
  assert.deepEqual(results, [{ name: 'account/read' }, { name: 'account/read' }]);
  const [binary, args, options] = h.spawns[0];
  assert.ok(binary);
  assert.ok(args.includes('stdio://'));
  assert.equal(options.env.CODEX_HOME, h.home);
  assert.equal(options.env.OPENAI_API_KEY, undefined);
  assert.equal(options.env.CODEX_ACCESS_TOKEN, undefined);
  assert.equal(options.cwd, path.join(h.home, 'voice-workspace'));
  assert.deepEqual(h.processes[0].messages.map(m => m.method), ['initialize', 'initialized', 'account/read', 'account/read']);
  assert.equal(h.processes[0].messages[0].params.capabilities.experimentalApi, true);
});

test('Codex correlates fragmented and out-of-order JSON-RPC replies', async t => {
  const requests = [];
  const h = await harness(t, (m, child) => {
    if (!m.id) return;
    requests.push(m);
    if (requests.length === 2) {
      const payload = JSON.stringify({ id: requests[1].id, result: 'second' }) + '\n'
        + JSON.stringify({ id: requests[0].id, result: 'first' }) + '\n';
      child.stdout.write(payload.slice(0, 12)); child.stdout.write(payload.slice(12));
    }
  });
  assert.deepEqual(await Promise.all([h.client.request('first'), h.client.request('second')]), ['first', 'second']);
});

test('Codex timeout kills a process with outstanding work and allows a fresh connection', async t => {
  let reply = false;
  const h = await harness(t, (m, child) => { if (reply && m.id) child.reply(m.id, {}); }, { timeoutMs: 25 });
  await assert.rejects(h.client.request('thread/start'), /timed out/);
  assert.equal(h.processes[0].killed, true);
  reply = true;
  await h.client.request('account/read');
  assert.equal(h.processes.length, 2);
});

test('Codex crashes reject pending requests instead of hanging the browser', async t => {
  const h = await harness(t, (m, child) => { if (m.id) child.emit('exit', 1); });
  await assert.rejects(h.client.request('account/read'), /Codex stopped/);
  assert.equal(h.client.pending.size, 0);
});

test('unexpected server tool requests receive an explicit unsupported response', async t => {
  const h = await harness(t);
  await h.client.start();
  const child = h.processes[0];
  child.stdout.write(JSON.stringify({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: {} }) + '\n');
  assert.deepEqual(child.messages.at(-1), {
    id: 'approval-1', error: { code: -32601, message: 'This voice client does not support tools or approvals.' },
  });
});

test('missing Codex binary reports a useful error and shutdown prevents restart', async t => {
  const h = await harness(t, null, { spawnProcess: () => {
    const child = new Process();
    queueMicrotask(() => child.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' })));
    return child;
  } });
  await assert.rejects(h.client.start(), /Codex CLI was not found/);
  h.client.close();
  await assert.rejects(h.client.request('account/read'), /closed/);
});
