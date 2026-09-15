// ElevenLabs request builders and response normalisers for the STT / TTS
// proxies in server.mjs. Pure: nothing here calls fetch, so the routes stay
// one-fetch-per-branch and every decision below is unit-testable.
//
// ElevenLabs differs from the OpenAI-shaped providers in every detail that
// matters: the key goes in an `xi-api-key` header rather than a bearer token,
// the voice is a path segment rather than a body field, `language_code` is only
// accepted by the v2.5 models, /v1/models is a bare array that omits Scribe,
// and errors arrive as { detail: { status, message } }.

export const ELEVENLABS_BASE_URL = 'https://api.elevenlabs.io/v1';
export const DEFAULT_TTS_MODEL = 'eleven_flash_v2_5'; // ~75 ms, 32 languages
export const DEFAULT_STT_MODEL = 'scribe_v2';
// Rachel, the premade voice every account historically had. Only used when
// the account's own voice list could not be fetched.
export const FALLBACK_VOICE_ID = '21m00Tcm4TlvDq8ikWAM';
// /v1/models lists synthesis models only, so the transcription suggestions are
// bundled, and it needs the models_read permission that a scoped key often
// lacks, so the synthesis models have a bundled fallback too. Deliberately
// suggestions: the fields stay free text.
export const STT_MODELS = ['scribe_v2'];
export const TTS_MODELS = ['eleven_flash_v2_5', 'eleven_v3_conversational', 'eleven_multilingual_v2', 'eleven_v3', 'eleven_flash_v2'];

// The bundled list in the shape catalogModels() produces
export function bundledTtsModels() {
  return TTS_MODELS.map((id) => ({ id, task: 'text-to-speech', language: [], owned_by: '' }));
}

const OUTPUT_FORMAT = 'mp3_44100_128';
const MIN_SPEED = 0.7;
const MAX_SPEED = 1.2;
// Only the v2.5 models take language_code; the others answer 400 to it.
const LANGUAGE_CODE_MODELS = /_(flash|turbo)_v2_5$/;

export function elevenHeaders(apiKey) {
  return apiKey ? { 'xi-api-key': apiKey } : {};
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function ttsRequest(cfg, text, voiceId) {
  const model = cfg.model || DEFAULT_TTS_MODEL;
  const body = {
    text,
    model_id: model,
    voice_settings: { speed: clamp(Number(cfg.speed) || 1, MIN_SPEED, MAX_SPEED) },
  };
  if (cfg.language && LANGUAGE_CODE_MODELS.test(model)) body.language_code = cfg.language;
  return {
    url: `${cfg.baseUrl}/text-to-speech/${encodeURIComponent(voiceId || FALLBACK_VOICE_ID)}?output_format=${OUTPUT_FORMAT}`,
    headers: { 'Content-Type': 'application/json', ...elevenHeaders(cfg.apiKey) },
    body: JSON.stringify(body),
  };
}

export function sttRequest(cfg, wav) {
  const form = new FormData();
  form.append('model_id', cfg.model || DEFAULT_STT_MODEL);
  // Scribe otherwise writes "(laughter)" and the like into the transcript,
  // which would go straight into the conversation as if the user said it.
  form.append('tag_audio_events', 'false');
  form.append('timestamps_granularity', 'none');
  form.append('diarize', 'false');
  if (cfg.language) form.append('language_code', cfg.language);
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
  return { url: `${cfg.baseUrl}/speech-to-text`, headers: elevenHeaders(cfg.apiKey), form };
}

// Duration of the 16-bit mono WAV the browser sends (16 kHz, 44-byte header).
// Scribe rejects anything under 100 ms, and a VAD misfire that short should
// read as silence rather than an error.
export function wavDurationMs(buffer, sampleRate = 16000) {
  const samples = Math.max(0, (buffer?.byteLength || 0) - 44) / 2;
  return (samples / sampleRate) * 1000;
}

// { voices: [...] } → the { id, name, language } shape the xAI branch emits,
// so the settings page has one code path for fetched voice lists.
export function normalizeVoices(json) {
  return (Array.isArray(json?.voices) ? json.voices : []).map((v) => ({
    id: v.voice_id,
    name: v.name || v.voice_id,
    language: v.verified_languages?.[0]?.language || v.labels?.accent || '',
  }));
}

// A voice to use when none is configured: the first current premade voice on
// the account. Newer accounts mark the classic voices legacy, so a hard-coded
// id is only the last resort.
export function defaultVoiceId(json) {
  const voices = Array.isArray(json?.voices) ? json.voices : [];
  const premade = voices.find((v) => v.category === 'premade' && !v.is_legacy && v.voice_id);
  return premade?.voice_id || voices.find((v) => v.voice_id)?.voice_id || FALLBACK_VOICE_ID;
}

// /v1/models (a bare array) → the { id, task, language } entries
// model-catalog.mjs already understands, so the browser needs no
// ElevenLabs-specific knowledge to filter and label them.
export function catalogModels(json) {
  return (Array.isArray(json) ? json : [])
    .filter((m) => m.can_do_text_to_speech && m.model_id)
    .map((m) => ({
      id: m.model_id,
      task: 'text-to-speech',
      language: (m.languages || []).map((l) => l.language_id).filter(Boolean),
      owned_by: m.name || '',
    }));
}

// Turn an error body into the one line a caption can show.
export function describeError(bodyText, limit = 300) {
  let message = bodyText;
  try {
    const { detail } = JSON.parse(bodyText);
    if (typeof detail === 'string') message = detail;
    else if (detail?.message) message = detail.message;
    else if (Array.isArray(detail)) message = detail.map((d) => d.msg || JSON.stringify(d)).join('; ');
  } catch {
    // not JSON - keep the raw text
  }
  message = String(message ?? '').trim();
  return message.length > limit ? `${message.slice(0, limit - 1)}…` : message;
}
