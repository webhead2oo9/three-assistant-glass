// Bridges a browser WebSocket to a realtime speech-to-speech API: xAI's Grok
// Voice, OpenAI's gpt-realtime, or OpenAI's GPT-Live. The first two speak the
// OpenAI realtime event protocol; GPT-Live has its own (session.start,
// session.input_audio.append, session.output_audio.delta…) and delegates
// reasoning and tools to a backend Responses model. The session configuration
// differs per provider and is built here.
//
// The browser streams microphone PCM in and plays PCM out; everything else
// stays on this side: the API key, the session configuration (voice,
// instructions with {{date}}-style placeholders filled in, turn detection,
// tools) and the execution of tool calls the model makes. Upstream events are
// forwarded to the browser untouched, plus `{"type": "tool", "tool": {name,
// label}}` while a tool runs, so the page can show what's happening.
//
// xAI can resume a conversation it still remembers (about 30 minutes) when the
// browser reconnects with `?conversation_id=…`; that's how an idle session can
// hang up without losing context. OpenAI has no such thing, so the browser
// replays the transcript instead: gpt-realtime takes it as conversation items,
// GPT-Live as startup `input`, which the browser sends first as a
// `session.history` message that never reaches the upstream.

import { renderPrompt } from './prompt.mjs';
import { parseArguments } from './chat.mjs';

export const PROVIDERS = {
  xai: { url: 'wss://api.x.ai/v1/realtime', model: 'grok-voice-latest', voice: 'eve', resumes: true },
  openai: { url: 'wss://api.openai.com/v1/realtime', model: 'gpt-realtime-2.1', voice: 'marin', resumes: false },
  live: { url: 'wss://api.openai.com/v1/live/sessions', model: 'gpt-live-1', voice: 'marin', resumes: false },
};
export const DEFAULT_LIVE_BACKEND = 'gpt-5.6-luna';
const DEFAULT_INSTRUCTIONS = 'You are a friendly voice assistant. Keep replies short and conversational.';
const HISTORY_WAIT_MS = 300;   // how long a GPT-Live start waits for the browser's transcript
const MAX_HISTORY_CHARS = 1500; // a transcript arriving too late goes in as appended context (500-token limit)
const SAMPLE_RATE = 24000;
const OPENAI_TRANSCRIBER = 'gpt-4o-mini-transcribe';
const MAX_QUEUED_FRAMES = 200; // browser frames held until the upstream opens (~4 s of audio)
const CONNECTING = 0;
const OPEN = 1;

export function realtimeConfig(settings) {
  const provider = PROVIDERS[settings.realtimeProvider] ? settings.realtimeProvider : 'xai';
  const defaults = PROVIDERS[provider];
  return {
    provider,
    baseUrl: (settings.realtimeBaseUrl || defaults.url).replace(/\/+$/, ''),
    apiKey: settings.realtimeApiKey || settings.llmApiKey || '',
    model: settings.realtimeModel || defaults.model,
    voice: settings.realtimeVoice || defaults.voice,
    instructions: settings.llmSystemPrompt || DEFAULT_INSTRUCTIONS,
    language: settings.assistantLanguage || '',
    tools: settings.llmTools !== false,
    backendModel: settings.liveBackendModel || DEFAULT_LIVE_BACKEND,
  };
}

// GPT-Live splits the prompt in two: the voice layer gets the persona plus the
// conversation and delegation policy, the backend model gets the persona plus
// the tools. The policy wording follows OpenAI's Live prompting guide.
export function liveInstructions(persona, definitions) {
  const lines = [persona.trim(), '',
    'Interruption policy: stop speaking when the user interrupts, and listen to what they say.',
    '',
    'Delegation policy:',
    'Backend tools:'];
  for (const d of definitions) lines.push(`- ${d.name}: ${d.description || ''}`.trim());
  lines.push('- Reasoning: careful answers to questions that need thought, facts or figures.',
    '',
    'Delegate to the backend when:',
    '- The request needs a backend tool or careful reasoning.',
    '- A correction changes work already requested.',
    '',
    'Do not delegate to the backend when:',
    '- You can answer from the conversation or a still-current result.',
    '- You need a brief clarification to understand the request.',
    '',
    'Delegate before giving an answer that depends on backend work. Do not guess the result while waiting.');
  return lines.join('\n');
}

