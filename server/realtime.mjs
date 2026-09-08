// Bridges a browser WebSocket to xAI's realtime speech-to-speech API.
//
// The browser streams microphone PCM in and plays PCM out; everything else
// stays here: the API key, the session configuration (voice, instructions
// with {{date}}-style placeholders filled in, turn detection, tools) and the
// execution of tool calls the model makes. Upstream events are forwarded to
// the browser untouched, plus `{"type": "tool", "tool": {name, label}}` while
// a tool runs, so the page can show what's happening.
//
// Reconnecting with `?conversation_id=…` resumes a conversation the upstream
// still remembers (about 30 minutes), which is how the browser can hang up an
// idle session without losing context.

import { renderPrompt } from './prompt.mjs';
import { parseArguments } from './chat.mjs';

export const REALTIME_URL = 'wss://api.x.ai/v1/realtime';
const DEFAULT_MODEL = 'grok-voice-latest';
const DEFAULT_VOICE = 'eve';
const DEFAULT_INSTRUCTIONS = 'You are a friendly voice assistant. Keep replies short and conversational.';
const SAMPLE_RATE = 24000;
const MAX_QUEUED_FRAMES = 200; // browser frames held until the upstream opens (~4 s of audio)
const CONNECTING = 0;
const OPEN = 1;

export function realtimeConfig(settings) {
  return {
    apiKey: settings.realtimeApiKey || settings.llmApiKey || '',
    model: settings.realtimeModel || DEFAULT_MODEL,
    voice: settings.realtimeVoice || DEFAULT_VOICE,
    instructions: settings.realtimeInstructions || settings.llmSystemPrompt || DEFAULT_INSTRUCTIONS,
    language: settings.assistantLanguage || '',
    tools: settings.realtimeTools !== false,
  };
}

// The session.update sent as soon as the upstream opens
export function sessionUpdate(config, tools, variables) {
  const input = { format: { type: 'audio/pcm', rate: SAMPLE_RATE }, transport: 'json' };
  if (config.language) input.transcription = { language_hint: config.language };
  const session = {
    voice: config.voice,
    instructions: renderPrompt(config.instructions, variables),
    turn_detection: { type: 'server_vad' },
    audio: { input, output: { format: { type: 'audio/pcm', rate: SAMPLE_RATE }, transport: 'json' } },
    resumption: { enabled: true },
  };
  // The realtime API takes the flat OpenAI-realtime tool shape, not chat's nested one
  const definitions = config.tools && tools ? tools.definitions().map((d) => ({ type: 'function', ...d.function })) : [];
  if (definitions.length) session.tools = definitions;
  return { type: 'session.update', session };
}

export function createRealtimeBridge({ config, tools, WebSocketImpl, log = console }) {
  return {
    connect(browser, request) {
      const settings = config();
      if (!settings.apiKey) {
        fail(browser, 'No xAI API key. Add one under Settings → Assistant.');
        return;
      }
      const url = new URL(REALTIME_URL);
      url.searchParams.set('model', settings.model);
      const conversationId = new URL(request?.url || '/', 'http://localhost').searchParams.get('conversation_id');
      if (conversationId) url.searchParams.set('conversation_id', conversationId);

      const upstream = new WebSocketImpl(url.toString(), { headers: { Authorization: `Bearer ${settings.apiKey}` } });
      const queued = [];
      let open = false;

      const toBrowser = (payload) => {
        if (browser.readyState === OPEN) browser.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
      };
      const toUpstream = (payload) => {
        const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
        if (open && upstream.readyState === OPEN) upstream.send(text);
        else if (queued.length < MAX_QUEUED_FRAMES) queued.push(text);
      };

      async function runTool(event) {
        toBrowser({ type: 'tool', tool: { name: event.name, label: tools.label(event.name) } });
        log.log(`[realtime] tool ${event.name}`);
        const args = parseArguments(event.arguments);
        const result = args.error ? { error: args.error } : await tools.run(event.name, args.value);
        toUpstream({
          type: 'conversation.item.create',
          item: { type: 'function_call_output', call_id: event.call_id, output: JSON.stringify(result) },
        });
        toUpstream({ type: 'response.create' });
      }

      upstream.on('open', () => {
        open = true;
        upstream.send(JSON.stringify(sessionUpdate(settings, tools)));
        for (const frame of queued) upstream.send(frame);
        queued.length = 0;
        log.log(`[realtime] connected (${settings.model}${conversationId ? ', resumed' : ''})`);
      });
      upstream.on('message', (data) => {
        const text = data.toString();
        toBrowser(text);
        let event;
        try { event = JSON.parse(text); } catch { return; }
        if (event?.type === 'response.function_call_arguments.done' && tools) void runTool(event);
      });
      // The handshake was refused (bad key, bad model…): relay the reason, then the socket closes
      upstream.on('unexpected-response', (_req, res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => fail(browser, `xAI realtime ${res.statusCode}: ${body.slice(0, 300) || res.statusMessage || ''}`.trim()));
        res.on('error', () => fail(browser, `xAI realtime ${res.statusCode}`));
      });
      upstream.on('error', (error) => {
        log.error(`[realtime] ${error.message}`);
        toBrowser({ type: 'error', error: { message: error.message } });
      });
      upstream.on('close', () => {
        open = false;
        if (browser.readyState === OPEN || browser.readyState === CONNECTING) browser.close(1000);
      });

      browser.on('message', (data) => toUpstream(data.toString()));
      browser.on('close', () => {
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
