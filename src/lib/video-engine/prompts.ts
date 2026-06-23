import db from "./db";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultStockFolder } from "./channel-stock";
import { DEFAULT_STYLE_PRESET_ID, loadStylePreset } from "./style-presets";
import { inferChannelSettings, isStylePresetDefault } from "./channel-intelligence";

export const PROMPT_NAMES = ["scene_split", "image_prompt", "animation_motion"] as const;
export type PromptName = (typeof PROMPT_NAMES)[number];

export const DEFAULT_PROMPTS: Record<PromptName, string> = {
  scene_split: `You are a video editor for a faceless YouTube channel. Split the provided script into scenes for an automated AI video pipeline (one narrated visual beat per scene).

HOW TO SPLIT — protect the narration first:
  Each scene is one complete spoken thought. Read for meaning and sentence flow.

SCENE LENGTH:
- Target: 12–22 seconds of narration per scene (roughly 25–45 words at a calm speaking pace).
- Two short related sentences SHOULD share one scene when they form one thought.
- A sentence fragment is never its own scene. Always merge fragments.
- Do not cut after dangling connector words such as and, but, of, to, the, with, or from.

SENTENCE & CLAUSE RULES:
- Prefer breaking on sentence boundaries (. ? !).
- If one sentence is too long, split only at a natural clause boundary near the middle: em-dash (—), semicolon (;), colon (:), then comma (,).
- Never split in the middle of a phrase, name, setup/punchline, or descriptive clause.

VERBATIM COVERAGE (critical):
- Cover the ENTIRE script word-for-word. No omissions, no summarizing, no paraphrasing, no reordering, no punctuation changes.
- The concatenation of every scene's "text" field, joined with single spaces, MUST equal the original script exactly.

For EACH scene, return a JSON object with:
- "text": the exact verbatim slice of the script for this scene (no edits, no punctuation changes).
- "visual_prompt": a 40–90-word English description of a single cinematic shot that literally illustrates this scene's text. Describe the subject, the setting, and explicit camera or subject motion (slow push-in, gentle parallax, drifting light, rising mist). Photographic realism. No on-screen text, captions, logos, or watermarks. No recognizable real people or faces in close-up. The channel's overall look (lighting, mood, color grade) is appended automatically afterward — describe SUBSTANCE here, not style.
- "duration_hint_sec": estimated narration length in seconds (number, 12–22).

VISUAL CONTINUITY (additional fields — emit honestly; do NOT fake continuity):
- "continuity_group_id": a short kebab-case slug naming the SHOT IDENTITY (e.g. "ship-charleston-harbor", "blackbeard-deck", "blockade-charleston-1718"). Consecutive scenes that show the SAME subject + same location + same time of day MUST share the same group id. Different subject / different place / major time jump = a NEW group id.
- "continuity_break": true when this scene introduces a new place, new subject, new time of day, or a deliberate cut to a different shot type that should NOT carry visual identity from the previous scene. Set true on the FIRST scene of a new group. Otherwise false. The first scene of the whole script is always true.
- "continuity_hint": a 12–25-word identity carrier — the specific subject (e.g. "a massive 1718 wooden three-masted pirate ship, 40 cannon ports, black hull, weathered sails"), the era/wardrobe, lighting and palette. Reused by the pipeline to anchor the next scene's image to the same subject. Empty string when not applicable.

Honest rule: a tight close-up after a wide shot of the SAME ship is the same group (continuity_break: false). A cut to a new harbor, a new character, or a flashback is a different group (continuity_break: true). Do not chain everything — chaining a close-up of a beard to a wide ocean shot would just blur the identity.

Return ONLY a strictly valid JSON array — no markdown, no commentary.`,

  image_prompt: `documentary photography, photoreal, NatGeo / BBC Earth cinematography style, golden-hour Mediterranean light, warm earth tones, natural color grading, soft contrast, 35mm full-frame, shallow depth of field on close-ups, wide cinematic landscape for environments, sharp focus, 16:9 aspect ratio, no text overlays, no watermarks, no logos, no captions, no recognizable faces in close-up, no young people, no children, no sick or hospitalized bodies, no cartoon stylization, no painterly artwork, no fantasy elements, no sci-fi, no clickbait graphics`,

  animation_motion: `subtle cinematic documentary camera motion, slow dolly push-in or gentle parallax, natural ambient movement (steam rising, leaves drifting, sunlight shifting), shallow depth of field, photographic realism in the style of a NatGeo or BBC Earth documentary, no jarring cuts, no rapid pans, no whip motion — feels like a living photograph`,
};