function backendInstructions(persona) {
  return `${persona.trim()}\n\nYou are the backend of a live voice conversation. The voice layer speaks your results aloud, so answer in one or two short spoken sentences.`;
}

// Text turns from the browser ({role, text}) as GPT-Live startup history
function historyItems(turns) {
  return turns.slice(-128).map((turn) => ({
    type: 'message',
    role: turn.role === 'assistant' ? 'assistant' : 'user',
    content: [{ type: turn.role === 'assistant' ? 'output_text' : 'input_text', text: String(turn.text) }],
  }));
}

// The session.start that opens a GPT-Live WebSocket
export function sessionStart(config, tools, variables, history = []) {
  const persona = renderPrompt(config.instructions, variables);
  const definitions = config.tools && tools ? tools.definitions().map((d) => ({ type: 'function', ...d.function })) : [];
  const responses = { model: config.backendModel, instructions: backendInstructions(persona) };
  if (definitions.length) responses.tools = definitions;
  const session = {
    model: config.model,
    instructions: liveInstructions(persona, definitions),
    audio: { format: { type: 'audio/pcm', rate: SAMPLE_RATE }, output: { voice: config.voice } },
    delegation: { type: 'responses', responses },
  };
  const input = historyItems(history);
  if (input.length) session.input = input;
  return { type: 'session.start', session };
}

// The session.update sent as soon as the upstream opens
export function sessionUpdate(config, tools, variables) {
  const instructions = renderPrompt(config.instructions, variables);
  // Both providers take the flat OpenAI-realtime tool shape, not chat's nested one
  const definitions = config.tools && tools ? tools.definitions().map((d) => ({ type: 'function', ...d.function })) : [];
  const pcm = { type: 'audio/pcm', rate: SAMPLE_RATE };

  if (config.provider === 'openai') {
    const transcription = { model: OPENAI_TRANSCRIBER };
    if (config.language) transcription.language = config.language.split('-')[0].toLowerCase();
    const session = {
      type: 'realtime',
      model: config.model,
      output_modalities: ['audio'],
      instructions,
      audio: {
        input: { format: pcm, turn_detection: { type: 'server_vad' }, transcription },
        output: { format: { type: 'audio/pcm' }, voice: config.voice },
      },
    };
    if (definitions.length) session.tools = definitions;
    return { type: 'session.update', session };
  }

  const input = { format: pcm, transport: 'json' };
  if (config.language) input.transcription = { language_hint: config.language };
  const session = {
    voice: config.voice,
    instructions,
    turn_detection: { type: 'server_vad' },
    audio: { input, output: { format: pcm, transport: 'json' } },
    resumption: { enabled: true },
  };
  if (definitions.length) session.tools = definitions;
  return { type: 'session.update', session };
}

