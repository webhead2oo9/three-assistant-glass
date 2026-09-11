// Model and voice discovery for the settings page.
//
// GET /v1/models is the only standard discovery endpoint, and it standardises
// very little: OpenAI returns {id, object, created, owned_by} and nothing that
// says whether a model does speech-to-text or text-to-speech. Speaches adds
// `task`, `voices` and `sample_rate`, which is enough to drive real dropdowns.
//
// The server fetches the list (/api/assistant/models) so the key never leaves
// it and local servers need no CORS. Everything here is best-effort and
// degrades: use the richer fields when the server provides them, fall back to
// a documented list for known OpenAI models, and otherwise return nothing so
// the field stays free text. Suggestions are never a constraint - a valid model
// or voice that isn't listed must still be typeable, since any bundled list
// goes stale the moment a provider adds one.

const STT_TASK = 'automatic-speech-recognition';
const TTS_TASK = 'text-to-speech';

// OpenAI publishes no endpoint for these, so they are transcribed from the docs
// and used only when the server offers nothing better. Deliberately suggestions.
const OPENAI_VOICES = {
  'gpt-4o-mini-tts': ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova',
                      'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar'],
  'tts-1':    ['alloy', 'ash', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer'],
  'tts-1-hd': ['alloy', 'ash', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer'],
};

// Fetch the model list for one leg of the assistant: 'llm', 'stt' or 'tts'.
// Returns [] on any failure so callers just get no suggestions, never an error.
export async function fetchModels(kind) {
  try {
    const res = await fetch(`/api/assistant/models?for=${encodeURIComponent(kind)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return Array.isArray(json.models) ? json.models : [];
  } catch (e) {
    console.warn(`[models] no ${kind} suggestions:`, e.message);
    return [];
  }
}

// Models for one task. A server that reports `task` is filtered properly; one
// that doesn't (OpenAI, xAI, and anything minimal) returns everything, since a
// full list is more useful than a wrong guess about which models transcribe.
function forTask(models, task) {
  const tagged = models.filter((m) => m.task);
  if (tagged.length === 0) return models;
  return tagged.filter((m) => m.task === task);
}

export const sttModels = (models) => forTask(models, STT_TASK);
export const ttsModels = (models) => forTask(models, TTS_TASK);

// Voices for a TTS model, as {name, language, gender} where known.
// Prefers what the server reports, then the documented OpenAI lists, else none.
export function voicesFor(models, modelId) {
  const model = models.find((m) => m.id === modelId);
  const reported = model?.voices;

  if (Array.isArray(reported) && reported.length) {
    return reported.map((v) => (typeof v === 'string' ? { name: v } : v))
                   .filter((v) => v && v.name);
  }

  const documented = OPENAI_VOICES[modelId];
  if (documented) return documented.map((name) => ({ name }));

  return [];
}

// Whisper models report every language they handle - 99 of them for the
// multilingual builds - which is not a dropdown label. Collapse to a count.
export function describeLanguages(language) {
  if (!language) return '';
  const list = Array.isArray(language) ? language : [language];
  if (list.length === 0) return '';
  if (list.length === 1) return String(list[0]);
  return `${list.length} languages`;
}

// "female · en-us" - context for picking a voice out of a list of 54.
export function describeVoice(voice) {
  return [voice.gender, voice.language].filter(Boolean).join(' · ');
}

// Fill a <datalist> with suggestions. Options carry a label but the bound input
// stays free text, so an unlisted model or voice is still reachable.
export function fillDatalist(datalist, entries) {
  if (!datalist) return 0;
  datalist.replaceChildren();
  for (const { value, label } of entries) {
    const option = document.createElement('option');
    option.value = value;
    if (label) option.textContent = label;
    datalist.appendChild(option);
  }
  return entries.length;
}
