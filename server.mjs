import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import open from 'open';
import http from 'http';
import net from 'net';
import { WebSocketServer, WebSocket } from 'ws';
import clipboardy from 'clipboardy';
import { fileURLToPath } from 'url';
import { promises as fsPromises } from 'fs';
import multer from 'multer';
import AdmZip from 'adm-zip';
import { sendEvent, readEvents, buildWavHeader } from './wyoming.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Express app
const app = express();
const port = 3000;

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
let settings = { clipboardAccess: false };

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

// Modify the /settings route
app.get('/settings', (req, res) => {
  res.sendFile(path.join(__dirname, 'settings.html'));
});

// Add a new route to get and set the clipboard access setting
app.get('/api/settings/clipboard', (req, res) => {
  res.json({ clipboardAccess: settings.clipboardAccess });
});

app.post('/api/settings/clipboard', express.json(), async (req, res) => {
  settings.clipboardAccess = req.body.clipboardAccess;
  try {
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));
    res.json({ success: true });
  } catch (error) {
    console.error('Error writing settings:', error);
    res.status(500).json({ error: 'Unable to update settings' });
  }
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

app.post('/api/settings', express.json(), async (req, res) => {
  try {
    const currentSettings = { ...settings };
    
    // Update all possible settings
    const possibleSettings = [
      'clipboardAccess', 'vapiPublicKey', 'vapiPrivateKey',
      'showTime', 'timeFormat', 'freeCamera', 'sceneDebug',
      'dragDropSupport', 'vrmDebug', 'animationPicker', 'idleAnimation',
      'characterName', 'assistantID', 'settingsIconToggle', 'assistantShortcut',
      'assistantProvider', 'customLLMBaseUrl', 'customLLMApiKey', 'customLLMModel',
      'customSystemPrompt', 'customFirstMessage',
      'wyomingSttHost', 'wyomingSttPort', 'wyomingTtsHost', 'wyomingTtsPort', 'wyomingTtsVoice',
    ];

    possibleSettings.forEach(setting => {
      if (req.body[setting] !== undefined) {
        currentSettings[setting] = req.body[setting];
      }
    });
    
    await fs.writeFile(settingsPath, JSON.stringify(currentSettings, null, 2));
    settings = currentSettings;
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

const server = http.createServer(app);

// General WebSocket server (clipboard, etc.) — noServer so we route manually
const wss = new WebSocketServer({ noServer: true });
const wssSTT = new WebSocketServer({ noServer: true });
const wssTTS = new WebSocketServer({ noServer: true });

// Route WebSocket upgrade requests by path
server.on('upgrade', (req, socket, head) => {
  if (req.url === '/wyoming/stt') {
    wssSTT.handleUpgrade(req, socket, head, (ws) => wssSTT.emit('connection', ws, req));
  } else if (req.url === '/wyoming/tts') {
    wssTTS.handleUpgrade(req, socket, head, (ws) => wssTTS.emit('connection', ws, req));
  } else {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  }
});

wss.on('connection', (ws) => {
  console.log('Client connected');

  ws.on('close', () => {
    console.log('Client disconnected');
  });
});

// ─── Wyoming STT handler (/wyoming/stt) ────────────────────────────────────

// Calculate RMS amplitude of a 16-bit LE PCM buffer
function pcmRMS(buf) {
  let sum = 0;
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const s = buf.readInt16LE(i);
    sum += s * s;
  }
  return Math.sqrt(sum / (buf.length / 2));
}

wssSTT.on('connection', (ws) => {
  const sttHost = settings.wyomingSttHost || 'localhost';
  const sttPort = parseInt(settings.wyomingSttPort) || 10300;

  // VAD config
  const SPEECH_THRESHOLD = 500;   // RMS level to count as speech (0–32767)
  const SILENCE_FRAMES   = 3;     // consecutive silent frames before triggering (~768ms at 256ms/frame)
  const MIN_SPEECH_FRAMES = 2;    // ignore very short bursts (< ~512ms)

  let tcp = null;
  let tcpReady = false;
  let speaking = false;
  let silenceCount = 0;
  let speechCount = 0;
  let waitingForTranscript = false;

  function openTcpSession() {
    if (tcp) tcp.destroy();
    tcp = net.createConnection({ host: sttHost, port: sttPort });
    tcpReady = false;

    tcp.on('connect', () => {
      tcpReady = true;
      console.log('[Wyoming STT] TCP session opened');
      sendEvent(tcp, 'transcribe', { language: 'en' });
      sendEvent(tcp, 'audio-start', { rate: 16000, width: 2, channels: 1 });
    });

    tcp.on('error', (err) => {
      console.error('[Wyoming STT] TCP error:', err.message);
      tcpReady = false;
    });

    // Read transcript from this session, forward to browser, then open next session
    (async () => {
      for await (const event of readEvents(tcp)) {
        if (event.type === 'transcript') {
          const text = (event.data.text || '').trim();
          console.log(`[Wyoming STT] transcript: "${text}"`);
          if (text && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'fullSentence', text }));
          }
          break; // one transcript per session
        } else {
          console.log(`[Wyoming STT] event: ${event.type}`);
        }
      }
      tcp.destroy();
      waitingForTranscript = false;
      console.log('[Wyoming STT] ready for next utterance');
      if (ws.readyState === WebSocket.OPEN) openTcpSession();
    })().catch((err) => console.error('[Wyoming STT] readEvents error:', err));
  }

  console.log(`[Wyoming STT] Browser connected → ${sttHost}:${sttPort}`);
  openTcpSession(); // open first session immediately

  // Receive binary audio frames from browser
  // Frame format: [4 bytes LE: metaLen][metaLen bytes JSON][PCM bytes]
  let frameCount = 0;
  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length < 4) return;

    const metaLen = buf.readUInt32LE(0);
    if (buf.length < 4 + metaLen) return;
    const pcm = buf.slice(4 + metaLen);
    if (pcm.length === 0) return;

    frameCount++;
    if (frameCount === 1 || frameCount % 50 === 0) {
      console.log(`[Wyoming STT] frame #${frameCount} rms:${Math.round(pcmRMS(pcm))} speaking:${speaking} silence:${silenceCount}`);
    }

    // While waiting for transcript from previous utterance, discard audio
    if (waitingForTranscript) return;

    const rms = pcmRMS(pcm);

    if (rms >= SPEECH_THRESHOLD) {
      // Active speech
      speaking = true;
      silenceCount = 0;
      speechCount++;
      if (tcpReady) sendEvent(tcp, 'audio-chunk', { rate: 16000, width: 2, channels: 1 }, pcm);
    } else if (speaking) {
      // Silence after speech
      silenceCount++;
      if (tcpReady) sendEvent(tcp, 'audio-chunk', { rate: 16000, width: 2, channels: 1 }, pcm);

      if (silenceCount >= SILENCE_FRAMES) {
        if (speechCount >= MIN_SPEECH_FRAMES) {
          // End of utterance — flush to faster-whisper
          console.log(`[Wyoming STT] end of utterance (${speechCount} speech frames), sending audio-stop`);
          waitingForTranscript = true;
          if (tcpReady) sendEvent(tcp, 'audio-stop', {});
        } else {
          // Too short — likely noise, reset quietly
          console.log('[Wyoming STT] burst too short, ignoring');
          openTcpSession();
        }
        speaking = false;
        silenceCount = 0;
        speechCount = 0;
      }
    }
    // pure silence before any speech: don't send to faster-whisper
  });

  ws.on('close', () => {
    console.log('[Wyoming STT] Browser disconnected');
    if (tcp) {
      // If waiting for transcript the IIFE already owns cleanup; otherwise we do it
      if (!waitingForTranscript && tcpReady) sendEvent(tcp, 'audio-stop', {});
      tcp.destroy();
      tcp = null;
    }
  });
});

