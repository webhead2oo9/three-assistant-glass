import { createEmotionService, createEmotionRouter } from './server/emotions.mjs';
import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import open from 'open';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import clipboardy from 'clipboardy';
import { fileURLToPath } from 'url';
import { promises as fsPromises } from 'fs';
import multer from 'multer';
import AdmZip from 'adm-zip';
import { CodexClient } from './server/codex-client.mjs';
import { createCodexRouter, localCodexRequest } from './server/codex-routes.mjs';
import { createChatRunner, UpstreamError } from './server/chat.mjs';
import { createTools } from './server/tools.mjs';
import { renderSystemMessages } from './server/prompt.mjs';
import { createRealtimeBridge, realtimeConfig } from './server/realtime.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Express app
const app = express();
const port = Number(process.env.THREE_ASSISTANT_PORT) || 3000;

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
fs.mkdir(uploadsDir, { recursive: true }).catch(console.error);

// Set up multer for file uploads
const upload = multer({ dest: uploadsDir });

// Serve static files from the current directory
app.use(express.static(__dirname));

// Serve index.html for the root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// New route to get animation files
app.get('/animations', async (req, res) => {
  const animationsDir = path.join(__dirname, 'animations');
  try {
    const files = await fs.readdir(animationsDir);
    const fbxFiles = files.filter(file => file.endsWith('.fbx'));
    res.json(fbxFiles);
  } catch (err) {
    console.error('Error reading animations directory:', err);
    res.status(500).json({ error: 'Unable to read animations directory' });
  }
});

// Serve Vapi UMD bundle
app.get('/vapi-web-bundle.min.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules', '@vapi-ai', 'web', 'dist', 'vapi-web-bundle.min.js'));
});

// Load or create settings.json
const settingsPath = path.join(__dirname, 'settings.json');
let settings = { hostClipboardBroadcast: false };

async function loadOrCreateSettings() {
  try {
    await fs.access(settingsPath);
    const data = await fs.readFile(settingsPath, 'utf8');
    settings = JSON.parse(data);
  } catch (error) {
    if (error.code === 'ENOENT') {
      await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));
    } else {
      console.error('Error accessing settings file:', error);
    }
  }
}

// Call this function before setting up routes
await loadOrCreateSettings();

const emotionService = createEmotionService();
app.use('/api/emotions', createEmotionRouter(emotionService, () => settings));
const codexClient = new CodexClient();
app.use('/api/codex', createCodexRouter(codexClient, { getSettings: () => settings }));

// Modify the /settings route
app.get('/settings', (req, res) => {
  res.sendFile(path.join(__dirname, 'settings.html'));
});

// Modify the /api/settings route
app.get('/api/settings', async (req, res) => {
  try {
    const settingsData = await fs.readFile(settingsPath, 'utf8');
    res.json(JSON.parse(settingsData));
  } catch (error) {
    console.error('Error reading settings:', error);
    res.status(500).json({ error: 'Unable to read settings' });
  }
});

app.post('/api/settings', express.json(), (req, res, next) => {
  if (Object.keys(req.body || {}).some(key => key.startsWith('codex'))) return localCodexRequest(req, res, next);
  next();
}, async (req, res) => {
  try {
    const currentSettings = { ...settings };
    
    // Update all possible settings
    const possibleSettings = [
      'hostClipboardBroadcast', 'vapiPublicKey', 'vapiPrivateKey',
      'showTime', 'timeFormat', 'freeCamera', 'sceneDebug',
      'dragDropSupport', 'vrmDebug', 'animationPicker', 'idleAnimation',
      'characterName', 'assistantID', 'settingsIconToggle', 'assistantShortcut',
      // Custom assistant (Settings → Assistant)
      'assistantProvider', 'assistantLanguage', 'bargeIn',
      'llmBaseUrl', 'llmApiKey', 'llmModel', 'llmSystemPrompt', 'llmFirstMessage', 'llmStream', 'llmTools', 'llmAutoExpressions',
      'assistantMode', 'realtimeProvider', 'realtimeBaseUrl', 'realtimeApiKey', 'realtimeModel', 'realtimeVoice',
      'realtimeIdleSeconds', 'realtimeAutoExpressions', 'liveBackendModel',
      'sttProvider', 'sttBaseUrl', 'sttApiKey', 'sttModel',
      'ttsProvider', 'ttsBaseUrl', 'ttsApiKey', 'ttsModel', 'ttsVoice', 'ttsSpeed',
      'codexInstructions', 'codexModel', 'codexVoice', 'codexWorkspace', 'codexTaskModel', 'codexAutoExpressions',
    ];

    possibleSettings.forEach(setting => {
      if (req.body[setting] !== undefined) {
        currentSettings[setting] = req.body[setting];
      }
    });
    
    await fs.writeFile(settingsPath, JSON.stringify(currentSettings, null, 2));
    settings = currentSettings;
    if (settings.codexAutoExpressions !== true) emotionService.close();
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating settings:', error);
    res.status(500).json({ error: 'Unable to update settings' });
  }
});

