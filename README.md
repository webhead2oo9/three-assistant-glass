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

8. Go back to http://localhost:3000/settings and click ▶️ to start the assistant

## Use a Custom Assistant (xAI, OpenAI or local)

Instead of Vapi you can wire the character to your own model and voices. Everything goes through the local server, so API keys never reach the browser and local servers need no CORS setup.

1. Open Settings → **Assistant** and switch *Voice Assistant* to **Custom**
2. Pick a quick-setup preset, or fill in the fields:
   - **xAI** — paste your key from [console.x.ai](https://console.x.ai/team/default/api-keys). Grok for chat, xAI speech-to-text and text-to-speech (voices `eve`, `ara`, `rex`, …). One key does everything.
   - **OpenAI** — any OpenAI-compatible endpoint: OpenAI itself, Groq, or a local server such as [speaches](https://github.com/speaches-ai/speaches) for Whisper + Kokoro
   - **Ollama / LM Studio** — local model, with the browser doing speech-to-text (Chrome) and Kokoro doing text-to-speech in the browser. No keys, no cloud.
3. Speech-to-text and text-to-speech default to the language model's URL and key; override them to mix providers (e.g. Ollama for chat, xAI for voice)
4. Press ▶️ and allow microphone access. Toggle *barge-in* off if the character keeps interrupting itself on a loud speaker setup.

| Provider | Speech-to-text | Text-to-speech | Notes |
|---|---|---|---|
| xAI | `POST /v1/stt` | `POST /v1/tts` | Cheapest hosted option; one key |
| OpenAI-compatible | `/v1/audio/transcriptions` | `/v1/audio/speech` | OpenAI, Groq, speaches, Kokoro-FastAPI, LocalAI… |
| Browser | Chrome Web Speech | OS voices | Zero setup; Chrome sends audio to Google |
| Kokoro | — | In-browser Kokoro-82M | Free and offline after a one-time ~90–330 MB download |

Coming next: xAI's realtime speech-to-speech (`grok-voice`) as a third provider alongside Vapi and Custom.

## View on a Looking Glass Display

1. Install [Looking Glass Bridge](https://lookingglassfactory.com/software/looking-glass-bridge)

2. Plug in your Looking Glass Display

3. (Recommended) Turn off `Show Settings Icon` in Settings

4. Click `Enter Looking Glass`

5. Double click the window on the Looking Glass Display or press `f11` to enter full-screen

6. Press the `▶️` button on your looking glass display or computer to start the assistant (Configurable in Settings)

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
