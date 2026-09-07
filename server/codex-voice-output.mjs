import { cleanCodexText } from './codex-text.mjs';

function voiceText(text) {
  return Array.from(cleanCodexText(text)
    .replace(/[^]*(?:|$)/g, '').replace(/[\uE000-\uF8FF]/g, '')
    .replace(/```[\s\S]*?```/g, '[Code is shown in the task panel.]')
    .replace(/\[([^\]]+)\]\(https?:\/\/[^\s)]+\)/g, '$1')
    .replace(/<[^>]+>/g, '')).slice(0, 4000).join('').trim();
}

// Native delegation still runs Codex turns. Only the return path is client-managed:
// complete, bounded messages through appendSpeech, never raw deltas or approval JSON.
export function createCodexVoiceOutput(client, emit) {
  const state = s => s.voiceOutput ||= {
    ready: false, sending: false, generation: 0, pending: new Map(), history: [],
    result: '', progressSent: false, lastResult: '',
  };

  async function flush(session) {
    const output = state(session);
    if (output.sending || !output.ready || session.closed) return;
    output.sending = true;
    const generation = output.generation;
    try {
      while (output.ready && !session.closed && output.pending.size && generation === output.generation) {
        const [key, text] = output.pending.entries().next().value;
        await client.request('thread/realtime/appendSpeech', {
          threadId: session.threadId, text,
        });
        if (output.pending.get(key) === text) output.pending.delete(key);
      }
    } catch (error) {
      if (generation === output.generation) {
        output.ready = false;
        if (!session.closed) emit(session, 'codex/task/error', { message: `Task output is available below, but delivery to voice failed: ${error.message}` });
      }
    } finally {
      output.sending = false;
      if (output.ready && output.pending.size && !session.closed) void flush(session);
    }
  }

  function queue(session, key, text) {
    const output = state(session);
    output.pending.set(key, text);
    if (output.pending.size > 8) output.pending.delete(output.pending.keys().next().value);
    void flush(session);
  }

  return {
    ready(session) { state(session).ready = true; void flush(session); },
    disconnected(session) { const output = state(session); output.ready = false; output.generation++; },
    stop(session) { this.disconnected(session); state(session).pending.clear(); },
    context(session) {
      const output = state(session);
      const items = output.history.map(item => ({ ...item }));
      const task = session.tasks;
      const status = task?.turnId ? 'A task is still running. Do not start it again.'
        : output.lastResult ? `Last task result: ${output.lastResult}` : '';
      const waiting = task?.requests.size ? 'A request is waiting in the task panel.' : '';
      if (status || waiting) items.push({ role: 'developer', text: `Continuity context only, not a new task. ${status} ${waiting}` });
      return items.length ? { initialItems: items } : {};
    },
    request(session, kind) {
      queue(session, 'request', kind === 'input'
        ? 'The task needs your input. Please answer the question in the task panel.'
        : 'The task is waiting for approval. Please review the action in the task panel.');
    },
    requestResolved(session) { if (!session.tasks?.requests.size) state(session).pending.delete('request'); },
    notification(session, message) {
      const output = state(session), p = message.params || {};
      switch (message.method) {
        case 'thread/realtime/closed':
        case 'thread/realtime/error': this.disconnected(session); break;
        case 'thread/realtime/transcript/done':
          if (['user', 'assistant'].includes(p.role) && p.text) {
            output.history.push({ role: p.role, text: voiceText(p.text).slice(0, 1000) });
            if (output.history.length > 8) output.history.shift();
          }
          break;
        case 'turn/started': output.result = ''; output.progressSent = false; break;
        case 'item/completed': {
          const item = p.item;
          if (item?.type !== 'agentMessage' || /^\s*\[ANALYSIS\]/.test(item.text)) break;
          const text = voiceText(item.text);
          if (!text) break;
          if (item.phase === 'commentary') {
            if (!output.progressSent) {
              output.progressSent = true;
              queue(session, 'progress', `Task progress: ${text}`);
            }
          } else output.result = text;
          break;
        }
        case 'turn/completed': {
          const status = p.turn.status;
          const result = status === 'completed' ? output.result : voiceText(p.turn.error?.message || '');
          output.lastResult = `${status}. ${result}`;
          output.pending.delete('progress');
          output.pending.delete('request');
          queue(session, 'result', `Task ${status}. ${result}`);
          break;
        }
      }
    },
  };
}
