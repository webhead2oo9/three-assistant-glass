document.querySelectorAll('.settings-tab-button').forEach(button => {
    button.addEventListener('click', () => {
        document.querySelectorAll('.settings-tab-button, .tab-content, .settings-tab-item').forEach(el => el.classList.remove('active'));
        
        button.classList.add('active');
        button.closest('.settings-tab-item').classList.add('active');
        
        const tabId = button.getAttribute('data-tab');
        document.getElementById(tabId).classList.add('active');
    });
});

const clipboardAccessToggle = document.getElementById('clipboardAccessToggle');

fetch('/api/settings/clipboard')
    .then(response => response.json())
    .then(data => {
        clipboardAccessToggle.checked = data.clipboardAccess;
    });

clipboardAccessToggle.addEventListener('change', () => {
    fetch('/api/settings/clipboard', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ clipboardAccess: clipboardAccessToggle.checked }),
    });
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
    addCard.innerHTML = '<img src="images/Add_Character_Card.png" alt="Add Character Card">';
    addCard.addEventListener('click', () => document.getElementById('characterUpload').click());
    grid.appendChild(addCard);
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
    } catch (error) {
        console.error('Error selecting character:', error);
        alert('Failed to select character. Please try again.');
    }
}

// Function to load settings
async function loadSettings() {
    const response = await fetch('/api/settings');
    const settings = await response.json();
    clipboardAccessToggle.checked = settings.clipboardAccess;
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
}

// Function to save settings
async function saveSettings(key, value) {
    await fetch('/api/settings', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ [key]: value }),
    });
}

// Function to load assistants from Vapi
async function loadAssistants() {
    try {
        const settings = await fetch('/api/settings').then(res => res.json());
        const vapiPrivateKey = settings.vapiPrivateKey;
        
        if (!vapiPrivateKey) {
            console.error('Vapi private key not found in settings');
            return;
        }

        const options = {
            method: 'GET',
            headers: { Authorization: `Bearer ${vapiPrivateKey}` }
        };

        const response = await fetch('https://api.vapi.ai/assistant', options);
        const assistants = await response.json();

        const select = document.getElementById('assistantIDSelect');
        select.innerHTML = '<option value="">Select an assistant</option>';
        assistants.forEach(assistant => {
            const option = document.createElement('option');
            option.value = assistant.id;
            option.textContent = assistant.name;
            select.appendChild(option);
        });

        // Load the selected assistant from settings
        if (settings.assistantID) {
            select.value = settings.assistantID;
            await updateAssistantInfo(settings.assistantID, vapiPrivateKey);
        }
    } catch (err) {
        console.error('Error loading assistants:', err);
    }
}

// Function to update assistant information
async function updateAssistantInfo(assistantID, vapiPrivateKey) {
    if (!assistantID) return;

    const options = {
        method: 'GET',
        headers: { Authorization: `Bearer ${vapiPrivateKey}` }
    };

    try {
        const response = await fetch(`https://api.vapi.ai/assistant/${assistantID}`, options);
        const assistant = await response.json();

        document.querySelector('#modelName .model-text').textContent = assistant.model.model;
        document.querySelector('#voiceInfo .voice-text').textContent = `${assistant.voice.provider} (${assistant.voice.voiceId})`;
        document.getElementById('systemMessage').textContent = assistant.model.messages.find(m => m.role === 'system')?.content || 'No system message found';
        document.getElementById('firstMessage').textContent = assistant.firstMessage || 'No first message found';
    } catch (error) {
        console.error('Error fetching assistant details:', error);
    }
}

// Event listener for assistant selection
document.getElementById('assistantIDSelect').addEventListener('change', async (e) => {
    const assistantID = e.target.value;
    await saveSettings('assistantID', assistantID);

    const settings = await fetch('/api/settings').then(res => res.json());
    await updateAssistantInfo(assistantID, settings.vapiPrivateKey);
});

// Modify the initializePage function
async function initializePage() {
    await loadAnimations();
    await loadSettings();
    await loadCharacters();
    await loadAssistants();
}

