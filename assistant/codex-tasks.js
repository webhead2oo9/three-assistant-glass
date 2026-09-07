import { codexRequest } from './codex-api.js';

let retainedPanel = null;

// Only the Codex voice adapter creates this panel or sends events to it.
export function createCodexTaskHandler(sessionId) {
  retainedPanel?.remove();
  retainedPanel = null;
  const panel = document.createElement('details');
  panel.className = 'codex-task-panel';
  panel.open = true;
  const add = (parent, tag, text) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    parent.append(element);
    return element;
  };
  add(panel, 'summary', 'ChatGPT tasks');
  const status = add(panel, 'p', 'Ask the character to work on a task.');
  status.setAttribute('role', 'status');
  const cancel = add(panel, 'button', 'Cancel task');
  cancel.type = 'button';
  cancel.hidden = true;
  const error = add(panel, 'p');
  error.setAttribute('role', 'alert');
  const voiceStatus = add(panel, 'p');
  voiceStatus.setAttribute('role', 'status');
  const requests = add(panel, 'div');
  const output = add(panel, 'div');
  output.className = 'codex-task-output';
  document.body.append(panel);
  const items = new Map(), pending = new Map();
  let closed = false, activeTurn = null;

  async function send(path, body, controls) {
    error.textContent = '';
    controls.forEach(el => { el.disabled = true; });
    try {
      await codexRequest(`/sessions/${sessionId}/tasks/${path}`, body);
    } catch (err) {
      if (!closed) error.textContent = err.message;
    } finally {
      if (!closed) controls.forEach(el => { el.disabled = false; });
    }
  }
  cancel.addEventListener('click', () => void send('cancel', {}, [cancel]));

  function request(message) {
    if (pending.has(message.requestId)) return;
    panel.open = true;
    const card = add(requests, 'section');
    card.className = 'codex-task-request';
    pending.set(message.requestId, card);
    const details = message.details, controls = [];
    add(card, 'h3', message.kind === 'input' ? 'Your input is needed' : 'Approval requested');
    if (details.reason) add(card, 'p', details.reason);
    const button = (label, run) => {
      const el = add(card, 'button', label);
      el.type = 'button';
      controls.push(el);
      el.addEventListener('click', run);
      return el;
    };
    const reply = body => void send(`requests/${message.requestId}`, body, controls);
    if (message.kind === 'input') {
      const fields = new Map();
      for (const q of details.questions) {
        const label = add(card, 'label');
        add(label, 'span', q.question);
        const field = add(label, q.isSecret ? 'input' : 'textarea');
        if (q.isSecret) { field.type = 'password'; field.autocomplete = 'off'; }
        field.maxLength = 8000;
        controls.push(field);
        fields.set(q.id, field);
        for (const option of q.options || []) {
          const el = button(option.label, () => { field.value = option.label; });
          el.title = option.description || '';
        }
      }
      button('Send answers', () => {
        if ([...fields.values()].some(field => !field.value.trim())) {
          error.textContent = 'Answer each question before sending.';
          return;
        }
        reply({ answers: Object.fromEntries([...fields].map(([id, field]) => [id, field.value])) });
      });
    } else {
      if (message.kind === 'command') {
        add(card, 'p', details.kind === 'writeStdin' ? 'Send input to a running command' : 'Run command');
        if (details.cwd) add(card, 'p', `Folder: ${details.cwd}`);
        if (details.command) add(card, 'pre', details.command);
        if (details.networkApprovalContext) add(card, 'pre', JSON.stringify(details.networkApprovalContext, null, 2));
        if (details.additionalPermissions) add(card, 'pre', JSON.stringify(details.additionalPermissions, null, 2));
      } else if (message.kind === 'files') {
        if (details.grantRoot) add(card, 'p', `Requested write access: ${details.grantRoot}`);
        if (!details.changes) add(card, 'p', 'The proposed changes were not available for review. Decline or cancel this request.');
        for (const change of details.changes || []) {
          add(card, 'p', `${change.kind?.type || 'Change'}: ${change.path}`);
          if (change.kind?.movePath) add(card, 'p', `Move to: ${change.kind.movePath}`);
          add(card, 'pre', change.diff);
        }
      } else {
        add(card, 'p', 'Additional access for this task only');
        add(card, 'pre', JSON.stringify(details.permissions, null, 2));
      }
      const decisions = message.kind === 'permissions' ? ['accept', 'decline'] : message.decisions;
      for (const decision of decisions) {
        button({ accept: 'Allow once', decline: 'Decline', cancel: 'Cancel task' }[decision], () => reply({ decision }));
      }
    }
  }

  return {
    handle(message) {
      if (!message.type.startsWith('codex/task/')) return false;
      if (closed) return true;
      switch (message.type) {
        case 'codex/task/voiceStatus': voiceStatus.textContent = message.message; break;
        case 'codex/task/handoff':
          status.textContent = activeTurn ? 'Updating the task…' : 'Starting task…';
          break;
        case 'codex/task/status': {
          if (message.status !== 'working' && activeTurn && activeTurn !== message.turnId) break;
          activeTurn = message.status === 'working' ? message.turnId : null;
          cancel.hidden = !activeTurn;
          status.textContent = ({ working: 'Working… You can keep talking.', completed: 'Task completed.',
            interrupted: 'Task cancelled. Voice is still connected.', failed: 'Task failed.' })[message.status] || message.status;
          if (message.error) error.textContent = message.error;
          break;
        }
        case 'codex/task/error': error.textContent = message.message; break;
        case 'codex/task/output': {
          let item = items.get(message.itemId);
          if (!item) {
            item = add(output, 'pre');
            items.set(message.itemId, item);
            if (items.size > 12) {
              const [id, oldest] = items.entries().next().value;
              oldest.remove(); items.delete(id);
            }
          }
          item.textContent = (message.text ?? (item.textContent + (message.delta || ''))).slice(-12000);
          break;
        }
        case 'codex/task/request': request(message); break;
        case 'codex/task/requestResolved':
          pending.get(message.requestId)?.remove();
          pending.delete(message.requestId);
          break;
      }
      return true;
    },
    close(reason) {
      closed = true;
      if (reason) {
        panel.open = true;
        status.textContent = 'Voice session ended. Task output is kept below.';
        error.textContent = reason;
        cancel.hidden = true;
        panel.querySelectorAll('button, input, textarea').forEach(el => { el.disabled = true; });
        const dismiss = add(panel, 'button', 'Dismiss');
        dismiss.addEventListener('click', () => { panel.remove(); retainedPanel = null; });
        retainedPanel = panel;
      } else panel.remove();
      items.clear(); pending.clear();
    },
  };
}
