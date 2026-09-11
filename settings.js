import { fetchModels, sttModels, ttsModels, voicesFor, describeVoice, describeLanguages, fillDatalist }
  from './model-catalog.mjs';
import { enhanceSelect, enhanceCombobox } from './combobox.js';

// Every dropdown-shaped control on this page draws its own menu. This runs
// before anything populates the form: enhanceSelect leaves the <select> in
// place as the source of truth, so everything below still reads the same
// elements by the same ids.
document.querySelectorAll('select').forEach(enhanceSelect);
document.querySelectorAll('input[list]').forEach(enhanceCombobox);

document.querySelectorAll('.settings-tab-button').forEach(button => {
    button.addEventListener('click', () => {
        document.querySelectorAll('.settings-tab-button, .tab-content, .settings-tab-item').forEach(el => el.classList.remove('active'));
        
        button.classList.add('active');
        button.closest('.settings-tab-item').classList.add('active');
        
        const tabId = button.getAttribute('data-tab');
        document.getElementById(tabId).classList.add('active');
    });
});

// The clipboard of the machine running the server, broadcast to every
// connected browser. clipboardAccess is the pre-rename key, still honoured.
const hostClipboardToggle = document.getElementById('hostClipboardToggle');
hostClipboardToggle.addEventListener('change', () => {
    saveSettings('hostClipboardBroadcast', hostClipboardToggle.checked);
});

document.querySelectorAll('.toggle-visibility').forEach(button => {
    button.addEventListener('click', () => {
        const input = document.getElementById(button.getAttribute('data-target'));
        const isPassword = input.type === 'password';
        input.type = isPassword ? 'text' : 'password';
        button.querySelector('img').src = isPassword ? 'icons/eye.svg' : 'icons/eye-off.svg';
    });
});

// Function to load animations
async function loadAnimations() {
    const response = await fetch('/animations');
    const animations = await response.json();
    const select = document.getElementById('idleAnimationSelect');
    select.innerHTML = '<option value="">Select an animation</option>';
    animations.forEach(animation => {
        const option = document.createElement('option');
        option.value = animation;
        option.textContent = animation;
        select.appendChild(option);
    });
}

// Function to load characters
async function loadCharacters() {
    const response = await fetch('/api/characters');
    const characters = await response.json();
    const grid = document.getElementById('characterGrid');
    grid.innerHTML = ''; // Clear existing content

    characters.forEach(character => {
        const card = document.createElement('div');
        card.className = 'character-card';
        card.dataset.name = character.name;
        card.title = `Use ${character.name}`;
        card.innerHTML = `
            <img src="${character.imagePath}" alt="${character.name}">
            <span class="character-name">${character.name}</span>
        `;
        card.addEventListener('click', () => selectCharacter(character.name));
        grid.appendChild(card);
    });

    // Add the "Add Character" card
    const addCard = document.createElement('div');
    addCard.className = 'character-card add-character';
    addCard.title = 'Add a character';
    addCard.innerHTML = '<img src="images/Add_Character_Card.png" alt="Add Character Card">';
    addCard.addEventListener('click', () => document.getElementById('characterUpload').click());
    grid.appendChild(addCard);

    markSelectedCharacter(document.getElementById('characterName').textContent);
}

function markSelectedCharacter(name) {
    document.querySelectorAll('#characterGrid .character-card').forEach(card => {
        card.classList.toggle('selected', card.dataset.name === name);
    });
}

// Function to select a character
async function selectCharacter(name) {
    try {
        const response = await fetch('/api/settings', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ characterName: name }),
        });
        
        if (!response.ok) {
            throw new Error('Failed to save character name');
        }

        document.getElementById('characterName').textContent = name;
        markSelectedCharacter(name);
        flashSaved();
    } catch (error) {
        console.error('Error selecting character:', error);
        alert('Failed to select character. Please try again.');
    }
}

