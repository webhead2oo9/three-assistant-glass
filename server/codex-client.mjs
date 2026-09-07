import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

// Codex owns OAuth and refresh tokens. Its home is outside Express's static root
// and separate from the user's normal Codex login/configuration.
export class CodexClient extends EventEmitter {
  constructor({
    binary = process.env.THREE_ASSISTANT_CODEX_BIN || 'codex',
    home = process.env.THREE_ASSISTANT_CODEX_HOME || path.join(homedir(), '.three-assistant-glass', 'codex'),
    spawnProcess = spawn,
    timeoutMs = 45000,
  } = {}) {
    super();
    this.binary = binary;
    this.home = path.resolve(home);
    this.cwd = path.join(this.home, 'voice-workspace');
    this.spawnProcess = spawnProcess;
    this.timeoutMs = timeoutMs;
    this.child = null;
    this.starting = null;
    this.pending = new Map();
    this.incoming = new Map();
    this.nextId = 0;
    this.closed = false;
  }

  async start() {
    if (this.closed) throw new Error('Codex connection is closed.');
    if (this.starting) return this.starting;
    const starting = this.launch().catch(error => {
      if (this.starting === starting) this.disconnect(error);
      throw error;
    });
    this.starting = starting;
    return starting;
  }

  async launch() {
    await mkdir(this.cwd, { recursive: true, mode: 0o700 });
    if (this.closed) throw new Error('Codex connection is closed.');
    const env = { ...process.env, CODEX_HOME: this.home };
    // This provider explicitly uses its own ChatGPT login, never inherited keys.
    for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_BASE_URL']) delete env[key];
    const child = this.spawnProcess(this.binary, [
      '-c', 'model_provider="openai"',
      '-c', 'cli_auth_credentials_store="file"',
      'app-server', '--listen', 'stdio://',
    ], { cwd: this.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (this.child !== child) return;
      buffer += chunk;
      if (buffer.length > 4 * 1024 * 1024) {
        this.disconnect(new Error('Codex sent an oversized protocol message.'));
        return;
      }
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); }
        catch { this.disconnect(new Error('Codex sent invalid JSON.')); return; }
        this.receive(message);
      }
    });
    // Drain diagnostics, but never send auth URLs, tokens or transcripts to logs.
    child.stderr.resume();
    child.stdin.on('error', () => {
      if (this.child === child) this.disconnect(new Error('Codex connection was lost.'));
    });
    child.on('error', error => {
      if (this.child !== child) return;
      this.disconnect(new Error(error.code === 'ENOENT'
        ? 'Codex CLI was not found. Install Codex or set THREE_ASSISTANT_CODEX_BIN, then restart the server.'
        : 'Could not start Codex. Check the local Codex installation.'));
    });
    child.on('exit', () => {
      if (this.child === child) this.disconnect(new Error('Codex stopped. Try connecting again.'));
    });
    const result = await this.send('initialize', {
      clientInfo: { name: 'three_assistant_glass', title: 'Three Assistant Glass', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    this.write({ method: 'initialized', params: {} });
    return result;
  }

  receive(message) {
    if (message.method) {
      if (message.id !== undefined) {
        const child = this.child;
        const respond = (result, error) => {
          if (this.child !== child || this.incoming.get(message.id) !== respond) return;
          this.incoming.delete(message.id);
          this.write({ id: message.id, ...(error ? { error } : { result }) });
        };
        this.incoming.set(message.id, respond);
        if (!this.emit('request', message, respond)) {
          respond(null, { code: -32601, message: 'Unsupported Codex request.' });
        }
      } else {
        this.emit('notification', message);
      }
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message || 'Codex request failed.'));
    else pending.resolve(message.result);
  }

  write(message) {
    if (!this.child || this.child.stdin.destroyed) throw new Error('Codex is not connected.');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  send(method, params) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // A timed-out mutation may still be running. End this process so it
        // cannot leave an unowned voice session behind.
        this.disconnect(new Error(`Codex timed out during ${method}. Try again.`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async request(method, params = {}) {
    await this.start();
    return this.send(method, params);
  }

  disconnect(error) {
    const child = this.child;
    this.child = null;
    this.starting = null;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.incoming.clear();
    child?.kill();
    this.emit('disconnect', error);
  }

  close() {
    this.closed = true;
    this.disconnect(new Error('Codex connection closed.'));
  }
}
