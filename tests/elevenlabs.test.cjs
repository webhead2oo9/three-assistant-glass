const { test } = require('node:test');
const assert = require('node:assert/strict');

const cfg = { baseUrl: 'https://api.elevenlabs.io/v1', apiKey: 'sk_test', model: '', speed: 1, language: '' };

test('tts request puts the voice id in the path and defaults to the fast model', async () => {
  const { ttsRequest, DEFAULT_TTS_MODEL, FALLBACK_VOICE_ID } = await import('../server/elevenlabs.mjs');
  const req = ttsRequest(cfg, 'Hello there', 'abc/def');
  assert.equal(req.url, 'https://api.elevenlabs.io/v1/text-to-speech/abc%2Fdef?output_format=mp3_44100_128');
  assert.equal(req.headers['xi-api-key'], 'sk_test');
  assert.equal(req.headers.Authorization, undefined);
  const body = JSON.parse(req.body);
  assert.equal(body.text, 'Hello there');
  assert.equal(body.model_id, DEFAULT_TTS_MODEL);
  assert.equal(body.voice_settings.speed, 1);
  assert.equal('language_code' in body, false);
  assert.ok(ttsRequest(cfg, 'x', '').url.includes(FALLBACK_VOICE_ID));
});

test('tts speed is clamped to what ElevenLabs accepts', async () => {
  const { ttsRequest } = await import('../server/elevenlabs.mjs');
  const speed = (s) => JSON.parse(ttsRequest({ ...cfg, speed: s }, 'x', 'v').body).voice_settings.speed;
  assert.equal(speed(1.5), 1.2);
  assert.equal(speed(0.25), 0.7);
  assert.equal(speed('1.1'), 1.1);
  assert.equal(speed(undefined), 1);
});

test('language_code is only sent to the models that accept it', async () => {
  const { ttsRequest } = await import('../server/elevenlabs.mjs');
  const body = (model) => JSON.parse(ttsRequest({ ...cfg, model, language: 'fr' }, 'x', 'v').body);
  assert.equal(body('eleven_flash_v2_5').language_code, 'fr');
  assert.equal(body('eleven_turbo_v2_5').language_code, 'fr');
  assert.equal('language_code' in body('eleven_multilingual_v2'), false);
  assert.equal('language_code' in body('eleven_v3'), false);
});

test('stt request is a Scribe multipart form with audio events off and the file last', async () => {
  const { sttRequest, DEFAULT_STT_MODEL } = await import('../server/elevenlabs.mjs');
  const wav = new Uint8Array(44 + 3200);
  const req = sttRequest({ ...cfg, language: 'en' }, wav);
  assert.equal(req.url, 'https://api.elevenlabs.io/v1/speech-to-text');
  assert.equal(req.headers['xi-api-key'], 'sk_test');
  const keys = [...req.form.keys()];
  assert.equal(keys[0], 'model_id');
  assert.equal(keys.at(-1), 'file');
  assert.equal(req.form.get('model_id'), DEFAULT_STT_MODEL);
  assert.equal(req.form.get('tag_audio_events'), 'false');
  assert.equal(req.form.get('timestamps_granularity'), 'none');
  assert.equal(req.form.get('language_code'), 'en');
  assert.equal(req.form.get('file').type, 'audio/wav');
  assert.equal(sttRequest(cfg, wav).form.has('language_code'), false);
});

test('wav duration is derived from the 16 kHz mono payload', async () => {
  const { wavDurationMs } = await import('../server/elevenlabs.mjs');
  assert.equal(wavDurationMs(new Uint8Array(44 + 1600 * 2)), 100);
  assert.equal(wavDurationMs(new Uint8Array(44 + 800 * 2)), 50);
  assert.equal(wavDurationMs(new Uint8Array(10)), 0);
  assert.equal(wavDurationMs(undefined), 0);
});

test('voices are normalised to the shape the settings page already reads', async () => {
  const { normalizeVoices, defaultVoiceId, FALLBACK_VOICE_ID } = await import('../server/elevenlabs.mjs');
  const json = { voices: [
    { voice_id: 'old', name: 'Rachel', category: 'premade', is_legacy: true, labels: { accent: 'american' } },
    { voice_id: 'mine', name: 'Me', category: 'cloned', verified_languages: [{ language: 'en' }] },
    { voice_id: 'new', name: 'Alice', category: 'premade', verified_languages: [{ language: 'en' }, { language: 'de' }] },
  ] };
  assert.deepEqual(normalizeVoices(json), [
    { id: 'old', name: 'Rachel', language: 'american' },
    { id: 'mine', name: 'Me', language: 'en' },
    { id: 'new', name: 'Alice', language: 'en' },
  ]);
  assert.deepEqual(normalizeVoices({}), []);
  assert.equal(defaultVoiceId(json), 'new');
  assert.equal(defaultVoiceId({ voices: [{ voice_id: 'only', category: 'cloned' }] }), 'only');
  assert.equal(defaultVoiceId({}), FALLBACK_VOICE_ID);
});

test('model catalogue keeps synthesis models and tags them for the browser filter', async () => {
  const { catalogModels } = await import('../server/elevenlabs.mjs');
  const models = catalogModels([
    { model_id: 'eleven_flash_v2_5', name: 'Eleven Flash v2.5', can_do_text_to_speech: true, languages: [{ language_id: 'en' }, { language_id: 'fr' }] },
    { model_id: 'eleven_multilingual_sts_v2', name: 'STS', can_do_text_to_speech: false },
  ]);
  assert.deepEqual(models, [
    { id: 'eleven_flash_v2_5', task: 'text-to-speech', language: ['en', 'fr'], owned_by: 'Eleven Flash v2.5' },
  ]);
  assert.deepEqual(catalogModels({ data: [] }), []);
});

test('the bundled synthesis list covers a key without models_read and leads with the default', async () => {
  const { bundledTtsModels, DEFAULT_TTS_MODEL } = await import('../server/elevenlabs.mjs');
  const models = bundledTtsModels();
  assert.equal(models[0].id, DEFAULT_TTS_MODEL);
  assert.ok(models.every((m) => m.task === 'text-to-speech'));
});

test('errors collapse to the message a caption can show', async () => {
  const { describeError } = await import('../server/elevenlabs.mjs');
  assert.equal(describeError(JSON.stringify({ detail: { status: 'voice_not_found', message: 'No voice with id x' } })), 'No voice with id x');
  assert.equal(describeError(JSON.stringify({ detail: 'Unauthorized' })), 'Unauthorized');
  assert.equal(describeError(JSON.stringify({ detail: [{ loc: ['body', 'text'], msg: 'field required' }] })), 'field required');
  assert.equal(describeError('<html>gateway</html>'), '<html>gateway</html>');
  assert.equal(describeError('x'.repeat(400)).length, 300);
});