// Function to load settings
async function loadSettings() {
    const response = await fetch('/api/settings');
    const settings = await response.json();
    hostClipboardToggle.checked = (settings.hostClipboardBroadcast ?? settings.clipboardAccess) === true;
    document.getElementById('publicKey').value = settings.vapiPublicKey || '';
    document.getElementById('privateKey').value = settings.vapiPrivateKey || '';
    
    // Load other settings
    document.getElementById('showTimeToggle').checked = settings.showTime;
    document.getElementById('timeFormatSelect').value = settings.timeFormat;
    document.getElementById('freeCameraToggle').checked = settings.freeCamera;
    document.getElementById('sceneDebugToggle').checked = settings.sceneDebug;
    document.getElementById('dragDropToggle').checked = settings.dragDropSupport;
    document.getElementById('vrmDebugToggle').checked = settings.vrmDebug;
    document.getElementById('animationPickerToggle').checked = settings.animationPicker;
    document.getElementById('settingsIconToggle').checked = settings.settingsIconToggle; // Add this line

    // Set the selected idle animation
    const idleAnimationSelect = document.getElementById('idleAnimationSelect');
    if (settings.idleAnimation && idleAnimationSelect.querySelector(`option[value="${settings.idleAnimation}"]`)) {
        idleAnimationSelect.value = settings.idleAnimation;
    }

    // Set the character name
    if (settings.characterName) {
        document.getElementById('characterName').textContent = settings.characterName;
    }

    // Load the assistant shortcut
    const shortcutInput = document.getElementById('assistantShortcut');
    shortcutInput.value = settings.assistantShortcut || '';

    // Lip sync sliders show their value beside them
    for (const [id, fallback] of [['mouthGain', 1.5], ['mouthCurve', 0.6]]) {
        const input = document.getElementById(id);
        input.value = Number.isFinite(Number(settings[id])) && settings[id] !== '' && settings[id] !== null ? settings[id] : fallback;
        document.getElementById(`${id}Value`).textContent = Number(input.value).toFixed(id === 'mouthGain' ? 1 : 2);
    }
}

// Function to save settings
async function saveSettings(key, value) {
    try {
        const response = await fetch('/api/settings', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ [key]: value }),
        });
        if (!response.ok) throw new Error('Settings could not be saved.');
        flashSaved();
    } catch (error) {
        console.error('Error saving settings:', error);
        flashSaved(error.message, 'error');
    }
}

// The list of assistants comes from Vapi, but the saved assistantID belongs to
// this install. Whenever the list cannot be fetched - no key yet, a bad key, no
// network - the saved value must still be shown and still be selected, or the
// page silently presents an empty selection and the setting looks lost.
function setAssistantOptions(assistants, selectedID) {
    const select = document.getElementById('assistantIDSelect');
    select.innerHTML = '';
    select.append(new Option('Select an assistant', ''));
    for (const assistant of assistants) {
        select.append(new Option(assistant.name || assistant.id, assistant.id));
    }
    if (!selectedID) return;
    // Keeps a saved assistant selected when it is not in the list: the list
    // failed to load, or the assistant was renamed or deleted on the dashboard.
    if (![...select.options].some(o => o.value === selectedID)) {
        select.append(new Option(`${selectedID} (not in your Vapi account)`, selectedID));
    }
    select.value = selectedID;
}

function setSummary(text) {
    document.querySelector('#modelName .model-text').textContent = text;
    document.querySelector('#voiceInfo .voice-text').textContent = text;
    document.getElementById('systemMessage').textContent = text;
    document.getElementById('firstMessage').textContent = text;
}

function setListStatus(message, isError = false) {
    const status = document.getElementById('assistantListStatus');
    status.textContent = message;
    status.classList.toggle('error', isError);
}

async function loadAssistants() {
    const settings = await fetch('/api/settings').then(res => res.json());
    if ((settings.assistantProvider || 'vapi') !== 'vapi') return;

    // Read the fields rather than the store, so a key typed but not yet saved
    // can still list assistants - which is the order people actually do it in -
    // and so reloading the list doesn't discard an unsaved choice of assistant.
    const vapiPrivateKey = document.getElementById('privateKey').value || settings.vapiPrivateKey || '';
    const selectedID = document.getElementById('assistantIDSelect').value || settings.assistantID;
    setAssistantOptions([], selectedID);

    if (!vapiPrivateKey) {
        setListStatus('Add your Vapi private key above to list your assistants.');
        setSummary('\u2014');
        return;
    }

    setListStatus('Loading assistants\u2026');
    let assistants;
    try {
        const response = await fetch('https://api.vapi.ai/assistant', {
            method: 'GET',
            headers: { Authorization: `Bearer ${vapiPrivateKey}` },
        });
        if (!response.ok) throw new Error(`Vapi returned ${response.status}`);
        assistants = await response.json();
        if (!Array.isArray(assistants)) throw new Error('Unexpected response from Vapi');
    } catch (err) {
        console.warn('[vapi] could not list assistants:', err.message);
        setListStatus(`Could not list assistants (${err.message}). Your saved selection is unchanged.`, true);
        setSummary('Unavailable');
        return;
    }

    setAssistantOptions(assistants, selectedID);
    setListStatus(assistants.length ? '' : 'This account has no assistants yet.');
    await updateAssistantInfo(selectedID, vapiPrivateKey);
}

