import path from 'node:path';
import { stat, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { cleanCodexText } from './codex-text.mjs';
import { createCodexVoiceOutput } from './codex-voice-output.mjs';

const COMMAND = 'item/commandExecution/requestApproval';
const FILES = 'item/fileChange/requestApproval';
const PERMISSIONS = 'item/permissions/requestApproval';
const INPUT = 'item/tool/requestUserInput';
const REQUESTS = new Set([COMMAND, FILES, PERMISSIONS, INPUT]);
const limit = text => typeof text === 'string' ? text.slice(-12000) : '';
const fail = (text, status = 400) => Object.assign(new Error(text), { status });

function webActionText(item) {
  const action = item.action;
  const value = text => typeof text === 'string' ? text.trim() : '';
  if (action?.type === 'openPage') {
    const url = value(action.url);
    return url ? `Open page: ${url}` : 'Open page';
  }
  if (action?.type === 'findInPage') {
    const pattern = value(action.pattern), url = value(action.url);
    return `Find in page${pattern ? `: ${pattern}` : ''}${url ? `\nPage: ${url}` : ''}`;
  }
  const queries = Array.isArray(action?.queries) ? action.queries.map(value).filter(Boolean) : [];
  const query = queries.join('\n') || value(action?.query) || value(item.query);
  if (query) return `Search: ${query}`;
  return action?.type === 'search' ? 'Web search' : 'Web activity';
}

// This is the native Codex realtime/task bridge, not a provider-neutral tool runner.
export async function codexTaskConfig(settings, defaultWorkspace) {
  const workspace = settings.codexWorkspace || defaultWorkspace;
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) throw fail('Task workspace must be an absolute folder path.');
  let cwd;
  try {
    cwd = await realpath(workspace);
    if (!(await stat(cwd)).isDirectory()) throw new Error();
  } catch { throw fail('Task workspace does not exist or is not a folder.'); }
  const model = settings.codexTaskModel || '';
  if (typeof model !== 'string' || (model && !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/.test(model))) throw fail('Invalid task model name.');
  return {
    cwd, ...(model ? { model } : {}), modelProvider: 'openai', ephemeral: true,
    sandbox: 'workspace-write', approvalPolicy: 'untrusted', approvalsReviewer: 'user',
    // Omit environments to select Codex's default local execution environment.
    config: { 'features.realtime_conversation': true, 'features.shell_tool': true,
      'web_search': 'live', 'features.apps': false,
      'features.multi_agent': false, 'features.multi_agent_v2': false },
    developerInstructions: 'You handle tasks delegated by the voice of a 3D character. ' +
      'Complete the requested work using your tools, and provide concise progress and a clear final result. ' +
      'The user sees your task output in a separate panel. Use ordinary Markdown links for web sources. ' +
      'Requests for approval or clarification appear there too.',
  };
}

export function codexVoiceInstructions(character) {
  return `${character}\n\nYou are the voice interface for a Codex task agent. ` +
    'Delegate actions, research, file work, and requests needing tools to the backing agent using the realtime delegation mechanism. ' +
    'Delegate follow-up corrections too so they steer running work. Continue conversing while work runs. ' +
    'Use the agent results to explain progress and outcomes; never claim work succeeded before its result. ' +
    'In the conversation stream, [USER] marks user text and [BACKEND] marks agent updates or results. ' +
    'Approval JSON and citation tokens are control metadata, not speech. Never read them aloud. ' +
    'Finishing a task does not finish the voice conversation; report the result briefly and keep listening. ' +
    'The user can see task output and answer approval or clarification requests in the ChatGPT task panel. ' +
    'Keep spoken replies natural and concise; do not read code or long output aloud.';
}

