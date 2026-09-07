import express from 'express';
import { randomUUID } from 'node:crypto';

export const DEFAULT_CODEX_INSTRUCTIONS = 'You are a friendly voice assistant represented by a 3D character. ' +
  'Speak naturally and keep replies concise. This is a conversation, with no computer tasks or tool access. ' +
  'Do not use markdown, lists or emoji. Wait for the user to speak.';

const REALTIME_EVENTS = new Set([
  'thread/realtime/started', 'thread/realtime/sdp',
  'thread/realtime/transcript/delta', 'thread/realtime/transcript/done',
  'thread/realtime/error', 'thread/realtime/closed',
]);

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

// Local-only, same-origin control surface, even if the existing app is served
// on a LAN interface. No generic Codex RPC endpoint is exposed to the browser.
export function localCodexRequest(req, res, next) {
  const remote = req.socket.remoteAddress || '';
  const host = req.headers.host;
  try {
    const url = new URL(`http://${host}`);
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)
      || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || req.headers['sec-fetch-site'] === 'cross-site'
      || (req.headers.origin && req.headers.origin !== `${req.protocol}://${host}`)
      || (req.method !== 'GET' && req.headers['x-assistant-request'] !== '1')) {
      return res.status(403).json({ error: 'Open this feature from the local app on localhost.' });
    }
  } catch {
    return res.status(403).json({ error: 'Invalid local request.' });
  }
  res.setHeader('Cache-Control', 'no-store');
  next();
}

