import db from "@/lib/video-engine/db";
import { createPromptPreset, updatePromptPreset } from "@/lib/video-engine/prompts";
import { ensureInit } from "@/lib/video-engine/init";

/**
 * Bridges the Studio channel to the video engine's local production profile
 * (`prompt_presets`). Each channel gets exactly one engine preset, linked by
 * `studio_channel_id`, so the Video studio can render for the active channel
 * without a separate profile picker.
 */

let columnReady = false;
function ensureStudioColumn() {
  if (columnReady) return;
  const cols = db.prepare("PRAGMA table_info(prompt_presets)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "studio_channel_id")) {
    db.prepare("ALTER TABLE prompt_presets ADD COLUMN studio_channel_id INTEGER").run();
  }
  db.prepare(
    "UPDATE prompt_presets SET voice_provider = ? WHERE voice_provider IS NULL OR lower(trim(voice_provider)) <> ?"
  ).run(VOICE_PROVIDER, VOICE_PROVIDER);
  columnReady = true;
}

export type ChannelForPreset = {
  id: number;
  name: string;
  handle: string | null;
  avatar_url: string | null;
  description: string | null;
  video_style?: unknown;
  voice_id: string | null;
  voice_provider: string | null;
  voice_speed?: number | null;
  voice_stability?: number | null;
  voice_similarity_boost?: number | null;
  voice_style?: number | null;
  stock_folder: string | null;
};

const VOICE_PROVIDER = "elevenlabs";

function optionalText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? value : null;
}

/** Find-or-create the engine production profile for a Studio channel; returns its preset id. */
export function ensurePresetForChannel(channel: ChannelForPreset): number {
  ensureInit();
  ensureStudioColumn();

  // 1) Already linked to this channel.
  const existing = db
    .prepare("SELECT id FROM prompt_presets WHERE studio_channel_id = ?")
    .get(channel.id) as { id: number } | undefined;
  if (existing) return existing.id;

  // 2) A preset with this name already exists (created before linking, or the
  //    engine default). Adopt it instead of colliding on the unique name —
  //    unless it's already claimed by a different channel.
  const baseName = channel.name?.trim() || `Channel ${channel.id}`;
  const byName = db
    .prepare("SELECT id, studio_channel_id FROM prompt_presets WHERE name = ?")
    .get(baseName) as { id: number; studio_channel_id: number | null } | undefined;
  if (byName && (byName.studio_channel_id == null || byName.studio_channel_id === channel.id)) {
    db.prepare("UPDATE prompt_presets SET studio_channel_id = ? WHERE id = ?").run(channel.id, byName.id);
    return byName.id;
  }

  // 3) Create with a name that won't collide.
  let name = baseName;
  if (byName) {
    name = `${baseName} (${channel.id})`;
    let n = 2;
    while (db.prepare("SELECT 1 FROM prompt_presets WHERE name = ?").get(name)) {
      name = `${baseName} (${channel.id}-${n++})`;
    }
  }
  const id = createPromptPreset({
    name,
    handle: channel.handle,
    avatar_url: channel.avatar_url,
    description: channel.description,
    video_style: optionalText(channel.video_style),
    voice_id: channel.voice_id,
    voice_provider: VOICE_PROVIDER,
    voice_speed: channel.voice_speed ?? null,
    voice_stability: channel.voice_stability ?? null,
    voice_similarity_boost: channel.voice_similarity_boost ?? null,
    voice_style: channel.voice_style ?? null,
    stock_folder: channel.stock_folder,
  });
  db.prepare("UPDATE prompt_presets SET studio_channel_id = ? WHERE id = ?").run(channel.id, id);
  return id;
}

/**
 * Ensure the channel's engine production profile exists AND push the
 * channel's current production fields onto it. Call after a channel edit so
 * Channel Info stays the source of truth for the Video render profile.
 */
export function syncPresetForChannel(channel: ChannelForPreset): number {
  const id = ensurePresetForChannel(channel);
  // Keep the preset's existing name (set by ensure) so a rename can never
  // collide with another channel's preset on the unique `name` column.
  const row = db.prepare("SELECT name FROM prompt_presets WHERE id = ?").get(id) as { name: string } | undefined;
  updatePromptPreset(id, {
    name: row?.name ?? channel.name,
    handle: channel.handle,
    avatar_url: channel.avatar_url,
    description: channel.description,
    video_style: optionalText(channel.video_style),
    voice_id: channel.voice_id,
    voice_provider: VOICE_PROVIDER,
    voice_speed: channel.voice_speed ?? null,
    voice_stability: channel.voice_stability ?? null,
    voice_similarity_boost: channel.voice_similarity_boost ?? null,
    voice_style: channel.voice_style ?? null,
    stock_folder: channel.stock_folder,
  });
  return id;
}

export function deletePresetForChannel(channelId: number): void {
  ensureInit();
  ensureStudioColumn();
  db.prepare("DELETE FROM prompt_presets WHERE studio_channel_id = ?").run(channelId);
}