export function createCodexTaskHandler(client, { sessions, emit }) {
  const voice = createCodexVoiceOutput(client, emit);
  const find = threadId => [...sessions.values()].find(s => s.threadId === threadId);
  const state = s => s.tasks ||= { turnId: null, items: new Map(), text: new Map(), requests: new Map() };

  function settle(session, id, result) {
    const pending = state(session).requests.get(id);
    if (!pending) return;
    state(session).requests.delete(id);
    voice.requestResolved(session);
    pending.respond(result);
    emit(session, 'codex/task/requestResolved', { requestId: id });
  }

  function dismiss(session, turnId) {
    for (const [id, request] of state(session).requests) {
      if (!turnId || request.params.turnId === turnId) {
        settle(session, id, request.method === INPUT ? { answers: {} }
          : request.method === PERMISSIONS ? { permissions: {}, scope: 'turn' } : { decision: 'cancel' });
      }
    }
  }

  client.on('request', (message, respond) => {
    const params = message.params || {};
    const session = find(params.threadId);
    if (!REQUESTS.has(message.method) || !session || session.closed) {
      respond(null, { code: -32601, message: 'This request is not supported by the active ChatGPT task session.' });
      return;
    }
    const task = state(session);
    const item = task.items.get(params.itemId);
    // Keep the complete proposed action reviewable. Never approve an abbreviated diff.
    const details = { ...params, ...(message.method === FILES ? { changes: item?.changes || null } : {}) };
    if (JSON.stringify(details).length > 96000 || task.requests.size >= 16) {
      respond(null, { code: -32602, message: 'Request is too large to review here. Split it into smaller actions.' });
      return;
    }
    const requestId = randomUUID();
    const canAccept = message.method === FILES ? !!item?.changes?.length
      : message.method !== COMMAND || !!(params.command || params.networkApprovalContext || params.additionalPermissions);
    const decisions = (params.availableDecisions || ['accept', 'decline', 'cancel'])
      .filter(d => ['accept', 'decline', 'cancel'].includes(d) && (d !== 'accept' || canAccept));
    task.requests.set(requestId, { rpcId: message.id, method: message.method, params, respond, decisions });
    emit(session, 'codex/task/request', { requestId, kind: message.method === INPUT ? 'input'
      : message.method === PERMISSIONS ? 'permissions' : message.method === FILES ? 'files' : 'command',
      details, decisions });
    voice.request(session, message.method === INPUT ? 'input' : 'approval');
  });

  return {
    voiceReady(session) { voice.ready(session); },
    voiceContext(session) { return voice.context(session); },
    voiceDisconnected(session) { voice.disconnected(session); },
    notification(message) {
      const p = message.params || {}, session = find(p.threadId);
      if (!session) return;
      const task = state(session);
      voice.notification(session, message);
      switch (message.method) {
        case 'thread/realtime/itemAdded':
          if (p.item?.type === 'handoff_request') emit(session, 'codex/task/handoff', { text: limit(p.item.input_transcript) });
          break;
        case 'turn/started':
          task.turnId = p.turn.id;
          task.items.clear();
          task.text.clear();
          emit(session, 'codex/task/status', { turnId: task.turnId, status: 'working' });
          break;
        case 'turn/completed':
          dismiss(session, p.turn.id);
          if (task.turnId === p.turn.id) task.turnId = null;
          emit(session, 'codex/task/status', { turnId: p.turn.id, status: p.turn.status, error: limit(p.turn.error?.message) });
          break;
        case 'item/started':
        case 'item/completed': {
          const item = p.item;
          if (!item) break;
          if (item.type === 'fileChange' && JSON.stringify(item).length <= 96000) {
            task.items.set(item.id, item);
            if (task.items.size > 32) task.items.delete(task.items.keys().next().value);
          }
          const text = item.type === 'agentMessage' ? item.text
            : item.type === 'commandExecution' ? `${item.command}\n${item.aggregatedOutput || ''}`
              : item.type === 'fileChange' ? (item.changes || []).map(c => `${c.path}\n${c.diff}`).join('\n')
                : item.type === 'webSearch' ? webActionText(item) : '';
          if (text) emit(session, 'codex/task/output', { itemId: item.id, text: limit(cleanCodexText(text)) });
          if (item.type === 'agentMessage') task.text.delete(item.id);
          break;
        }
        case 'item/agentMessage/delta': {
          const text = ((task.text.get(p.itemId) || '') + (p.delta || '')).slice(-24000);
          task.text.set(p.itemId, text);
          if (task.text.size > 32) task.text.delete(task.text.keys().next().value);
          emit(session, 'codex/task/output', { itemId: p.itemId, text: limit(cleanCodexText(text, true)) });
          break;
        }
        case 'serverRequest/resolved':
          for (const [id, request] of task.requests) {
            if (request.rpcId === p.requestId) {
              task.requests.delete(id);
              voice.requestResolved(session);
              client.incoming?.delete(p.requestId);
              emit(session, 'codex/task/requestResolved', { requestId: id });
            }
          }
          break;
      }
    },

    reply(session, id, body) {
      const request = state(session).requests.get(id);
      if (!request) throw fail('This request has already ended.', 409);
      let result;
      if (request.method === INPUT) {
        const answers = Object.create(null);
        for (const q of request.params.questions) {
          const value = body.answers?.[q.id];
          if (typeof value !== 'string' || !value.trim() || value.length > 8000) throw fail('Answer each question (up to 8,000 characters).');
          answers[q.id] = { answers: [value] };
        }
        result = { answers };
      } else if (request.method === PERMISSIONS) {
        if (!['accept', 'decline'].includes(body.decision)) throw fail('Invalid permission decision.');
        result = { permissions: body.decision === 'accept' ? request.params.permissions : {}, scope: 'turn' };
      } else {
        if (!request.decisions.includes(body.decision)) throw fail('Invalid approval decision.');
        result = { decision: body.decision };
      }
      settle(session, id, result);
    },

    async cancel(session) {
      const task = state(session), turnId = task.turnId;
      if (!turnId) throw fail('There is no running task to cancel.', 409);
      // Interrupt before releasing pending questions so work cannot resume first.
      await client.request('turn/interrupt', { threadId: session.threadId, turnId });
      dismiss(session, turnId);
      if (task.turnId === turnId) task.turnId = null;
      emit(session, 'codex/task/status', { turnId, status: 'interrupted' });
    },

    async stop(session) {
      voice.stop(session);
      const turnId = state(session).turnId;
      if (turnId && client.child) {
        await client.request('turn/interrupt', { threadId: session.threadId, turnId }).catch(() => {});
      }
      dismiss(session);
      state(session).turnId = null;
      state(session).items.clear();
      state(session).text.clear();
    },
  };
}