export function createRealtimeBridge({ config, tools, WebSocketImpl, log = console }) {
  return {
    connect(browser, request) {
      const settings = config();
      const live = settings.provider === 'live';
      if (!settings.apiKey) {
        fail(browser, `No ${settings.provider === 'xai' ? 'xAI' : 'OpenAI'} API key. Add one under Settings → Assistant.`);
        return;
      }
      const url = new URL(settings.baseUrl);
      if (!live) url.searchParams.set('model', settings.model); // GPT-Live takes the model in session.start
      const conversationId = new URL(request?.url || '/', 'http://localhost').searchParams.get('conversation_id');
      if (conversationId && PROVIDERS[settings.provider].resumes) url.searchParams.set('conversation_id', conversationId);

      const upstream = new WebSocketImpl(url.toString(), { headers: { Authorization: `Bearer ${settings.apiKey}` } });
      const queued = [];
      let open = false;
      let started = !live;   // GPT-Live: session.start has been sent
      let history = null;    // GPT-Live: the browser's transcript, sent as startup input
      let historyWait = null;

      const toBrowser = (payload) => {
        if (browser.readyState === OPEN) browser.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
      };
      const toUpstream = (payload) => {
        const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
        if (open && started && upstream.readyState === OPEN) upstream.send(text);
        else if (queued.length < MAX_QUEUED_FRAMES) queued.push(text);
      };
      const flush = () => {
        for (const frame of queued) upstream.send(frame);
        queued.length = 0;
      };

      async function runTool(call) {
        toBrowser({ type: 'tool', tool: { name: call.name, label: tools.label(call.name) } });
        log.log(`[realtime] tool ${call.name}`);
        const args = parseArguments(call.arguments);
        const result = args.error ? { error: args.error } : await tools.run(call.name, args.value);
        const item = { type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result) };
        toUpstream(live ? { type: 'response.item.create', item } : { type: 'conversation.item.create', item });
        toUpstream({ type: 'response.create' });
      }

      // GPT-Live: the browser sends its transcript first; wait briefly for it so
      // a reconnect starts with the conversation so far, then start regardless.
      function startLive() {
        if (started) return;
        started = true;
        clearTimeout(historyWait);
        upstream.send(JSON.stringify(sessionStart(settings, tools, undefined, history || [])));
        flush();
      }

      upstream.on('open', () => {
        open = true;
        if (live) {
          if (history !== null) startLive();
          else historyWait = setTimeout(startLive, HISTORY_WAIT_MS);
        } else {
          upstream.send(JSON.stringify(sessionUpdate(settings, tools)));
          flush();
        }
        log.log(`[realtime] connected to ${settings.provider} (${settings.model}${conversationId ? ', resumed' : ''})`);
      });
      upstream.on('message', (data) => {
        const text = data.toString();
        toBrowser(text);
        let event;
        try { event = JSON.parse(text); } catch { return; }
        if (!tools || !event) return;
        if (event.type === 'response.function_call_arguments.done') void runTool(event);
        // GPT-Live wraps the backend's Responses stream; a finished function call is inside
        const inner = event.type === 'response.event' ? event.event : null;
        if (inner?.type === 'response.output_item.done' && inner.item?.type === 'function_call') void runTool(inner.item);
      });
      // The handshake was refused (bad key, bad model…): relay the reason, then the socket closes
      upstream.on('unexpected-response', (_req, res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => fail(browser, `${settings.provider} realtime ${res.statusCode}: ${body.slice(0, 300) || res.statusMessage || ''}`.trim()));
        res.on('error', () => fail(browser, `${settings.provider} realtime ${res.statusCode}`));
      });
      upstream.on('error', (error) => {
        log.error(`[realtime] ${error.message}`);
        toBrowser({ type: 'error', error: { message: error.message } });
      });
      upstream.on('close', () => {
        open = false;
        if (browser.readyState === OPEN || browser.readyState === CONNECTING) browser.close(1000);
      });

      browser.on('message', (data) => {
        const text = data.toString();
        if (live && text.includes('"session.history"')) {
          let event;
          try { event = JSON.parse(text); } catch { return; }
          if (event?.type === 'session.history') {
            const turns = Array.isArray(event.items) ? event.items : [];
            if (!started) {
              history = turns;
              if (open) startLive();
            } else if (turns.length) {
              // Too late for startup input: hand it over as silent context instead
              const lines = turns.map((t) => `${t.role === 'assistant' ? 'You' : 'User'}: ${t.text}`);
              let content = lines.join('\n');
              while (content.length > MAX_HISTORY_CHARS && lines.length > 1) { lines.shift(); content = lines.join('\n'); }
              toUpstream({ type: 'session.thinking.append', delegation_id: null, content: `Conversation so far:\n${content}` });
            }
            return;
          }
        }
        toUpstream(text);
      });
      browser.on('close', () => {
        clearTimeout(historyWait);
        if (upstream.readyState === OPEN) upstream.close(1000);
        else if (upstream.readyState === CONNECTING) upstream.terminate?.();
      });
    },
  };
}

function fail(browser, message) {
  if (browser.readyState !== OPEN) return;
  browser.send(JSON.stringify({ type: 'error', error: { message } }));
  browser.close(1011, message.slice(0, 120));
}