// ─── Wyoming TTS handler (/wyoming/tts) ────────────────────────────────────
wssTTS.on('connection', (ws) => {
  console.log('[Wyoming TTS] Browser connected');

  ws.on('message', async (data, isBinary) => {
    if (isBinary) return;
    const text = data.toString('utf8').trim();
    if (!text) return;

    const ttsHost = settings.wyomingTtsHost || 'localhost';
    const ttsPort = parseInt(settings.wyomingTtsPort) || 10200;
    console.log(`[Wyoming TTS] opening TCP to ${ttsHost}:${ttsPort}`);
    const ttsVoice = settings.wyomingTtsVoice || 'en_US-lessac-medium';

    const tcp = net.createConnection({ host: ttsHost, port: ttsPort });
    const audioChunks = [];
    let sampleRate = 22050;

    tcp.on('connect', () => {
      sendEvent(tcp, 'synthesize', {
        text,
        voice: { name: ttsVoice },
      });
    });

    tcp.on('error', (err) => {
      console.error('[Wyoming TTS] TCP error:', err.message);
      tcp.destroy(); // triggers close → readEvents generator exits cleanly
    });

    try {
      for await (const event of readEvents(tcp)) {
        if (event.type === 'audio-start') {
          sampleRate = event.data.rate || 22050;
          console.log(`[Wyoming TTS] audio-start: ${sampleRate} Hz`);
        } else if (event.type === 'audio-chunk' && event.payload) {
          audioChunks.push(event.payload);
        } else if (event.type === 'audio-stop') {
          console.log('[Wyoming TTS] audio-stop');
          break;
        }
      }
    } catch (err) {
      console.error('[Wyoming TTS] stream error:', err.message);
    } finally {
      tcp.destroy();
    }

    if (audioChunks.length === 0) {
      console.warn('[Wyoming TTS] No audio received from Piper');
      return;
    }

    const pcmData = Buffer.concat(audioChunks);
    const wavHeader = buildWavHeader(pcmData.length, sampleRate, 1, 16);
    const wavData = Buffer.concat([wavHeader, pcmData]);
    const b64 = wavData.toString('base64');

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ audioOutput: { audio: b64 } }));
    }

    console.log(`[Wyoming TTS] Sent ${wavData.length} bytes of WAV audio`);
  });

  ws.on('close', () => {
    console.log('[Wyoming TTS] Browser disconnected');
  });
});

let lastClipboardContent = '';

// Modify the clipboard checking interval
const checkClipboard = () => {
  if (settings.clipboardAccess) {
    clipboardy.read().then(text => {
      if (text !== lastClipboardContent) {
        console.log('Clipboard changed:', text);
        lastClipboardContent = text;
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'clipboard', content: text }));
          }
        });
      }
    }).catch(console.error);
  }
};

setInterval(checkClipboard, 1000);

server.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
  console.log(`Settings page available at http://localhost:${port}/settings`);
  open(`http://localhost:${port}`);
});