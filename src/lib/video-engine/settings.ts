import db from "./db";
import { isSecretKey } from "./secret-keys";
import { getIntegration } from "@/lib/db";
import { getCachedAppSetting, setCachedAppSetting } from "@/lib/app-setting-cache";
import { bundledFfmpeg } from "./ffmpeg-bin";

// Re-export so server code can keep importing the secret-key helper from here.
export { isSecretKey, isMaskedValue, MASK_CHAR } from "./secret-keys";

/**
 * Keys the user can edit through the UI or via .env.
 * UI takes precedence over .env (env is only the fallback when the DB row is empty).
 */
export const SETTING_KEYS = [
  // ── Required API keys ─────────────────────────────────────────────
  "GOOGLE_API_KEY",          // Gemini — scene splitting
  "LABS69_API_KEY",          // 69labs — Grok video + ElevenLabs voiceover

  // ── Optional / backup providers ───────────────────────────────────
  "ANTHROPIC_API_KEY",       // Claude (alternative to Gemini)
  "OPENAI_API_KEY",          // OpenAI TTS / image backup
  "FFMPEG_PATH",             // absolute path to ffmpeg.exe if not in system PATH

  // ── Storage ───────────────────────────────────────────────────────
  "RUNS_OUTPUT_DIR",         // where run folders are written. Empty = default

  // ── Scene splitting (LLM) ─────────────────────────────────────────
  "SCENE_SPLIT_PROVIDER",    // google | anthropic
  "SCENE_SPLIT_MODEL",       // e.g. gemini-flash-latest, claude-sonnet-4-6
  "IMAGE_CUT_VISUAL_MODEL",  // Gemini reasoning model for Image Cut visual bible/prompts

  // ── Text-to-Speech ────────────────────────────────────────────────
  "STYLE_PRESET_ID",         // style preset for the no-channel run (Prompt 9): sleep-calm | standard-neutral
  "TTS_PROVIDER",            // 69labs (default) | openai | minimax (legacy)
  "TTS_VOICE_PROVIDER",      // For 69labs: elevenlabs | voice-clone
  "TTS_VOICE_ID",            // Voice id — ElevenLabs id, or legacy MiniMax catalog/clone id
  "TTS_MODEL",               // ElevenLabs: eleven_multilingual_v2 · legacy MiniMax: speech-02-hd
  "TTS_SPLIT_TYPE",          // smart | paragraphs | max_length
  "TTS_LANGUAGE_BOOST",      // ElevenLabs/MiniMax pronunciation hint, e.g. English | auto

  // ── ElevenLabs voice fine-tuning ──────────────────────────────────
  "TTS_SPEED",               // 0.7–1.2 (lower = slower)
  "TTS_STABILITY",           // 0–1
  "TTS_SIMILARITY_BOOST",    // 0–1
  "TTS_STYLE",               // 0–1
  "TTS_USE_SPEAKER_BOOST",   // "1" / "0" / ""

  // ── Auto-pause (stops TTS from "swallowing" sentence ends) ────────
  "TTS_AUTO_PAUSE",          // "1" to enable
  "TTS_PAUSE_DURATION",      // seconds (0.1–30)
  "TTS_PAUSE_FREQUENCY",     // 1–100

  // ── Images ────────────────────────────────────────────────────────
  "IMAGE_PROVIDER",          // 69labs | openai | off (legacy only)
  "IMAGE_MODEL",             // e.g. nano-banana-pro, imagen-4, seedream-4.5
  "IMAGE_FALLBACK_MODEL",    // hidden: safer image model list after primary model failures. Default gpt-image-2,nano-banana-2.
  "IMAGE_RATIO",             // e.g. 16:9, 9:16, 1:1
  "IMAGE_RESOLUTION",        // 1k | 2k | 4k (for models that support it)

  // ── Animations (img2vid) ──────────────────────────────────────────
  "ANIMATION_PROVIDER",      // off | 69labs
  "ANIMATION_MODEL",         // e.g. veo-3.1-fast, grok-imagine-video
  "ANIMATION_RATIO_PERCENT", // 0–100, percentage of scenes to animate
  "ANIMATION_DISTRIBUTION",  // first-half | alternating | random | all
  "ANIMATION_DURATION",      // seconds (provider-dependent)
  "ANIMATION_KEEP_VEO_AUDIO", // "1" to keep Veo's generated ambient audio
  "CLEAN_PROVIDER_WATERMARK", // "1" to gently reframe generated clips so visible provider corner marks do not show
  "VIDEO_STYLE",             // global video look/mood, appended to every scene's visual_prompt (replaces the legacy animation_motion prompt)
  "GENERATION_NEGATIVE_PROMPT", // global avoid-list appended to image/video prompts
  "VISUAL_CONTINUITY_MODE",  // off | prompt | keyframe — see src/lib/continuity.ts. Default "prompt".

  // ── Video assembly (FFmpeg) ───────────────────────────────────────
  "VIDEO_RESOLUTION",        // e.g. 1920x1080
  "VIDEO_FPS",               // 24 / 30 / 60
  "SCENE_DURATION_SECONDS",  // fallback duration when TTS length is unknown
  "TRANSITION_DURATION",     // crossfade between scenes in seconds (0 = none)
  "SCENE_TAIL_SILENCE",      // deprecated: continuous-voiceover — no inter-scene gaps (kept for old runs)
  "FINAL_ATMOSPHERE_MODE",   // off | short_only | always. Default skips full-video styling on long videos.
  "FINAL_POSTPROCESS_THREADS", // optional ffmpeg thread cap for final full-video post-processing

  // ── Performance / Concurrency ─────────────────────────────────────
  "IMAGE_CONCURRENCY",       // parallel image jobs
  "TTS_CONCURRENCY",         // parallel TTS jobs
  "ANIMATION_CONCURRENCY",   // parallel img2vid jobs
  "ASSEMBLE_CONCURRENCY",    // parallel FFmpeg clip renders
  "ASSEMBLE_XFADE_CHUNKS",   // split final xfade into N parallel chunks (1 = monolithic)

  // ── Hybrid mode (fresh opening + stock-library tail) ──────────────
  "HYBRID_MODE",             // "1" = first N min are fresh AI clips, the rest are stock-library clips
  "HYBRID_FRESH_MINUTES",    // minutes of fresh AI at the start (default 5); rest filled from the library
  "STOCK_LIBRARY_FOLDER",    // Drive subfolder under "Clips Library" to pull stock B-roll from (e.g. "Pirates")

  // ── Reliability / scaling ─────────────────────────────────────────
  "FAILURE_THRESHOLD_PERCENT", // 0–100. If more than this % of scenes fail, the run aborts. Default 25.
  "IMAGE_HEDGE_MAX_PER_SCENE", // hidden: max parallel image candidates for one scene. Default 2.
  "IMAGE_HEDGE_AFTER_SECONDS", // hidden: seconds before launching a hedge image. Empty = dynamic p75 policy.
  "IMAGE_TIMEOUT_SECONDS",   // hidden: timeout for each image attempt. Default 300.
  "HYBRID_VIDEO_TIMEOUT_SECONDS", // hidden: fast timeout for hybrid fresh-opening video jobs. Default 480.
  "HYBRID_VIDEO_HEDGE_AFTER_SECONDS", // hidden: seconds before launching a spare-slot hedge video. Default 180.
  "HYBRID_VIDEO_MAX_PARALLEL_PER_SCENE", // hidden: max simultaneous video attempts for one fresh scene. Default 3.
  "HYBRID_VIDEO_MAX_ATTEMPTS", // hidden: retry count for hybrid fresh-opening video jobs. Default 1.
  "AUTO_REUSE_ENABLED",      // "1" = pipeline auto-searches the library and reuses matches without a preview step
  "AUTO_REUSE_THRESHOLD",    // 0–100 confidence %. Scenes matching at/above this are auto-reused. Default 80.

  // ── Google Drive sync ─────────────────────────────────────────────
  // OAuth2 credentials from Google Cloud Console (Web Application client).
  // Redirect URI must be set to http://localhost:3000/api/gdrive/oauth/callback
  "GDRIVE_CLIENT_ID",
  "GDRIVE_CLIENT_SECRET",
  // Refresh token, set automatically after the user completes the OAuth flow.
  // Don't edit by hand.
  "GDRIVE_REFRESH_TOKEN",
  // Email of the Google account that authorized — set automatically, shown in UI.
  "GDRIVE_CONNECTED_EMAIL",
  // Folder IDs in Drive. Kept only for legacy compatibility; the standalone
  // app stores generated files locally.
  "GDRIVE_ROOT_FOLDER_ID",
  "GDRIVE_CHANNELS_FOLDER_ID",
  "GDRIVE_FINAL_VIDEOS_FOLDER_ID",
  "GDRIVE_CLIPS_LIBRARY_FOLDER_ID",
  // Master switch. Empty/"0" = disabled (don't upload). "1" = upload after every run.
  "GDRIVE_SYNC_ENABLED",
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

const getStmt = db.prepare("SELECT value FROM settings WHERE key = ?");
const upsertStmt = db.prepare(
  "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')"
);

export function getSetting(key: SettingKey): string {
  const shared = sharedIntegrationValue(key);
  if (shared) return shared;
  const cached = getCachedAppSetting(key);
  if (cached !== undefined && cached !== "") return cached;
  const row = getStmt.get(key) as { value: string } | undefined;
  if (row && row.value !== "") return row.value;
  if (key === "FFMPEG_PATH") {
    const bundled = bundledFfmpeg();
    if (bundled) return bundled;
  }
  return process.env[key] ?? "";
}

function sharedIntegrationValue(key: SettingKey): string {
  const integrationName: Partial<Record<SettingKey, string>> = {
    GOOGLE_API_KEY: "google",
    LABS69_API_KEY: "69labs",
    ANTHROPIC_API_KEY: "claude",
    OPENAI_API_KEY: "openai",
  };
  const name = integrationName[key];
  if (!name) return "";
  return getIntegration(name)?.api_key?.trim() ?? "";
}

export function setSetting(key: SettingKey, value: string) {
  setCachedAppSetting(key, value);
  upsertStmt.run(key, value);
}

export function getAllSettings(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of SETTING_KEYS) out[k] = getSetting(k);
  return out;
}