// Call initializePage when the page loads
initializePage();

clipboardAccessToggle.addEventListener('change', () => {
    saveSettings('clipboardAccess', clipboardAccessToggle.checked);
});

document.querySelectorAll('.save-button').forEach(button => {
    button.addEventListener('click', () => {
        const input = button.previousElementSibling.querySelector('input');
        saveSettings(input.id === 'publicKey' ? 'vapiPublicKey' : 'vapiPrivateKey', input.value);
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
    'codexInstructions', 'codexModel', 'codexWorkspace', 'codexTaskModel',
];
const ASSISTANT_SELECTS = ['assistantProvider', 'sttProvider', 'ttsProvider', 'codexVoice'];
const ASSISTANT_TOGGLES = ['bargeIn', 'codexAutoExpressions'];

const ASSISTANT_PRESETS = {
    xai:      { llmBaseUrl: 'https://api.x.ai/v1', llmModel: 'grok-4.6', sttProvider: 'xai', ttsProvider: 'xai', ttsVoice: 'eve', sttBaseUrl: '', ttsBaseUrl: '' },
    openai:   { llmBaseUrl: 'https://api.openai.com/v1', llmModel: 'gpt-4o-mini', sttProvider: 'openai', sttModel: 'whisper-1', ttsProvider: 'openai', ttsModel: 'tts-1', ttsVoice: 'alloy', sttBaseUrl: '', ttsBaseUrl: '' },
    ollama:   { llmBaseUrl: 'http://localhost:11434/v1', llmModel: 'llama3.2', sttProvider: 'browser', ttsProvider: 'kokoro', ttsVoice: 'af_heart' },
    lmstudio: { llmBaseUrl: 'http://localhost:1234/v1', llmModel: '', sttProvider: 'browser', ttsProvider: 'kokoro', ttsVoice: 'af_heart' },
};

const STATIC_VOICES = {
    openai: ['alloy', 'ash', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'],
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
        clearTimeout(savedTimer);
        document.getElementById('assistantSaveStatus').textContent = error.message;
    }
}

let savedTimer;
function flashSaved() {
    const status = document.getElementById('assistantSaveStatus');
    status.classList.add('visible');
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => status.classList.remove('visible'), 1200);
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
    if (provider === 'custom') loadVoiceOptions(tts);
}

async function loadVoiceOptions(provider) {
    const datalist = document.getElementById('ttsVoiceOptions');
    let voices = STATIC_VOICES[provider] || [];
    if (provider === 'browser') {
        voices = speechSynthesis.getVoices().map(v => v.name);
        if (!voices.length) {
            speechSynthesis.addEventListener('voiceschanged', () => loadVoiceOptions('browser'), { once: true });
        }
    } else if (provider === 'xai') {
        try {
            const { voices: list = [] } = await fetch('/api/assistant/voices').then(r => r.json());
            voices = list.map(v => v.id);
        } catch (err) {
            console.error('Error loading voices:', err);
        }
    }
    datalist.innerHTML = voices.map(v => `<option value="${v}"></option>`).join('');
}

async function initAssistantTab() {
    const settings = await fetch('/api/settings').then(res => res.json());

    ASSISTANT_TEXT_FIELDS.forEach(id => {
        document.getElementById(id).value = settings[id] ?? '';
    });
    document.getElementById('assistantProvider').value = settings.assistantProvider || 'vapi';
    document.getElementById('sttProvider').value = settings.sttProvider || 'xai';
    document.getElementById('ttsProvider').value = settings.ttsProvider || 'xai';
    document.getElementById('codexVoice').value = settings.codexVoice || '';
    document.getElementById('bargeIn').checked = settings.bargeIn !== false;
    document.getElementById('codexAutoExpressions').checked = settings.codexAutoExpressions === true;
    updateAssistantUI();

    ASSISTANT_TEXT_FIELDS.forEach(id => {
        document.getElementById(id).addEventListener('change', (e) => saveSettingsBatch({ [id]: e.target.value }));
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
        });
    });
}

initAssistantTab();