// Add a new route to get character information
app.get('/api/characters', async (req, res) => {
  const charactersDir = path.join(__dirname, 'characters');
  try {
    const files = await fsPromises.readdir(charactersDir);
    const characters = files
      .filter(file => file.endsWith('.vrm'))
      .map(file => {
        const name = path.parse(file).name;
        const imagePath = files.includes(`${name}.png`) 
          ? `/characters/${name}.png` 
          : '/images/Character_Card_Background.png';
        return { name, imagePath };
      });
    res.json(characters);
  } catch (err) {
    console.error('Error reading characters directory:', err);
    res.status(500).json({ error: 'Unable to read characters directory' });
  }
});

// Add a new route to handle character uploads
app.post('/api/upload-characters', upload.array('characters'), async (req, res) => {
  try {
    for (const file of req.files) {
      const oldPath = file.path;
      const fileExtension = path.extname(file.originalname).toLowerCase();
      
      if (fileExtension === '.zip') {
        // Extract zip file
        const zip = new AdmZip(oldPath);
        zip.extractAllTo(path.join(__dirname, 'characters'), true);
      } else if (['.png', '.vrm'].includes(fileExtension)) {
        // Move png and vrm files
        const newPath = path.join(__dirname, 'characters', file.originalname);
        await fs.rename(oldPath, newPath);
      }
      
      // We're no longer attempting to delete the temporary file
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error processing uploaded files:', error);
    res.status(500).json({ error: 'Failed to process uploaded files' });
  }
});

// ─── Custom assistant proxies ─────────────────────────────────────────────────
// The browser never talks to the LLM / STT / TTS providers directly: keys stay
// in settings.json on this machine and local servers (Ollama, LM Studio,
// speaches…) need no CORS configuration. STT and TTS fall back to the LLM's
// base URL and key, so a single xAI or OpenAI key configures everything.

const DEFAULT_LLM_BASE_URL = 'https://api.x.ai/v1';

function trimSlash(url) {
  return url.replace(/\/+$/, '');
}

function llmConfig() {
  return {
    baseUrl: trimSlash(settings.llmBaseUrl || DEFAULT_LLM_BASE_URL),
    apiKey: settings.llmApiKey || '',
    model: settings.llmModel || 'grok-4.6',
  };
}

function audioConfig(kind) {
  const llm = llmConfig();
  return {
    provider: settings[`${kind}Provider`] || 'xai',
    baseUrl: trimSlash(settings[`${kind}BaseUrl`] || llm.baseUrl),
    apiKey: settings[`${kind}ApiKey`] || llm.apiKey,
    model: settings[`${kind}Model`] || '',
    voice: settings.ttsVoice || '',
    speed: Number(settings.ttsSpeed) || 1,
    language: settings.assistantLanguage || '',
  };
}

function authHeaders(apiKey) {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

async function upstreamError(res, upstream) {
  const body = await upstream.text();
  console.error(`[assistant] upstream ${upstream.status}: ${body.slice(0, 500)}`);
  res.status(upstream.status).type('text/plain').send(body);
}

// One assistant turn. The browser always receives SSE in the OpenAI delta
// shape plus `{"tool": {name, label}}` events while a tool runs, whether the
// upstream streamed or not. System prompt placeholders ({{date}}, {{hour}},
// {{timezone}}) are filled in here so the browser never needs to know.
const chatRunner = createChatRunner();
const assistantTools = createTools();

app.post('/api/assistant/chat', express.json({ limit: '1mb' }), async (req, res) => {
  const { baseUrl, apiKey, model } = llmConfig();
  // Cancel the upstream stream if the browser goes away mid-response
  // (res 'close' fires on disconnect; req 'close' would fire once the body is read)
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableFinished) controller.abort(); });
  const send = (payload) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(payload)}\n\n`); };

  try {
    const messages = renderSystemMessages(req.body.messages || []);
    const stream = settings.llmStream !== false;
    const tools = settings.llmTools !== false ? assistantTools : null;
    let headersSent = false;
    const open = () => {
      if (headersSent) return;
      headersSent = true;
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.flushHeaders();
    };

    await chatRunner.run({
      baseUrl, apiKey, model, messages, tools, stream,
      signal: controller.signal,
      onDelta: (content) => { open(); send({ choices: [{ delta: { content } }] }); },
      onToolCall: (tool) => { open(); console.log(`[assistant] tool ${tool.name}`); send({ tool }); },
    });
    open();
    if (!res.writableEnded) res.write('data: [DONE]\n\n');
    res.end();
  } catch (error) {
    if (controller.signal.aborted) return;
    if (error instanceof UpstreamError) {
      console.error(`[assistant] ${error.message}`);
      if (!res.headersSent) return res.status(error.status).type('text/plain').send(error.body);
    } else {
      console.error('[assistant/chat]', error);
    }
    if (!res.headersSent) res.status(502).json({ error: error.message });
    else { send({ error: error.message }); res.end(); }
  }
});

// Transcribes a WAV body. xAI: POST /stt — OpenAI-compatible: POST /audio/transcriptions
app.post('/api/assistant/stt', express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '25mb' }), async (req, res) => {
  const cfg = audioConfig('stt');
  const form = new FormData();
  let url;
  if (cfg.provider === 'openai') {
    url = `${cfg.baseUrl}/audio/transcriptions`;
    form.append('model', cfg.model || 'whisper-1');
    form.append('response_format', 'json');
  } else {
    url = `${cfg.baseUrl}/stt`;
  }
  if (cfg.language) form.append('language', cfg.language);
  form.append('file', new Blob([req.body], { type: 'audio/wav' }), 'audio.wav'); // xAI requires file last

  try {
    const upstream = await fetch(url, { method: 'POST', headers: authHeaders(cfg.apiKey), body: form });
    if (!upstream.ok) return upstreamError(res, upstream);
    const result = await upstream.json();
    res.json({ text: result.text || '' });
  } catch (error) {
    console.error('[assistant/stt]', error);
    res.status(502).json({ error: error.message });
  }
});

// Synthesizes speech for one sentence and returns the audio file
app.post('/api/assistant/tts', express.json(), async (req, res) => {
  const cfg = audioConfig('tts');
  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'No text' });

  try {
    if (cfg.provider === 'openai') {
      const upstream = await fetch(`${cfg.baseUrl}/audio/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(cfg.apiKey) },
        body: JSON.stringify({
          model: cfg.model || 'tts-1',
          input: text,
          voice: cfg.voice || 'alloy',
          response_format: 'wav',
          speed: Math.min(4, Math.max(0.25, cfg.speed)),
        }),
      });
      if (!upstream.ok) return upstreamError(res, upstream);
      res.type(upstream.headers.get('content-type') || 'audio/wav');
      res.send(Buffer.from(await upstream.arrayBuffer()));
    } else {
      const upstream = await fetch(`${cfg.baseUrl}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(cfg.apiKey) },
        body: JSON.stringify({
          text,
          voice_id: cfg.voice || 'eve',
          language: cfg.language || 'auto',
          speed: Math.min(1.5, Math.max(0.7, cfg.speed)),
          output_format: { codec: 'mp3', sample_rate: 24000, bit_rate: 96000 },
        }),
      });
      if (!upstream.ok) return upstreamError(res, upstream);
      // xAI returns the audio bytes directly; some docs describe a
      // { audio: base64, content_type } JSON envelope — accept both.
      const contentType = upstream.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const result = await upstream.json();
        res.type(result.content_type || 'audio/mpeg');
        res.send(Buffer.from(result.audio, 'base64'));
      } else {
        res.type(contentType || 'audio/mpeg');
        res.send(Buffer.from(await upstream.arrayBuffer()));
      }
    }
  } catch (error) {
    console.error('[assistant/tts]', error);
    res.status(502).json({ error: error.message });
  }
});

// Voice list for the settings page (xAI only; other providers use fixed lists)
app.get('/api/assistant/voices', async (req, res) => {
  const cfg = audioConfig('tts');
  if (cfg.provider !== 'xai') return res.json({ voices: [] });
  try {
    const upstream = await fetch(`${cfg.baseUrl}/tts/voices`, { headers: authHeaders(cfg.apiKey) });
    if (!upstream.ok) return upstreamError(res, upstream);
    const result = await upstream.json();
    res.json({
      voices: (result.voices || []).map((v) => ({ id: v.voice_id, name: v.name || v.voice_id, language: v.language || '' })),
    });
  } catch (error) {
    console.error('[assistant/voices]', error);
    res.status(502).json({ error: error.message });
  }
});

// Model catalogue for the settings page: GET /models on the endpoint the given
// leg (llm, stt or tts) is configured for. The key stays on this side. Any
// failure - server down, endpoint absent, key rejected - is an empty list, so
// the field simply stays free text with no suggestions.
app.get('/api/assistant/models', async (req, res) => {
  const kind = String(req.query.for || 'llm');
  if (!['llm', 'stt', 'tts'].includes(kind)) return res.status(400).json({ error: 'for must be llm, stt or tts' });
  const cfg = kind === 'llm' ? llmConfig() : audioConfig(kind);
  if (kind !== 'llm' && !['xai', 'openai'].includes(cfg.provider)) return res.json({ models: [] });
  try {
    const upstream = await fetch(`${cfg.baseUrl}/models`, { headers: authHeaders(cfg.apiKey), signal: AbortSignal.timeout(8000) });
    if (!upstream.ok) {
      console.warn(`[assistant/models] ${cfg.baseUrl} answered ${upstream.status}`);
      return res.json({ models: [] });
    }
    const result = await upstream.json();
    res.json({ models: Array.isArray(result.data) ? result.data : [] });
  } catch (error) {
    console.warn(`[assistant/models] no catalogue from ${cfg.baseUrl}: ${error.message}`);
    res.json({ models: [] });
  }
});

const server = http.createServer(app);

// Two WebSocket endpoints share the HTTP server: the page's notification
// socket (clipboard etc.) on any path, and the realtime voice bridge on its own.
const wss = new WebSocketServer({ noServer: true });
const realtimeWss = new WebSocketServer({ noServer: true });
const realtimeBridge = createRealtimeBridge({
  config: () => realtimeConfig(settings),
  tools: assistantTools, // the llmTools setting decides whether definitions are sent
  WebSocketImpl: WebSocket,
});

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  const target = pathname === '/api/assistant/realtime' ? realtimeWss : wss;
  target.handleUpgrade(req, socket, head, (ws) => target.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
  console.log('Client connected');

  ws.on('close', () => {
    console.log('Client disconnected');
  });
});

realtimeWss.on('connection', (ws, req) => realtimeBridge.connect(ws, req));

let lastClipboardContent = '';

// Broadcast the HOST MACHINE's clipboard to every connected browser.
//
// clipboardy reads the clipboard of the machine running this server, and the
// result goes to all clients and into the assistant's context, so it is only
// the user's own clipboard when the browser is on this same machine. The
// setting is called hostClipboardBroadcast to say whose clipboard it is;
// clipboardAccess is the pre-rename key, still honoured.
const hostClipboardOn = () => settings.hostClipboardBroadcast ?? settings.clipboardAccess ?? false;
let warnedClipboard = false;

const checkClipboard = () => {
  if (!hostClipboardOn()) { warnedClipboard = false; return; }
  if (!warnedClipboard) {
    warnedClipboard = true;
    console.warn('[clipboard] hostClipboardBroadcast is ON: the clipboard of THIS machine is sent to every browser connected to this server, once a second.');
  }
  clipboardy.read().then(text => {
    if (text !== lastClipboardContent) {
      console.log('[clipboard] host clipboard changed, broadcasting to clients');
      lastClipboardContent = text;
      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: 'clipboard', content: text }));
        }
      });
    }
  }).catch(console.error);
};

const clipboardTimer = setInterval(checkClipboard, 1000);

function shutdown() {
  codexClient.close();
  clearInterval(clipboardTimer);
  for (const client of wss.clients) client.terminate();
  for (const client of realtimeWss.clients) client.terminate();
  wss.close();
  realtimeWss.close();
  server.close();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
server.once('close', () => codexClient.close());

server.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
  console.log(`Settings page available at http://localhost:${port}/settings`);
  if (process.env.THREE_ASSISTANT_NO_OPEN !== '1') open(`http://localhost:${port}`);
});