/** Safe version — masks secret keys/tokens/secrets. Handles multi-line key lists too. */
export function getMaskedSettings(): Record<string, string> {
  const all = getAllSettings();
  const masked: Record<string, string> = {};
  for (const [k, v] of Object.entries(all)) {
    if (isSecretKey(k)) {
      if (!v) {
        masked[k] = "";
      } else {
        // Mask each line/entry separately so multi-key fields show all entries
        const parts = v.split(/[\n,;]+/).map((p) => p.trim()).filter(Boolean);
        masked[k] = parts.map((p) => `${p.slice(0, 4)}…${p.slice(-4)}`).join("\n");
      }
    } else {
      masked[k] = v;
    }
  }
  return masked;
}

export const DEFAULTS: Record<SettingKey, string> = {
  // Required API keys — empty by default, user must provide
  GOOGLE_API_KEY: "",
  LABS69_API_KEY: "",

  // Optional providers
  ANTHROPIC_API_KEY: "",
  OPENAI_API_KEY: "",
  FFMPEG_PATH: "",

  // Storage — empty = use default (DATA_DIR/runs)
  RUNS_OUTPUT_DIR: "",

  // Scene split
  SCENE_SPLIT_PROVIDER: "google",
  SCENE_SPLIT_MODEL: "gemini-flash-latest",
  IMAGE_CUT_VISUAL_MODEL: "gemini-2.5-pro",

  // TTS — Bilal Video Studio defaults to ElevenLabs voices through the
  // 69labs gateway (TTS_PROVIDER=69labs + TTS_VOICE_PROVIDER=elevenlabs).
  STYLE_PRESET_ID: "sleep-calm",          // no-channel run's style preset (Prompt 9)
  TTS_PROVIDER: "69labs",
  TTS_VOICE_PROVIDER: "elevenlabs",
  TTS_VOICE_ID: "G17SuINrv2H9FC6nvetn",
  TTS_MODEL: "eleven_multilingual_v2",
  TTS_SPLIT_TYPE: "paragraphs",
  TTS_LANGUAGE_BOOST: "English",

  // Voice fine-tuning (slightly slower + small style for documentary feel)
  TTS_SPEED: "0.85",
  TTS_STABILITY: "0.6",
  TTS_SIMILARITY_BOOST: "0.75",
  TTS_STYLE: "0.15",
  TTS_USE_SPEAKER_BOOST: "1",

  // Auto-pause on sentence boundaries
  TTS_AUTO_PAUSE: "1",
  TTS_PAUSE_DURATION: "0.4",
  TTS_PAUSE_FREQUENCY: "1",

  // Images — generated first, then used as first-frame keyframes for video.
  IMAGE_PROVIDER: "69labs",
  IMAGE_MODEL: "nano-banana-pro",
  IMAGE_FALLBACK_MODEL: "gpt-image-2,nano-banana-2",
  IMAGE_RATIO: "16:9",
  IMAGE_RESOLUTION: "1k",

  // Animations — Bilal Video Studio animates every generated scene through 69labs.
  ANIMATION_PROVIDER: "69labs",
  ANIMATION_MODEL: "veo-3.1-fast",        // Faster Veo path via 69labs (image-to-video); grok-imagine-video is the legacy option
  ANIMATION_RATIO_PERCENT: "100",         // 100 % of scenes animated, no Ken-Burns mix
  ANIMATION_DISTRIBUTION: "all",
  ANIMATION_DURATION: "",                 // ignored by Grok (69labs hard-codes ~6s); applies only to non-Grok/non-Veo models
  ANIMATION_KEEP_VEO_AUDIO: "",           // legacy name — applies to any model with embedded audio
  CLEAN_PROVIDER_WATERMARK: "1",
  // Global video look/mood, appended to every scene's visual_prompt. Darker /
  // slower "sleep content" seed; channels can override per-channel.
  VIDEO_STYLE:
    "Slow cinematic documentary motion, low-key lighting with deep shadows and muted earth tones, soft contrast, no harsh highlights, dreamlike pacing, gentle ambient camera drift, photographic realism with a quiet contemplative atmosphere — feels like a hushed nature documentary at dusk.",
  GENERATION_NEGATIVE_PROMPT:
    "no split screen, no collage, no multi-panel layout, no side-by-side frames, no picture-in-picture, no duplicated scenes, no text, no captions, no watermark, no logo, no UI overlay, no bright cheerful lighting unless explicitly requested",
  // Visual continuity between consecutive scenes in the same shot. "prompt"
  // appends the previous scene's identity hint to the next image prompt
  // (no extra paid calls). "keyframe" would chain the previous video's last
  // frame as the next image — not enabled today; see src/lib/continuity.ts.
  VISUAL_CONTINUITY_MODE: "prompt",

  // Video assembly
  VIDEO_RESOLUTION: "1920x1080",
  VIDEO_FPS: "30",
  SCENE_DURATION_SECONDS: "5",
  TRANSITION_DURATION: "0.5",
  SCENE_TAIL_SILENCE: "1.0",              // deprecated: continuous-voiceover (no inter-scene gaps); kept for old runs
  FINAL_ATMOSPHERE_MODE: "short_only",
  FINAL_POSTPROCESS_THREADS: "",

  // Performance
  IMAGE_CONCURRENCY: "7",
  TTS_CONCURRENCY: "3",
  ANIMATION_CONCURRENCY: "5",
  ASSEMBLE_CONCURRENCY: "4",
  ASSEMBLE_XFADE_CHUNKS: "4",

  // Hybrid mode — off by default; opt in per channel/run from the New Run page.
  HYBRID_MODE: "",
  HYBRID_FRESH_MINUTES: "1",
  STOCK_LIBRARY_FOLDER: "Pirates",

  // Reliability / scaling
  FAILURE_THRESHOLD_PERCENT: "25",
  IMAGE_HEDGE_MAX_PER_SCENE: "2",
  IMAGE_HEDGE_AFTER_SECONDS: "",
  IMAGE_TIMEOUT_SECONDS: "180",
  HYBRID_VIDEO_TIMEOUT_SECONDS: "480",
  HYBRID_VIDEO_HEDGE_AFTER_SECONDS: "180",
  HYBRID_VIDEO_MAX_PARALLEL_PER_SCENE: "3",
  HYBRID_VIDEO_MAX_ATTEMPTS: "1",
  AUTO_REUSE_ENABLED: "1",
  AUTO_REUSE_THRESHOLD: "80",

  // Google Drive — all empty by default. User fills client_id/secret;
  // OAuth flow fills refresh_token + email; folders auto-create on first sync.
  GDRIVE_CLIENT_ID: "",
  GDRIVE_CLIENT_SECRET: "",
  GDRIVE_REFRESH_TOKEN: "",
  GDRIVE_CONNECTED_EMAIL: "",
  GDRIVE_ROOT_FOLDER_ID: "",
  GDRIVE_CHANNELS_FOLDER_ID: "",
  GDRIVE_FINAL_VIDEOS_FOLDER_ID: "",
  GDRIVE_CLIPS_LIBRARY_FOLDER_ID: "",
  GDRIVE_SYNC_ENABLED: "",
};