async function updateAssistantInfo(assistantID, vapiPrivateKey) {
    if (!assistantID) { setSummary('\u2014'); return; }
    if (!vapiPrivateKey) { setSummary('Unavailable'); return; }

    setSummary('Loading\u2026');
    try {
        const response = await fetch(`https://api.vapi.ai/assistant/${assistantID}`, {
            method: 'GET',
            headers: { Authorization: `Bearer ${vapiPrivateKey}` },
        });
        if (!response.ok) throw new Error(`Vapi returned ${response.status}`);
        const assistant = await response.json();

        document.querySelector('#modelName .model-text').textContent = assistant.model?.model || 'Unknown';
        document.querySelector('#voiceInfo .voice-text').textContent = assistant.voice
            ? `${assistant.voice.provider} (${assistant.voice.voiceId})`
            : 'Unknown';
        document.getElementById('systemMessage').textContent =
            assistant.model?.messages?.find(m => m.role === 'system')?.content || 'No system message found';
        document.getElementById('firstMessage').textContent = assistant.firstMessage || 'No first message found';
    } catch (error) {
        console.warn('[vapi] could not fetch assistant details:', error.message);
        setSummary('Unavailable');
    }
}

// Event listener for assistant selection
document.getElementById('assistantIDSelect').addEventListener('change', async (e) => {
    const assistantID = e.target.value;
    await saveSettings('assistantID', assistantID);
    await updateAssistantInfo(assistantID, document.getElementById('privateKey').value);
});

// The key and the list it unlocks sit in the same section, so listing can
// happen as soon as a key is pasted rather than after a save and a reload.
document.getElementById('privateKey').addEventListener('change', () => { void loadAssistants(); });
document.getElementById('reloadAssistants').addEventListener('click', () => { void loadAssistants(); });

// Modify the initializePage function
async function initializePage() {
    await loadAnimations();
    await loadSettings();
    await loadCharacters();
    await loadAssistants();
}

// Call initializePage when the page loads
initializePage();

document.querySelectorAll('.save-button').forEach(button => {
    button.addEventListener('click', async () => {
        const input = button.previousElementSibling.querySelector('input');
        await saveSettings(input.id === 'publicKey' ? 'vapiPublicKey' : 'vapiPrivateKey', input.value);
        if (input.id === 'privateKey') loadAssistants();
    });
});

// Event listeners for all toggles and selects
document.getElementById('showTimeToggle').addEventListener('change', (e) => {
    saveSettings('showTime', e.target.checked);
});

document.getElementById('timeFormatSelect').addEventListener('change', (e) => {
    saveSettings('timeFormat', e.target.value);
});

document.getElementById('freeCameraToggle').addEventListener('change', (e) => {
    saveSettings('freeCamera', e.target.checked);
});

document.getElementById('sceneDebugToggle').addEventListener('change', (e) => {
    saveSettings('sceneDebug', e.target.checked);
});

document.getElementById('dragDropToggle').addEventListener('change', (e) => {
    saveSettings('dragDropSupport', e.target.checked);
});

document.getElementById('vrmDebugToggle').addEventListener('change', (e) => {
    saveSettings('vrmDebug', e.target.checked);
});

document.getElementById('animationPickerToggle').addEventListener('change', (e) => {
    saveSettings('animationPicker', e.target.checked);
});

// Event listener for idle animation select
document.getElementById('idleAnimationSelect').addEventListener('change', (e) => {
    saveSettings('idleAnimation', e.target.value);
});

