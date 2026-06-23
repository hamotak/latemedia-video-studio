# Late Media Video Studio — guide for Claude

This is a **standalone, local, single-user** Next.js app for generating videos from a script. There is **no login, no auth, and no cloud database** — it runs as one built-in admin and stores everything in a local SQLite database under `./data/`.

## Run it

- Install deps (first time): `npm install`
- Start: `npm run dev` → serves on **http://localhost:2000** (the port is fixed in `package.json`).
- Production: `npm run build && npm start` (also port 2000).
- **Node 20+** required. FFmpeg is bundled via `ffmpeg-static` / `ffprobe-static` — never tell the user to install FFmpeg.

## First-run setup

1. Open http://localhost:2000 — it lands on the **Video** studio.
2. Go to **Settings** (sidebar) and have the user paste their API keys:
   - `LABS69_API_KEY` (69labs) and `GOOGLE_API_KEY` (Gemini) are **required**.
   - `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` are optional fallbacks.
   - Keys are stored locally in `./data/hum.db` — never commit them.
3. Create a **Channel** (just a name), then open **Video**, paste a script, and Generate.

## Architecture (for debugging)

- Next.js 16 App Router. The UI calls its own `/api/...` route handlers.
- Local SQLite (`better-sqlite3`) under `./data/` holds channels, settings, prompts, and render runs. **No Supabase.**
- Video pipeline lives in `src/lib/video-engine/` (scene split → image → motion → TTS → FFmpeg assembly).
- Auth is stubbed to a single admin in `src/lib/supabase/local-stub.ts`; the channel store is local SQLite in `src/lib/channels-store.ts`.

## Do not

- Do not add login/auth, multi-user, or a cloud database — this app is intentionally single-user and local.
- Do not commit `./data/` or any API keys (both are already gitignored).