/** Write defaults for any keys that aren't already in the DB. */
export function seedDefaults() {
  for (const [k, v] of Object.entries(DEFAULTS)) {
    const row = getStmt.get(k) as { value: string } | undefined;
    if (!row) upsertStmt.run(k, v);
  }
  forceVideoOnlyMode();
  enableImageKeyframeMode();
  preferAppControlledTtsChunks();
  preferFastGenerationModels();
}

/**
 * One-time correction for users coming from the legacy video app template: force
 * video generation on and animate 100% of scenes on first boot. The video MODEL
 * is left alone — Bilal Video Studio defaults to Veo 3.1 Fast (`veo-3.1-fast`) and Grok
 * stays a switchable option.
 * Tracked via a flag so we never overwrite a user's later manual choice.
 */
function forceVideoOnlyMode() {
  const flag = getStmt.get("_migration_grok_video_only") as { value: string } | undefined;
  if (flag?.value === "1") return;

  const rules: Array<[string, (current: string) => string | null]> = [
    ["ANIMATION_PROVIDER", (v) => (v === "off" ? "69labs" : null)],
    ["ANIMATION_RATIO_PERCENT", (v) => (v !== "100" ? "100" : null)],
    ["ANIMATION_DISTRIBUTION", (v) => (v !== "all" ? "all" : null)],
  ];
  for (const [key, transform] of rules) {
    const row = getStmt.get(key) as { value: string } | undefined;
    if (!row) continue;
    const next = transform(row.value);
    if (next !== null && next !== row.value) {
      upsertStmt.run(key, next);
    }
  }
  upsertStmt.run("_migration_grok_video_only", "1");
}