// Lip sync: the readout follows the thumb; the value saves as it moves so the
// character page, which applies it live, can be watched while adjusting.
for (const id of ['mouthGain', 'mouthCurve']) {
    const input = document.getElementById(id);
    let saveTimer;
    input.addEventListener('input', () => {
        document.getElementById(`${id}Value`).textContent = Number(input.value).toFixed(id === 'mouthGain' ? 1 : 2);
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => saveSettings(id, Number(input.value)), 150);
    });
}

// Add this function to handle file uploads
async function uploadCharacterFiles(files) {
    const formData = new FormData();
    for (let i = 0; i < files.length; i++) {
        formData.append('characters', files[i]);
    }

    try {
        const response = await fetch('/api/upload-characters', {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            throw new Error('Upload failed');
        }

        await loadCharacters(); // Refresh the character display
    } catch (error) {
        console.error('Error uploading files:', error);
        alert('Failed to upload files. Please try again.');
    }
}

// Add event listener for file input changes
document.getElementById('characterUpload').addEventListener('change', (event) => {
    uploadCharacterFiles(event.target.files);
});

// Add this event listener for settingsIconToggle
document.getElementById('settingsIconToggle').addEventListener('change', (e) => {
    saveSettings('settingsIconToggle', e.target.checked);
});

// Add this new function to handle keyboard shortcut input
function handleShortcutInput(event) {
    event.preventDefault();
    const shortcutInput = document.getElementById('assistantShortcut');
    
    const key = event.key;
    const ctrl = event.ctrlKey ? 'Ctrl+' : '';
    const alt = event.altKey ? 'Alt+' : '';
    const shift = event.shiftKey ? 'Shift+' : '';
    
    if (key === 'Control' || key === 'Alt' || key === 'Shift') return;
    
    const shortcut = `${ctrl}${alt}${shift}${key}`;
    shortcutInput.value = shortcut;
    
    saveSettings('assistantShortcut', shortcut);
}

// Add event listeners after the page loads
document.addEventListener('DOMContentLoaded', () => {
    const shortcutInput = document.getElementById('assistantShortcut');
    shortcutInput.addEventListener('keydown', handleShortcutInput);
});
// ─── Assistant tab ────────────────────────────────────────────────────────────

const ASSISTANT_TEXT_FIELDS = [
    'llmBaseUrl', 'llmApiKey', 'llmModel', 'llmSystemPrompt', 'llmFirstMessage',
    'sttBaseUrl', 'sttApiKey', 'sttModel',
    'ttsBaseUrl', 'ttsApiKey', 'ttsModel', 'ttsVoice', 'ttsSpeed',
    'assistantLanguage',
    'realtimeBaseUrl', 'realtimeApiKey', 'realtimeModel', 'realtimeVoice', 'realtimeIdleSeconds', 'liveBackendModel',
    'codexInstructions', 'codexModel', 'codexWorkspace', 'codexTaskModel',
];
const ASSISTANT_SELECTS = ['assistantProvider', 'assistantMode', 'realtimeProvider', 'sttProvider', 'ttsProvider', 'codexVoice'];
const ASSISTANT_TOGGLES = ['bargeIn', 'llmStream', 'llmTools', 'llmAutoExpressions', 'realtimeAutoExpressions', 'codexAutoExpressions'];

const ASSISTANT_PRESETS = {
    xai:      { llmBaseUrl: 'https://api.x.ai/v1', llmModel: 'grok-4.6', sttProvider: 'xai', ttsProvider: 'xai', ttsVoice: 'eve', sttBaseUrl: '', ttsBaseUrl: '',
                realtimeProvider: 'xai', realtimeBaseUrl: '', realtimeModel: '', realtimeVoice: '' },
    openai:   { llmBaseUrl: 'https://api.openai.com/v1', llmModel: 'gpt-4o-mini', sttProvider: 'openai', sttModel: 'whisper-1', ttsProvider: 'openai', ttsModel: 'tts-1', ttsVoice: 'alloy', sttBaseUrl: '', ttsBaseUrl: '',
                realtimeProvider: 'openai', realtimeBaseUrl: '', realtimeModel: '', realtimeVoice: '' },
    ollama:   { llmBaseUrl: 'http://localhost:11434/v1', llmModel: 'llama3.2', sttProvider: 'browser', ttsProvider: 'kokoro', ttsVoice: 'af_heart', assistantMode: 'pipeline' },
    lmstudio: { llmBaseUrl: 'http://localhost:1234/v1', llmModel: '', sttProvider: 'browser', ttsProvider: 'kokoro', ttsVoice: 'af_heart', assistantMode: 'pipeline' },
};

// Realtime speech-to-speech defaults per provider (the server applies the same ones)
const REALTIME_DEFAULTS = {
    xai:    { model: 'grok-voice-latest', voice: 'eve', url: 'wss://api.x.ai/v1/realtime' },
    openai: { model: 'gpt-realtime-2.1', voice: 'marin', url: 'wss://api.openai.com/v1/realtime' },
    live:   { model: 'gpt-live-1', voice: 'marin', url: 'wss://api.openai.com/v1/live/sessions' },
};

const STATIC_VOICES = {
    'openai-realtime': ['marin', 'cedar', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse'],
    live: ['marin', 'cedar', 'alloy', 'ash', 'ballad', 'beacon', 'bossa', 'cinder', 'coral', 'delta', 'echo', 'gleam',
           'meridian', 'quartz', 'ripple', 'sage', 'shimmer', 'stone', 'tempo', 'verse', 'vesper', 'willow'],
    kokoro: ['af_heart', 'af_bella', 'af_nicole', 'af_sarah', 'af_sky', 'am_adam', 'am_michael', 'am_fenrir',
             'bf_emma', 'bf_isabella', 'bm_george', 'bm_lewis', 'bm_fable'],
};

async function saveSettingsBatch(values) {
    try {
        const response = await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Assistant-Request': '1' },
            body: JSON.stringify(values),
        });
        if (!response.ok) throw new Error((await response.json()).error || 'Settings could not be saved.');
        flashSaved();
    } catch (error) {
        flashSaved(error.message, 'error');
    }
}