export function createCodexRouter(client, { getSettings = () => ({}), attachTimeoutMs = 15000 } = {}) {
  const router = express.Router();
  router.use(localCodexRequest, express.json({ limit: '256kb' }));
  const sessions = new Map();
  let login = null;
  let accountBusy = false;

  function emit(session, type, data = {}) {
    if (!session.events || session.events.destroyed) return;
    if (session.events.writableLength > 256 * 1024) {
      void stop(session);
      return;
    }
    session.events.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  }

  function release(session) {
    if (session.cleanup) return session.cleanup;
    session.cleanup = (async () => {
      await session.starting?.catch(() => {});
      if (session.threadId && client.child) {
        await client.request('thread/realtime/stop', { threadId: session.threadId }).catch(() => {});
        if (client.child) await client.request('thread/unsubscribe', { threadId: session.threadId }).catch(() => {});
      }
    })();
    return session.cleanup;
  }

  function stop(session) {
    if (!session.closed) {
      session.closed = true;
      clearTimeout(session.expiry);
      clearInterval(session.heartbeat);
      session.events?.end();
      sessions.delete(session.id);
    }
    return release(session);
  }

  client.on('notification', message => {
    const params = message.params || {};
    if (message.method === 'account/login/completed' && login?.id === params.loginId) {
      login = { id: login.id, pending: false, error: params.success ? null : (params.error || 'Sign-in did not complete.') };
    }
    const terminalError = message.method === 'error' && params.willRetry === false;
    if (!REALTIME_EVENTS.has(message.method) && !terminalError) return;
    const session = [...sessions.values()].find(s => s.threadId === params.threadId);
    if (!session || session.closed) return;
    if (terminalError) {
      emit(session, 'error', { message: params.error?.message || 'The Codex voice task failed. Try starting again.' });
      void stop(session);
      return;
    }
    emit(session, message.method, params);
    if (message.method === 'thread/realtime/error' || message.method === 'thread/realtime/closed') void stop(session);
  });
  client.on('disconnect', () => {
    if (login?.pending) login = { ...login, pending: false, error: 'Codex disconnected. Start sign-in again.' };
    for (const session of sessions.values()) {
      emit(session, 'error', { message: 'Codex disconnected. Try starting the assistant again.' });
      void stop(session);
    }
  });

  const route = handler => async (req, res, next) => {
    try { await handler(req, res); } catch (error) { next(error); }
  };
  const sessionFor = req => {
    const session = sessions.get(req.params.id);
    if (!session || session.closed) throw fail('Voice session has ended.', 404);
    return session;
  };
  async function account() {
    const result = await client.request('account/read', { refreshToken: false });
    const value = result.account;
    // Deliberately return only display information, never token-bearing data.
    return value ? { type: value.type, email: value.email || null, planType: value.planType || null } : null;
  }
  async function changeAccount(fn) {
    if (accountBusy) throw fail('Another sign-in operation is running.', 409);
    accountBusy = true;
    try { return await fn(); } finally { accountBusy = false; }
  }

  router.get('/account', route(async (req, res) => {
    res.json({ account: await account(), login });
  }));
  router.post('/login', route(async (req, res) => {
    const result = await changeAccount(async () => {
      if (sessions.size) throw fail('Stop the voice session before signing in again.', 409);
      if (login?.pending) await client.request('account/login/cancel', { loginId: login.id });
      const started = await client.request('account/login/start', { type: 'chatgpt' });
      login = { id: started.loginId, pending: true, error: null };
      return { authUrl: started.authUrl, loginId: started.loginId };
    });
    res.json(result);
  }));
  router.post('/login/cancel', route(async (req, res) => {
    await changeAccount(async () => {
      if (login?.pending) await client.request('account/login/cancel', { loginId: login.id });
      login = null;
    });
    res.json({});
  }));
  router.post('/logout', route(async (req, res) => {
    await changeAccount(async () => {
      for (const session of sessions.values()) {
        emit(session, 'thread/realtime/closed', { reason: 'Signed out.' });
        await stop(session);
      }
      if (login?.pending) await client.request('account/login/cancel', { loginId: login.id });
      await client.request('account/logout');
      login = null;
    });
    res.json({});
  }));

  router.post('/sessions', route(async (req, res) => {
    if (accountBusy) throw fail('Wait for sign-in to finish.', 409);
    const currentAccount = await account();
    if (accountBusy || currentAccount?.type !== 'chatgpt') throw fail('Sign in with ChatGPT in Settings → Assistant first.', 401);
    if (res.destroyed) return;
    if (sessions.size) throw fail('A voice session is already open. Stop it before starting another.', 409);
    const session = { id: randomUUID(), threadId: null, events: null, closed: false };
    session.expiry = setTimeout(() => void stop(session), attachTimeoutMs);
    session.expiry.unref?.();
    sessions.set(session.id, session);
    res.json({ sessionId: session.id });
  }));
  router.get('/sessions/:id/events', route(async (req, res) => {
    const session = sessionFor(req);
    if (session.events) throw fail('Voice event stream is already connected.', 409);
    clearTimeout(session.expiry);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    session.events = res;
    session.heartbeat = setInterval(() => { if (!res.destroyed) res.write(': heartbeat\n\n'); }, 15000);
    session.heartbeat.unref?.();
    res.on('close', () => void stop(session));
    emit(session, 'ready');
  }));
  router.post('/sessions/:id/start', route(async (req, res) => {
    const session = sessionFor(req);
    if (!session.events) throw fail('Connect the voice event stream before starting.');
    if (session.starting) throw fail('Voice session already started.', 409);
    const sdp = req.body?.sdp;
    if (typeof sdp !== 'string' || !sdp.startsWith('v=0') || sdp.length > 128 * 1024) throw fail('A browser-generated SDP offer is required.');
    const settings = getSettings();
    const configured = settings.codexInstructions;
    const model = settings.codexModel || '';
    const voice = settings.codexVoice || '';
    if (typeof model !== 'string' || (model && !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/.test(model))) throw fail('Invalid realtime model name.');
    if (voice && !['cove', 'juniper', 'maple', 'spruce', 'ember', 'vale', 'breeze', 'arbor', 'sol'].includes(voice)) throw fail('Unsupported realtime voice.');
    const instructions = (typeof configured === 'string' && configured.trim()) || DEFAULT_CODEX_INSTRUCTIONS;
    if (instructions.length > 8000) throw fail('Character instructions must be under 8,000 characters.');
    session.starting = (async () => {
      const result = await client.request('thread/start', {
        cwd: client.cwd, modelProvider: 'openai', ephemeral: true,
        sandbox: 'read-only', approvalPolicy: 'untrusted',
        environments: [], selectedCapabilityRoots: [], dynamicTools: [],
        baseInstructions: instructions,
        // Codex 0.153.4 requires this opt-in; newer releases accept it as a no-op.
        config: { 'features.realtime_conversation': true,
          'web_search': 'disabled', 'features.shell_tool': false, 'features.apps': false,
          'features.multi_agent': false, 'features.multi_agent_v2': false },
      });
      session.threadId = result.thread.id;
      if (session.closed) return;
      await client.request('thread/realtime/start', {
        threadId: session.threadId, outputModality: 'audio', version: 'v3',
        includeStartupContext: false, prompt: instructions,
        ...(model ? { model } : {}), ...(voice ? { voice } : {}),
        transport: { type: 'webrtc', sdp },
      });
    })();
    try {
      await session.starting;
      if (!res.destroyed) res.json({ threadId: session.threadId });
    } catch (error) {
      emit(session, 'error', { message: error.message });
      void stop(session);
      throw error;
    }
  }));
  router.post('/sessions/:id/context', route(async (req, res) => {
    const session = sessionFor(req);
    const text = req.body?.text;
    if (!session.threadId || typeof text !== 'string' || !text.trim() || text.length > 8000) throw fail('Invalid voice context.');
    await client.request('thread/realtime/appendText', { threadId: session.threadId, role: 'developer', text });
    res.json({});
  }));
  router.post('/sessions/:id/stop', route(async (req, res) => {
    const session = sessions.get(req.params.id);
    if (session) await stop(session);
    res.json({});
  }));
  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(error.status || 502).json({ error: error.message || 'Codex request failed.' });
  });
  return router;
}