/**
 * 2026-05-28: restore the image-keyframed pipeline. Older legacy rows
 * intentionally set IMAGE_PROVIDER=off for text-to-video; switch only that
 * legacy/off value back to 69labs, preserving any explicit alternative.
 */
function enableImageKeyframeMode() {
  const flag = getStmt.get("_migration_image_keyframes_20260528") as { value: string } | undefined;
  if (flag?.value === "1") return;

  const row = getStmt.get("IMAGE_PROVIDER") as { value: string } | undefined;
  const current = row?.value?.trim().toLowerCase();
  if (!current || current === "off") {
    upsertStmt.run("IMAGE_PROVIDER", "69labs");
  }
  upsertStmt.run("_migration_image_keyframes_20260528", "1");
}

/**
 * 2026-05-31: the app already splits long narration at sentence-safe
 * boundaries. Asking 69labs to split again with `smart` can re-cut the text in
 * places we cannot inspect. Use paragraph mode so the app owns the chunking.
 */
function preferAppControlledTtsChunks() {
  const flag = getStmt.get("_migration_tts_paragraph_split_20260531") as { value: string } | undefined;
  if (flag?.value === "1") return;

  const row = getStmt.get("TTS_SPLIT_TYPE") as { value: string } | undefined;
  const current = row?.value?.trim().toLowerCase();
  if (!current || current === "smart") {
    upsertStmt.run("TTS_SPLIT_TYPE", "paragraphs");
  }
  upsertStmt.run("_migration_tts_paragraph_split_20260531", "1");
}

/**
 * 2026-05-31: use the faster current 69labs stack by default. Only migrate
 * empty/known legacy defaults, never a user's explicit custom model id.
 */
function preferFastGenerationModels() {
  const flag = getStmt.get("_migration_fast_models_20260531") as { value: string } | undefined;
  if (flag?.value === "1") return;

  const imageRow = getStmt.get("IMAGE_MODEL") as { value: string } | undefined;
  const imageCurrent = imageRow?.value?.trim().toLowerCase();
  if (!imageCurrent || imageCurrent === "imagen-4" || imageCurrent === "imagen-4-ultra") {
    upsertStmt.run("IMAGE_MODEL", "nano-banana-pro");
  }

  const videoRow = getStmt.get("ANIMATION_MODEL") as { value: string } | undefined;
  const videoCurrent = videoRow?.value?.trim().toLowerCase();
  if (!videoCurrent || videoCurrent === "grok-imagine-video" || videoCurrent === "veo-3") {
    upsertStmt.run("ANIMATION_MODEL", "veo-3.1-fast");
  }

  upsertStmt.run("_migration_fast_models_20260531", "1");
}