// Shared "Saved" chip in the page header; errors stay visible longer.
let savedTimer;
function flashSaved(message = 'Saved', kind = 'ok') {
    const status = document.getElementById('assistantSaveStatus');
    status.textContent = message;
    status.dataset.kind = kind;
    status.classList.add('visible');
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => status.classList.remove('visible'), kind === 'ok' ? 1200 : 5000);
}

function setHidden(selector, hidden) {
    document.querySelectorAll(selector).forEach(el => { el.hidden = hidden; });
}

function updateAssistantUI() {
    const provider = document.getElementById('assistantProvider').value;
    document.getElementById('vapiAssistantSection').hidden = provider !== 'vapi';
    document.getElementById('customAssistantSection').hidden = provider !== 'custom';
    document.getElementById('codexAssistantSection').hidden = provider !== 'codex';
    window.dispatchEvent(new Event('assistant-provider-changed'));

    const realtime = document.getElementById('assistantMode').value === 'realtime';
    setHidden('.pipeline-only', realtime);
    setHidden('.realtime-only', !realtime);
    const realtimeProvider = document.getElementById('realtimeProvider').value;
    const defaults = REALTIME_DEFAULTS[realtimeProvider] || REALTIME_DEFAULTS.xai;
    document.getElementById('realtimeModel').placeholder = `Default: ${defaults.model}`;
    document.getElementById('realtimeVoice').placeholder = defaults.voice;
    document.getElementById('realtimeBaseUrl').placeholder = defaults.url;
    document.getElementById('realtimeApiKey').placeholder = realtimeProvider === 'xai' ? 'xai-…' : 'sk-…';
    setHidden('.live-only', realtimeProvider !== 'live');
    if (provider === 'custom' && realtime) void refreshRealtimeVoiceSuggestions();

    const stt = document.getElementById('sttProvider').value;
    setHidden('.stt-server-only', stt === 'browser');
    setHidden('.stt-openai-only', stt !== 'openai');
    setHidden('.stt-browser-only', stt !== 'browser');

    const tts = document.getElementById('ttsProvider').value;
    setHidden('.tts-server-only', tts === 'kokoro' || tts === 'browser');
    setHidden('.tts-openai-only', tts !== 'openai');
    setHidden('.tts-kokoro-only', tts !== 'kokoro');
    document.getElementById('ttsVoice').placeholder =
        { xai: 'eve', openai: 'alloy', kokoro: 'af_heart', browser: 'System default' }[tts] || '';
    if (provider === 'custom' && !realtime) void refreshVoiceSuggestions();
}

