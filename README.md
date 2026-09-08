# three-assistant-glass

![three-assistant-glass](https://github.com/Maclean-D/three-assistant-glass/raw/main/three-assistant-glass.png)

Customizable 3D conversational AI character

## Features

### Voice Assistant - [Vapi](https://vapi.ai/)

- Custom LLM (OpenAI, Anthropic, Groq, etc.)
- Custom Voice (Cartesia, 11labs, Rime.ai etc.)
- Knowledge Base (Markdown, PDF, Word, jpeg, etc.)
- Live Transcriptions (Deepgram, Talkscriber, Gladia)
- Emotion Detection
- Interuptions
- Background Sound, Filler, & Backchanneling
- Function Calling
- Audio Recording

### Voice Assistant - Custom (xAI, OpenAI-compatible or fully local)

- Bring your own key: [xAI](https://console.x.ai/) (Grok + xAI speech), [OpenAI](https://platform.openai.com/), or any OpenAI-compatible server
- Or run everything on your machine: [Ollama](https://ollama.com/) / [LM Studio](https://lmstudio.ai/) for the model, Kokoro in the browser for the voice
- Streams speech sentence-by-sentence so the character starts talking while the model is still writing
- Interruptions (barge-in) with on-device voice activity detection
- Works on Windows, macOS and Linux — no native dependencies

### Character - [three-vrm](https://github.com/pixiv/three-vrm)

- Custom 3D model ([vrm](https://hub.vroid.com/en))
- Custom animations (fbx)
- Animated to voice assistant's voice

### Holographic Display - [Looking Glass](https://lookingglassfactory.com/webxr)

- View in 3d on any Looking Glass display

### Experimental

- Plaintext clipboard access

### Possible future features

- Show current time
- Add setting to change size/scale of character
- Add setting to move character backwards or forwards

## Prerequisites

- Desktop operating system (Windows, MacOS, Linux)
- [Node.js](https://nodejs.org/en)
- [npm](https://www.npmjs.com/get-npm) (usually comes with Node.js)

## How to Run

1. Open a terminal and clone this repository
   ```
   git clone https://github.com/Maclean-D/three-assistant-glass.git
   ```

2. Navigate to the project directory.
   ```
   cd three-assistant-glass
   ```

3. Install the required dependencies:
   ```
   npm install
   ```

4. Start the server:
   ```
   node server.mjs
   ```
5. http://localhost:3000/ should open automatically

6. Open Settings and save your [Vapi keys](https://dashboard.vapi.ai/org/api-keys)

7. Pick a character model and voice assistant ([Create an assistant on Vapi](https://dashboard.vapi.ai/assistants) first if you haven't already)

8. Go back to http://localhost:3000 and press **Start** to begin the assistant

## Use a Custom Assistant (xAI, OpenAI or local)

Instead of Vapi you can wire the character to your own model and voices. Everything goes through the local server, so API keys never reach the browser and local servers need no CORS setup.

1. Open Settings → **Assistant** and switch *Voice Assistant* to **Custom**
2. Pick a quick-setup preset, or fill in the fields:
   - **xAI** — paste your key from [console.x.ai](https://console.x.ai/team/default/api-keys). Grok for chat, xAI speech-to-text and text-to-speech (voices `eve`, `ara`, `rex`, …). One key does everything.
   - **OpenAI** — any OpenAI-compatible endpoint: OpenAI itself, Groq, or a local server such as [speaches](https://github.com/speaches-ai/speaches) for Whisper + Kokoro
   - **Ollama / LM Studio** — local model, with the browser doing speech-to-text (Chrome) and Kokoro doing text-to-speech in the browser. No keys, no cloud.
3. Speech-to-text and text-to-speech default to the language model's URL and key; override them to mix providers (e.g. Ollama for chat, xAI for voice)
4. Press **Start** and allow microphone access. Toggle *barge-in* off if the character keeps interrupting itself on a loud speaker setup.

| Provider | Speech-to-text | Text-to-speech | Notes |
|---|---|---|---|
| xAI | `POST /v1/stt` | `POST /v1/tts` | Cheapest hosted option; one key |
| OpenAI-compatible | `/v1/audio/transcriptions` | `/v1/audio/speech` | OpenAI, Groq, speaches, Kokoro-FastAPI, LocalAI… |
| Browser | Chrome Web Speech | OS voices | Zero setup; Chrome sends audio to Google |
| Kokoro | — | In-browser Kokoro-82M | Free and offline after a one-time ~90–330 MB download |

Coming next: xAI's realtime speech-to-speech (`grok-voice`) as a third provider alongside Vapi and Custom.

## ChatGPT voice through Codex (experimental)

This provider adds ChatGPT sign-in and a direct WebRTC voice session to the character.
It uses a local `codex app-server` process for authentication and voice setup. The
integration was checked against Codex CLI **0.153.4** and the `openai/codex` source
at `555b82afa9`. Voice access remains experimental and must be verified with your account.

1. Install a recent [Codex CLI](https://learn.chatgpt.com/docs/cli) and check that
   `codex --version` works in the terminal where you start this app.
2. Restart the app with `npm start`. Open it through `http://localhost:3000`.
3. In **Settings → Assistant**, select **ChatGPT via Codex (experimental)**.
4. Click **Sign in with ChatGPT** and complete the browser sign-in. If the popup is
   blocked, use **Continue sign-in**. The account status updates automatically.
5. Optionally set **Character instructions**, return to the character, press **Start**,
   and allow microphone access.

The **Voice** selector offers Cove (default), Juniper, Maple, Spruce, Ember, Vale,
Breeze, Arbor, and Sol. **Realtime model override** is optional; leave it blank for
the Codex default (`gpt-live-1-codex` with protocol v3 in CLI 0.153.4). Overrides
must name a compatible realtime model available to your account. Model and voice
changes apply to the next session, after stopping and pressing **Start** again.

ChatGPT can delegate work to the backing Codex agent while voice stays connected.
In Settings, optionally set **Task workspace** to an existing absolute folder path
and **Task model override** to a Codex-compatible task model. The default workspace
is `~/.three-assistant-glass/codex/voice-workspace` (under the configured Codex home);
the default task model is selected by Codex, separately from the realtime model.
Tasks use the local execution environment, workspace-write sandbox, and `untrusted`
command approval policy. This initial handler supports local file/command work and
web search; connected apps and further subagent spawning remain disabled.

The **ChatGPT tasks** panel shows recent agent output, proposed commands and file
changes requiring approval, additional permission requests, and clarification
questions. Approval buttons apply only to the displayed request; additional
permission grants last for the current task. **Cancel task** interrupts the agent
while leaving voice connected. **Stop**, page exit, and sign-out stop voice and
interrupt running work; cancellation does not undo changes already made. Task
history is ephemeral. A normal Stop clears the panel; after a connection failure,
the output and error remain visible until dismissed or a new session starts.
Lost voice calls reconnect up to twice on the same Codex thread, preserving task
progress and pending approvals. Task completion itself does not end voice.

Codex keeps this app's login in `~/.three-assistant-glass/codex`, outside the served
project and separate from your normal Codex profile. ChatGPT tokens are never
stored in `settings.json` or returned to the browser. **Sign out** affects only this
app's profile and ends any active voice session.

The Node server talks to Codex using JSON-RPC over stdio. It creates an ephemeral
thread with the configured task workspace and negotiates `thread/realtime/start`
using WebRTC and protocol `v3`. The browser sends microphone audio directly over
WebRTC, plays the remote audio, and measures it for mouth animation. Transcript
events arrive through a local server-sent event stream and update the speech bubble.
Clipboard context, when enabled, is sent through `thread/realtime/appendText`.
This provider does not use the Custom provider's STT/TTS settings or its barge-in
toggle; voice turn-taking is handled by the realtime service.

Task handling is isolated in `server/codex-tasks.mjs` and
`assistant/codex-tasks.js`. Native realtime delegation starts or steers the backing
Codex turn. The return path uses `clientManagedHandoffs` and
`server/codex-voice-output.mjs` to send complete, cleaned progress and result messages
through `thread/realtime/appendSpeech`. Raw search deltas, citation tokens, and approval
JSON are not mirrored into voice. Reconnects restore bounded, cleaned conversation
context instead of replaying the raw task history. The browser handles
only task display and explicit responses; it does not execute model-supplied code.

Stopping, leaving the page, signing out, or losing the control connection releases
the browser microphone and closes the Codex voice session. Only one character
voice session can be active at a time. The Codex HTTP routes accept local,
same-origin requests only; opening this feature through a LAN address is unsupported.

Local configuration (set these before `npm start`):

| Variable | Purpose |
|---|---|
| `THREE_ASSISTANT_CODEX_BIN` | Codex executable path, if it is not available as `codex` on `PATH`. A locally built executable from the cloned repository also works if its protocol is compatible. |
| `THREE_ASSISTANT_CODEX_HOME` | Override the dedicated Codex profile directory. Keep this outside the served project. |
| `THREE_ASSISTANT_PORT` | App port, default `3000`. |
| `THREE_ASSISTANT_NO_OPEN=1` | Suppress opening a browser when the server starts. |

Run `npm test` for protocol, task/approval handling, route, browser lifecycle, and Settings regression tests.
The tests substitute the upstream voice service; they do not establish live voice
entitlement. An account/voice error is displayed in the app, with no automatic
switch to an API-key provider. References: [Codex authentication](https://learn.chatgpt.com/docs/auth),
[app-server](https://learn.chatgpt.com/docs/app-server), and the cloned repository's
`codex-rs/app-server/README.md` for the experimental realtime methods.

## View on a Looking Glass Display

1. Install [Looking Glass Bridge](https://lookingglassfactory.com/software/looking-glass-bridge)

2. Plug in your Looking Glass Display

3. (Recommended) Turn off `Show Settings Icon` in Settings

4. Click `Enter Looking Glass`

5. Double click the window on the Looking Glass Display or press `f11` to enter full-screen

6. Press **Start** on your computer to begin the assistant (the keyboard shortcut is configurable in Settings)

## FAQ

### How do I add a new character model?

1. Download a .vrm file, ([VRoid Hub](https://hub.vroid.com/en) has lots of models or make your own in [VRoid Studio](https://vroid.com/en/studio))
2. From the characters tab in settings, click the `+` button and select the .vrm or .zip file
3. Click the model to set it as the active model

### How do I change the character's card in settings?

1. Prepare a 270x480 .png file that has the same name as your vrm file
2. From the characters tab in settings, click the `+` button and select the .png file

### Can I bundle character models and cards?

1. Zip the character's .vrm & .png files together (make sure they have the same name)
2. From the characters tab in settings, click the `+` button and select the .zip file

### How do I change a character's name?

1. Open the `characters` folder
2. Rename the .vrm & .png files (make sure they have the same name)

### How do I delete characters?

1. Open the `characters` folder
2. Delete the desired .vrm & .png files

### How do I add custom animations?

1. Open the `animations` folder
2. Drag and drop your .fbx files into the folder

### I turned off the Settings Icon, how do I get it back?

1. Go back to http://localhost:3000/settings
2. Turn on `Show Settings Icon`

## Troubleshooting

- For 2d displays [Arc](https://arc.net/gift/friend-of-maclean) browser is recommended
- For Looking Glass Displays [Chrome](https://www.google.com/chrome/) is recommended

## Star History

<a href="https://www.star-history.com/?repos=Maclean-D%2Fthree-assistant-glass&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=Maclean-D/three-assistant-glass&type=date&theme=dark&legend=top-left&sealed_token=ZdRVvXf5rpSemWCkQJWj7KNRMNyB5nifpNNMnImrGWyHtS_9H8unaq2YuuPmV5FL-sAFfYnh4ekfizb5AFCBNoOHH-6eAK8W11scAY3va4TUI5uue3aYReauGSRpAbNkuTYFBgBwIoandxqKJ2ukmE1tupA6e3NkWwZmoUeQqqhTs8qAUT0JCp4D_1tu" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=Maclean-D/three-assistant-glass&type=date&legend=top-left&sealed_token=ZdRVvXf5rpSemWCkQJWj7KNRMNyB5nifpNNMnImrGWyHtS_9H8unaq2YuuPmV5FL-sAFfYnh4ekfizb5AFCBNoOHH-6eAK8W11scAY3va4TUI5uue3aYReauGSRpAbNkuTYFBgBwIoandxqKJ2ukmE1tupA6e3NkWwZmoUeQqqhTs8qAUT0JCp4D_1tu" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=Maclean-D/three-assistant-glass&type=date&legend=top-left&sealed_token=ZdRVvXf5rpSemWCkQJWj7KNRMNyB5nifpNNMnImrGWyHtS_9H8unaq2YuuPmV5FL-sAFfYnh4ekfizb5AFCBNoOHH-6eAK8W11scAY3va4TUI5uue3aYReauGSRpAbNkuTYFBgBwIoandxqKJ2ukmE1tupA6e3NkWwZmoUeQqqhTs8qAUT0JCp4D_1tu" />
 </picture>
</a>

## Contributors

<a href="https://github.com/Maclean-D/three-assistant-glass/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=Maclean-D/three-assistant-glass" />
</a>
