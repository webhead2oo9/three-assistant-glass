const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./browser-modules.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));

async function harness({ popupBlocked = false } = {}) {
  const elements = new Map(), requests = [], timers = new Map(), listeners = new Map();
  let timerId = 0, account = null, login = null;
  const popup = { location: {}, close() { this.closed = true; } };
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      hidden: ['codexSignOut', 'codexCancelLogin', 'codexLoginLink'].includes(id),
      listeners: {},
      addEventListener(name, fn) { this.listeners[name] = fn; },
      click() { this.listeners.click?.(); },
    });
    return elements.get(id);
  };
  await load('settings-codex.js', {
    URL,
    document: { getElementById: element },
    window: { open: () => popupBlocked ? null : popup, addEventListener: (name, fn) => listeners.set(name, fn) },
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; },
    clearTimeout: id => timers.delete(id),
  }, { 'assistant/codex-api.js': { codexRequest: async (path, body) => {
    requests.push({ path, body });
    if (path === '/login') { login = { pending: true }; return { authUrl: 'https://auth.openai.com/login', loginId: 'login-1' }; }
    if (path === '/login/cancel') login = null;
    if (path === '/logout') { account = null; login = null; }
    return { account, login };
  } } });
  await tick();
  return { element, requests, popup, timers, listeners, completeLogin() {
    account = { type: 'chatgpt', email: 'voice@example.test', planType: 'plus' }; login = { pending: false };
  } };
}

test('Settings starts managed ChatGPT login and shows completion through polling', async () => {
  const h = await harness();
  h.element('codexSignIn').click(); await tick();
  assert.equal(JSON.stringify(h.requests.find(r => r.path === '/login').body), '{}');
  assert.equal(h.popup.location.href, 'https://auth.openai.com/login');
  assert.equal(h.popup.opener, null);
  assert.equal(h.element('codexCancelLogin').hidden, false);
  h.completeLogin();
  await [...h.timers.values()][0](); await tick();
  assert.equal(h.element('codexSignOut').hidden, false);
  assert.equal(h.element('codexSignIn').hidden, true);
  assert.match(h.element('codexAccountStatus').textContent, /voice@example.test/);
  h.element('codexSignOut').click(); await tick();
  assert.equal(h.element('codexSignIn').hidden, false);
  assert.equal(h.element('codexSignOut').hidden, true);
});

test('Settings retains a sign-in link if the popup is blocked and can cancel login', async () => {
  const h = await harness({ popupBlocked: true });
  h.element('codexSignIn').click(); await tick();
  assert.equal(h.element('codexLoginLink').hidden, false);
  assert.equal(h.element('codexLoginLink').href, 'https://auth.openai.com/login');
  h.element('codexCancelLogin').click(); await tick();
  assert.equal(h.element('codexLoginLink').hidden, true);
  assert.equal(h.element('codexCancelLogin').hidden, true);
  assert.equal(h.element('codexSignIn').disabled, false);
});

test('switching away from Codex stops login polling', async () => {
  const h = await harness();
  h.element('codexSignIn').click(); await tick();
  assert.equal(h.timers.size, 1);
  const before = h.requests.length;
  h.element('codexAssistantSection').hidden = true;
  h.listeners.get('assistant-provider-changed')(); await tick();
  assert.equal(h.timers.size, 0);
  assert.equal(h.requests.length, before);
});