// ─── Model and voice suggestions ─────────────────────────────────────────────
// Populated from each configured endpoint's /v1/models, fetched by the server
// so the key stays there. Everything here is best-effort: if a server offers
// nothing, the list stays empty and the field behaves exactly as it did
// before, a plain text input.

let ttsCatalog = [];

function noteSuggestions(id, count, what) {
    const input = document.getElementById(id);
    const noun = count === 1 ? what.replace(/s$/, '') : what;
    input.title = count
        ? `${count} ${noun} suggested - you can still type any value`
        : `No ${what} advertised by this endpoint - type the value manually`;
    // Only advertise a list when there is one to open: this is what shows the
    // chevron. A chevron on a field with nothing to offer would open on nothing.
    input.classList.toggle('has-suggestions', count > 0);
}

async function xaiVoices() {
    try {
        const { voices = [] } = await fetch('/api/assistant/voices').then(r => r.json());
        // xAI's display name is usually just the id capitalised; only show it when it says more
        return voices.map(v => ({ value: v.id, label: [v.name.toLowerCase() !== v.id.toLowerCase() ? v.name : '', v.language].filter(Boolean).join(' · ') }));
    } catch (err) {
        console.warn('[voices] no xAI voice list:', err.message);
        return [];
    }
}

async function refreshLlmSuggestions() {
    const models = await fetchModels('llm');
    noteSuggestions('llmModel', fillDatalist(
        document.getElementById('llmModelOptions'),
        models.map(m => ({ value: m.id, label: m.owned_by || '' })),
    ), 'models');
}

async function refreshSpeechSuggestions() {
    const sttProvider = document.getElementById('sttProvider').value;
    const ttsProvider = document.getElementById('ttsProvider').value;

    // Only an endpoint has a catalogue to advertise; the in-browser providers
    // carry their own fixed voice lists.
    const stt = sttProvider === 'openai' ? await fetchModels('stt') : [];
    noteSuggestions('sttModel', fillDatalist(
        document.getElementById('sttModelOptions'),
        sttModels(stt).map(m => ({ value: m.id, label: describeLanguages(m.language) })),
    ), 'models');

    ttsCatalog = ttsProvider === 'openai' ? await fetchModels('tts') : [];
    noteSuggestions('ttsModel', fillDatalist(
        document.getElementById('ttsModelOptions'),
        ttsModels(ttsCatalog).map(m => ({ value: m.id, label: m.sample_rate ? `${m.sample_rate} Hz` : '' })),
    ), 'models');

    await refreshVoiceSuggestions();
}

// Voices depend on the selected TTS provider and model: xAI publishes a list,
// Kokoro carries a dozen, OpenAI's are documented per model, and the OS
// exposes whatever is installed. Reruns whenever the provider or model changes.
async function refreshVoiceSuggestions() {
    const list = document.getElementById('ttsVoiceOptions');
    const provider = document.getElementById('ttsProvider').value;
    let entries;
    if (provider === 'xai') {
        entries = await xaiVoices();
    } else if (provider === 'browser') {
        // getVoices() is empty until the OS list has loaded; the voiceschanged
        // event fires once it has, and re-entering here fills the list.
        entries = (window.speechSynthesis?.getVoices() || []).map(v => ({ value: v.name, label: v.lang || '' }));
    } else if (provider === 'kokoro') {
        entries = STATIC_VOICES.kokoro.map(v => ({ value: v, label: '' }));
    } else {
        const modelId = document.getElementById('ttsModel').value || 'tts-1';
        entries = voicesFor(ttsCatalog, modelId).map(v => ({ value: v.name, label: describeVoice(v) }));
    }
    noteSuggestions('ttsVoice', fillDatalist(list, entries), 'voices');
}

window.speechSynthesis?.addEventListener?.('voiceschanged', () => {
    if (document.getElementById('ttsProvider').value === 'browser') void refreshVoiceSuggestions();
});