const getStmt = db.prepare("SELECT content FROM prompts WHERE name = ?");
const upsertStmt = db.prepare(
  "INSERT INTO prompts (name, content, updated_at) VALUES (?, ?, datetime('now')) " +
    "ON CONFLICT(name) DO UPDATE SET content = excluded.content, updated_at = datetime('now')"
);

export function getPrompt(name: PromptName): string {
  const row = getStmt.get(name) as { content: string } | undefined;
  if (row?.content) return row.content;
  return DEFAULT_PROMPTS[name];
}

export function setPrompt(name: PromptName, content: string) {
  upsertStmt.run(name, content);
}

export function getAllPrompts(): Record<PromptName, string> {
  const out = {} as Record<PromptName, string>;
  for (const n of PROMPT_NAMES) out[n] = getPrompt(n);
  return out;
}

export function seedPromptDefaults() {
  for (const [n, c] of Object.entries(DEFAULT_PROMPTS)) {
    const row = getStmt.get(n) as { content: string } | undefined;
    if (!row) upsertStmt.run(n, c);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Channel Profiles — user-defined per-channel bundles.
// (DB table is named "prompt_presets" for legacy reasons.)
// Each profile carries: a scene_split prompt, optional animation-motion
// override, optional image-prompt override, optional per-channel voice id
// (MiniMax), and an optional human description. The user picks one on the
// New Run page; anything left empty falls back to global defaults/settings.
// ─────────────────────────────────────────────────────────────────────────

export interface PromptPreset {
  id: number;
  name: string;
  /** scene_split prompt (required) */
  content: string;
  /** human-readable note about the channel (optional) */
  description: string | null;
  /** YouTube handle shown in the global channel switcher, e.g. @colddepths. */
  handle: string | null;
  /** Subscriber count shown in the global channel switcher. */
  subscriber_count: number | null;
  /** Channel avatar/logo URL shown in the global channel switcher. */
  avatar_url: string | null;
  /** style preset id (Prompt 9) — drives the scene-split prompt + default tuning. NULL = sleep-calm. */
  style_preset_id: string | null;
  /** video style override — appended to every scene's visual_prompt (optional — NULL = preset/global). */
  video_style: string | null;
  /** video model override (e.g. veo-3.1-fast) — NULL = global ANIMATION_MODEL. */
  video_model: string | null;
  /** aspect ratio override (e.g. 16:9) — NULL = global IMAGE_RATIO. */
  aspect_ratio: string | null;
  /** voice speed override 0.5–1.5 — NULL = preset/global. */
  voice_speed: number | null;
  /** voice stability 0–1 — NULL = preset/global TTS_STABILITY. */
  voice_stability: number | null;
  /** voice similarity boost 0–1 — NULL = preset/global TTS_SIMILARITY_BOOST. */
  voice_similarity_boost: number | null;
  /** voice style 0–1 — NULL = preset/global TTS_STYLE. */
  voice_style: number | null;
  /** per-channel voice id (optional — NULL = global TTS_VOICE_ID). Set via the voice library picker. */
  voice_id: string | null;
  /** TTS provider for the per-channel voice (voice-clone | elevenlabs). NULL = global TTS_VOICE_PROVIDER. */
  voice_provider: string | null;
  /** Drive stock folder this channel pulls B-roll from (Hybrid/Stock Cut). NULL = global STOCK_LIBRARY_FOLDER. */
  stock_folder: string | null;
  /** Minutes of fresh AI at the start in Hybrid mode. NULL = global HYBRID_FRESH_MINUTES. */
  hybrid_fresh_minutes: number | null;
  /** @deprecated scene-end pause — continuous voiceover has no inter-scene gaps */
  scene_end_pause_seconds: number | null;
  /** @deprecated legacy animation_motion override — superseded by video_style */
  animation_motion: string | null;
  /** @deprecated legacy per-channel image prompt override — currently unused */
  image_prompt: string | null;
  created_at: string;
  updated_at: string;
}

/** Fields accepted when creating/updating a channel profile. */
export interface PromptPresetInput {
  name: string;
  /** @deprecated — scene-split prompt now comes from the style preset; auto-filled if omitted. */
  content?: string;
  description?: string | null;
  handle?: string | null;
  subscriber_count?: number | string | null;
  avatar_url?: string | null;
  style_preset_id?: string | null;
  video_style?: string | null;
  video_model?: string | null;
  aspect_ratio?: string | null;
  voice_speed?: number | null;
  voice_stability?: number | null;
  voice_similarity_boost?: number | null;
  voice_style?: number | null;
  voice_id?: string | null;
  voice_provider?: string | null;
  stock_folder?: string | null;
  hybrid_fresh_minutes?: number | null;
}

const PRESET_COLS =
  "id, name, content, description, handle, subscriber_count, avatar_url, style_preset_id, video_style, video_model, aspect_ratio, voice_speed, voice_stability, voice_similarity_boost, voice_style, voice_id, voice_provider, stock_folder, hybrid_fresh_minutes, animation_motion, image_prompt, created_at, updated_at";

const listPresetsStmt = db.prepare(
  `SELECT ${PRESET_COLS} FROM prompt_presets ORDER BY name COLLATE NOCASE ASC`
);
const getPresetStmt = db.prepare(`SELECT ${PRESET_COLS} FROM prompt_presets WHERE id = ?`);
const getPresetByNameStmt = db.prepare(`SELECT ${PRESET_COLS} FROM prompt_presets WHERE name = ?`);
const createPresetStmt = db.prepare(
  "INSERT INTO prompt_presets (name, content, description, handle, subscriber_count, avatar_url, style_preset_id, video_style, video_model, aspect_ratio, voice_speed, voice_stability, voice_similarity_boost, voice_style, voice_id, voice_provider, stock_folder, hybrid_fresh_minutes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
);
const updatePresetStmt = db.prepare(
  "UPDATE prompt_presets SET name = ?, content = ?, description = ?, handle = ?, subscriber_count = ?, avatar_url = ?, style_preset_id = ?, video_style = ?, video_model = ?, aspect_ratio = ?, voice_speed = ?, voice_stability = ?, voice_similarity_boost = ?, voice_style = ?, voice_id = ?, voice_provider = ?, stock_folder = ?, hybrid_fresh_minutes = ?, updated_at = datetime('now') WHERE id = ?"
);
const deletePresetStmt = db.prepare("DELETE FROM prompt_presets WHERE id = ?");
const backfillMetadataStmt = db.prepare(`
  UPDATE prompt_presets
  SET
    handle = CASE WHEN (handle IS NULL OR handle = '') AND ? IS NOT NULL THEN ? ELSE handle END,
    subscriber_count = CASE WHEN subscriber_count IS NULL AND ? IS NOT NULL THEN ? ELSE subscriber_count END,
    avatar_url = CASE WHEN (avatar_url IS NULL OR avatar_url = '') AND ? IS NOT NULL THEN ? ELSE avatar_url END
  WHERE name = ?
    AND (
      handle IS NULL OR handle = ''
      OR subscriber_count IS NULL
      OR avatar_url IS NULL OR avatar_url = ''
    )
`);

interface ChannelMetadataSeed {
  name: string;
  handle: string | null;
  subscriber_count: number | null;
  avatar_url: string | null;
}

const FALLBACK_CHANNEL_METADATA: ChannelMetadataSeed[] = [
  { name: "Late Science", handle: "@late_science", subscriber_count: 120000, avatar_url: null },
  { name: "Earth Radar", handle: "@earth_radar", subscriber_count: 5610, avatar_url: null },
  { name: "The Sleeping Orbit", handle: "@thesleepingorbit", subscriber_count: 4890, avatar_url: null },
  { name: "Inner Space", handle: "@innerspacedoc", subscriber_count: 2700, avatar_url: null },
  { name: "The Atom Lab", handle: "@theatomlab-g2y", subscriber_count: 2490, avatar_url: null },
  { name: "Cold Depths", handle: "@colddepths", subscriber_count: 1060, avatar_url: null },
  { name: "Sleepy Pirate History", handle: "@sleepypiratehistory", subscriber_count: 0, avatar_url: null },
];

let metadataBackfilled = false;

function managerChannelMetadata(): ChannelMetadataSeed[] {
  const dbPath = path.join(os.homedir(), "ytmanager", "data", "app.db");
  if (!fs.existsSync(dbPath)) return [];
  let source: Database.Database | null = null;
  try {
    source = new Database(dbPath, { readonly: true, fileMustExist: true });
    return source
      .prepare(
        "SELECT title AS name, handle, subscriber_count, avatar_url FROM channels WHERE title IS NOT NULL AND title <> ''"
      )
      .all() as ChannelMetadataSeed[];
  } catch {
    return [];
  } finally {
    try {
      source?.close();
    } catch {
      /* ignore readonly DB close failures */
    }
  }
}

function ensureChannelMetadataBackfilled(): void {
  if (metadataBackfilled) return;
  metadataBackfilled = true;

  const byName = new Map<string, ChannelMetadataSeed>();
  for (const seed of FALLBACK_CHANNEL_METADATA) byName.set(seed.name, seed);
  for (const seed of managerChannelMetadata()) byName.set(seed.name, seed);

  const tx = db.transaction((seeds: ChannelMetadataSeed[]) => {
    for (const seed of seeds) {
      backfillMetadataStmt.run(
        normalizeOptional(seed.handle),
        normalizeOptional(seed.handle),
        normalizeInteger(seed.subscriber_count),
        normalizeInteger(seed.subscriber_count),
        normalizeOptional(seed.avatar_url),
        normalizeOptional(seed.avatar_url),
        seed.name
      );
    }
  });
  tx([...byName.values()]);
}

export function listPromptPresets(): PromptPreset[] {
  ensureChannelMetadataBackfilled();
  return listPresetsStmt.all() as PromptPreset[];
}

export function getPromptPreset(id: number): PromptPreset | null {
  ensureChannelMetadataBackfilled();
  const row = getPresetStmt.get(id) as PromptPreset | undefined;
  return row ?? null;
}

export function getPromptPresetByName(name: string): PromptPreset | null {
  ensureChannelMetadataBackfilled();
  const row = getPresetByNameStmt.get(name) as PromptPreset | undefined;
  return row ?? null;
}

/** Normalize an optional string field — empty/whitespace becomes NULL (means "inherit default"). */
function normalizeOptional(s: string | null | undefined): string | null {
  if (s == null) return null;
  const trimmed = s.trim();
  return trimmed.length > 0 ? s : null;
}

/** Normalize an optional numeric field — null/empty/NaN becomes NULL (means "inherit global"). */
function normalizeNumber(n: number | string | null | undefined): number | null {
  if (n == null || n === "") return null;
  const v = typeof n === "number" ? n : parseFloat(n);
  return Number.isFinite(v) ? v : null;
}

function normalizeInteger(n: number | string | null | undefined): number | null {
  const v = normalizeNumber(n);
  return v == null ? null : Math.max(0, Math.round(v));
}

/** Scene-split prompt now lives in code per style preset; keep the legacy NOT NULL
 *  `content` column populated with that prompt so old rows/diagnostics still read sensibly. */
function resolveContent(input: PromptPresetInput): string {
  if (input.content && input.content.trim()) return input.content;
  return loadStylePreset(input.style_preset_id ?? DEFAULT_STYLE_PRESET_ID).sceneSplitPrompt;
}

export function createPromptPreset(input: PromptPresetInput): number {
  const trimmedName = input.name.trim();
  if (!trimmedName) throw new Error("Channel name cannot be empty");
  const inferred = inferChannelSettings({
    name: trimmedName,
    description: input.description,
    stylePresetId: input.style_preset_id,
    videoStyle: input.video_style,
  });
  const stylePresetId = resolveStylePresetInput(input.style_preset_id, inferred.stylePresetId);
  const videoStyle = resolveVideoStyleInput(input.video_style, stylePresetId, inferred.videoStyle);
  const result = createPresetStmt.run(
    trimmedName,
    resolveContent({ ...input, style_preset_id: stylePresetId }),
    normalizeOptional(input.description),
    normalizeOptional(input.handle),
    normalizeInteger(input.subscriber_count),
    normalizeOptional(input.avatar_url),
    stylePresetId,
    videoStyle,
    normalizeOptional(input.video_model) ?? inferred.videoModel,
    normalizeOptional(input.aspect_ratio) ?? inferred.aspectRatio,
    normalizeNumber(input.voice_speed),
    normalizeNumber(input.voice_stability),
    normalizeNumber(input.voice_similarity_boost),
    normalizeNumber(input.voice_style),
    normalizeOptional(input.voice_id),
    normalizeOptional(input.voice_provider),
    normalizeOptional(input.stock_folder) ?? inferred.stockFolder ?? defaultStockFolder(trimmedName),
    normalizeNumber(input.hybrid_fresh_minutes)
  );
  return Number(result.lastInsertRowid);
}

export function updatePromptPreset(id: number, input: PromptPresetInput): void {
  const trimmedName = input.name.trim();
  if (!trimmedName) throw new Error("Channel name cannot be empty");
  const inferred = inferChannelSettings({
    name: trimmedName,
    description: input.description,
    stylePresetId: input.style_preset_id,
    videoStyle: input.video_style,
  });
  const stylePresetId = resolveStylePresetInput(input.style_preset_id, inferred.stylePresetId);
  const videoStyle = resolveVideoStyleInput(input.video_style, stylePresetId, inferred.videoStyle);
  const result = updatePresetStmt.run(
    trimmedName,
    resolveContent({ ...input, style_preset_id: stylePresetId }),
    normalizeOptional(input.description),
    normalizeOptional(input.handle),
    normalizeInteger(input.subscriber_count),
    normalizeOptional(input.avatar_url),
    stylePresetId,
    videoStyle,
    normalizeOptional(input.video_model) ?? inferred.videoModel,
    normalizeOptional(input.aspect_ratio) ?? inferred.aspectRatio,
    normalizeNumber(input.voice_speed),
    normalizeNumber(input.voice_stability),
    normalizeNumber(input.voice_similarity_boost),
    normalizeNumber(input.voice_style),
    normalizeOptional(input.voice_id),
    normalizeOptional(input.voice_provider),
    normalizeOptional(input.stock_folder) ?? inferred.stockFolder,
    normalizeNumber(input.hybrid_fresh_minutes),
    id
  );
  if (result.changes === 0) throw new Error(`Channel profile id=${id} not found`);
}

function resolveVideoStyleInput(
  videoStyle: string | null | undefined,
  stylePresetId: string,
  inferredVideoStyle: string
): string | null {
  if (isStylePresetDefault(videoStyle, stylePresetId)) return inferredVideoStyle;
  return normalizeOptional(videoStyle);
}

function resolveStylePresetInput(stylePresetId: string | null | undefined, inferredStylePresetId: string): string {
  const clean = normalizeOptional(stylePresetId);
  if (!clean || clean === DEFAULT_STYLE_PRESET_ID) return inferredStylePresetId;
  return clean;
}

export function deletePromptPreset(id: number): void {
  deletePresetStmt.run(id);
}
