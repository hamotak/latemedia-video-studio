# Late Media Video Studio

Turn a script into a finished, narrated video — **locally on your own PC**. No login, no accounts, no cloud database. You bring your own API keys, and everything runs and saves on your machine.

## What it does

- **Channels** — create a channel that holds a voice + visual style.
- **Video** — paste a script/title and generate a narrated video (scenes → images → motion → voiceover → final MP4).
- **B-Rolls** — a reusable stock-clip library.
- **Settings** — paste your API keys and tune voice, models, and render options.

## Requirements

- **Node.js 20 or newer** — https://nodejs.org (choose the **LTS** installer).
- API keys (you provide your own, billed to you):
  - **69labs** — video, voiceover (ElevenLabs), and images. *(required)*
  - **Google Gemini** (`GOOGLE_API_KEY`) — scene splitting & visual prompts. *(required)*
  - **Anthropic** / **OpenAI** — optional fallbacks.
- **FFmpeg is bundled** — you do **not** need to install it.

## Quick start (Windows)

1. Install **Node.js 20+** from https://nodejs.org (LTS).
2. Double-click **`install.bat`** — one time, installs dependencies (2–5 minutes).
3. Double-click **`start.bat`** — the app opens at **http://localhost:2000**.
4. Open **Settings** in the left sidebar and paste your **69labs** and **Google** keys. Then create a **Channel** and open **Video**.

To stop the app, close the black terminal window.

## Quick start (macOS / Linux)

```bash
npm install
npm run dev      # serves http://localhost:2000
```

## Where is my data?

Everything is stored locally in the **`data/`** folder inside this project — channels, render history, settings, and generated files. Back it up or delete it freely (deleting `data/` resets the app). Nothing is sent anywhere except to the AI providers whose keys you enter.

## Using it with Claude

You can ask Claude Code to run it for you:

> "Launch this app on localhost:2000."

Claude will run `npm install` (if needed) and `npm run dev`. See [CLAUDE.md](CLAUDE.md) for details.