async function refreshRealtimeVoiceSuggestions() {
    const provider = document.getElementById('realtimeProvider').value;
    const entries = provider === 'openai' ? STATIC_VOICES['openai-realtime'].map(v => ({ value: v, label: '' }))
        : provider === 'live' ? STATIC_VOICES.live.map(v => ({ value: v, label: '' }))
        : await xaiVoices();
    noteSuggestions('realtimeVoice', fillDatalist(document.getElementById('realtimeVoiceOptions'), entries), 'voices');
}

// A changed endpoint, key or model means a different catalogue
const LLM_CATALOG_FIELDS = ['llmBaseUrl', 'llmApiKey'];
const SPEECH_CATALOG_FIELDS = ['sttBaseUrl', 'sttApiKey', 'ttsBaseUrl', 'ttsApiKey', 'llmBaseUrl', 'llmApiKey'];
function refreshSuggestionsFor(id) {
    if (LLM_CATALOG_FIELDS.includes(id)) void refreshLlmSuggestions();
    if (SPEECH_CATALOG_FIELDS.includes(id)) void refreshSpeechSuggestions();
    if (id === 'ttsModel') void refreshVoiceSuggestions();
}

async function initAssistantTab() {
    const settings = await fetch('/api/settings').then(res => res.json());

    ASSISTANT_TEXT_FIELDS.forEach(id => {
        document.getElementById(id).value = settings[id] ?? '';
    });
    // Realtime used to be its own provider; it is now a mode of Custom
    const legacyRealtime = settings.assistantProvider === 'realtime';
    document.getElementById('assistantProvider').value = legacyRealtime ? 'custom' : (settings.assistantProvider || 'vapi');
    document.getElementById('assistantMode').value = legacyRealtime || settings.assistantMode === 'realtime' ? 'realtime' : 'pipeline';
    document.getElementById('realtimeProvider').value = ['openai', 'live'].includes(settings.realtimeProvider) ? settings.realtimeProvider : 'xai';
    if (legacyRealtime) saveSettingsBatch({ assistantProvider: 'custom', assistantMode: 'realtime' });
    document.getElementById('sttProvider').value = settings.sttProvider || 'xai';
    document.getElementById('ttsProvider').value = settings.ttsProvider || 'xai';
    document.getElementById('codexVoice').value = settings.codexVoice || '';
    document.getElementById('bargeIn').checked = settings.bargeIn !== false;
    document.getElementById('llmStream').checked = settings.llmStream !== false;
    document.getElementById('llmTools').checked = settings.llmTools !== false;
    document.getElementById('llmAutoExpressions').checked = settings.llmAutoExpressions === true;
    document.getElementById('realtimeAutoExpressions').checked = settings.realtimeAutoExpressions === true;
    document.getElementById('codexAutoExpressions').checked = settings.codexAutoExpressions === true;
    updateAssistantUI();

    ASSISTANT_TEXT_FIELDS.forEach(id => {
        document.getElementById(id).addEventListener('change', async (e) => {
            await saveSettingsBatch({ [id]: e.target.value });
            refreshSuggestionsFor(id);
        });
    });
    ASSISTANT_SELECTS.forEach(id => {
        document.getElementById(id).addEventListener('change', async (e) => {
            await saveSettingsBatch({ [id]: e.target.value });
            updateAssistantUI();
            if (id === 'assistantProvider' && e.target.value === 'vapi') loadAssistants();
        });
    });
    ASSISTANT_TOGGLES.forEach(id => {
        document.getElementById(id).addEventListener('change', (e) => saveSettingsBatch({ [id]: e.target.checked }));
    });

    document.querySelectorAll('.preset-button').forEach(button => {
        button.addEventListener('click', async () => {
            const preset = ASSISTANT_PRESETS[button.dataset.preset];
            Object.entries(preset).forEach(([id, value]) => {
                document.getElementById(id).value = value;
            });
            await saveSettingsBatch(preset);
            updateAssistantUI();
            void refreshLlmSuggestions();
            void refreshSpeechSuggestions();
        });
    });

    void refreshLlmSuggestions();
    void refreshSpeechSuggestions();
}

initAssistantTab();
