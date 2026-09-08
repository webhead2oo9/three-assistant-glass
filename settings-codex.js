import { codexRequest } from './assistant/codex-api.js';

const section = document.getElementById('codexAssistantSection');
const status = document.getElementById('codexAccountStatus');
const signIn = document.getElementById('codexSignIn');
const signOut = document.getElementById('codexSignOut');
const cancel = document.getElementById('codexCancelLogin');
const refresh = document.getElementById('codexRefresh');
const loginLink = document.getElementById('codexLoginLink');
let timer = null;
let busy = false;
let revision = 0;

async function readAccount() {
  if (section.hidden || busy) return;
  const current = ++revision;
  clearTimeout(timer);
  try {
    const result = await codexRequest('/account');
    if (current !== revision || section.hidden) return;
    const signedIn = result.account?.type === 'chatgpt';
    const pending = result.login?.pending === true;
    signIn.hidden = signedIn || pending;
    signOut.hidden = !signedIn;
    cancel.hidden = !pending;
    if (!pending) loginLink.hidden = true;
    status.textContent = signedIn
      ? `Signed in${result.account.email ? ` as ${result.account.email}` : ''}${result.account.planType ? ` · ${result.account.planType}` : ''}. Return to the character and press Start.`
      : pending ? 'Complete sign-in in your browser…'
        : result.login?.error || 'Sign in with ChatGPT to try realtime voice.';
    if (pending) timer = setTimeout(readAccount, 1500);
  } catch (error) {
    if (current === revision) status.textContent = error.message;
  }
}

async function action(run) {
  if (busy) return;
  busy = true;
  revision++;
  clearTimeout(timer);
  for (const button of [signIn, signOut, cancel, refresh]) button.disabled = true;
  try {
    await run();
    busy = false;
    await readAccount();
  } catch (error) {
    status.textContent = error.message;
  } finally {
    busy = false;
    for (const button of [signIn, signOut, cancel, refresh]) button.disabled = false;
  }
}

signIn.addEventListener('click', () => {
  if (busy) return;
  // Open during the click gesture so popup blockers do not block an async URL.
  const popup = window.open('about:blank', 'threeAssistantChatGPTLogin', 'width=620,height=780');
  if (popup) popup.opener = null;
  status.textContent = 'Opening ChatGPT sign-in…';
  void action(async () => {
    try {
      const result = await codexRequest('/login', {});
      const url = new URL(result.authUrl);
      if (url.protocol !== 'https:') throw new Error('Codex returned an invalid sign-in URL.');
      loginLink.href = url.href;
      loginLink.hidden = false;
      if (popup && !popup.closed) popup.location.href = url.href;
    } catch (error) {
      popup?.close();
      throw error;
    }
  });
});
cancel.addEventListener('click', () => void action(() => codexRequest('/login/cancel', {})));
signOut.addEventListener('click', () => void action(() => codexRequest('/logout', {})));
refresh.addEventListener('click', () => void readAccount());
window.addEventListener('assistant-provider-changed', () => {
  revision++;
  clearTimeout(timer);
  void readAccount();
});
window.addEventListener('pagehide', () => { revision++; clearTimeout(timer); });
void readAccount();
