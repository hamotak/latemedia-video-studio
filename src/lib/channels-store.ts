import "server-only";
import db from "@/lib/video-engine/db";
import { FEATURES } from "@/lib/permissions";

/**
 * Local, single-user channel store.
 *
 * Originally Supabase-backed; in the standalone build a "channel" lives in the
 * same local SQLite database the video engine already owns (`hum.db`). A
 * channel still carries the production profile (voice, video style, stock
 * folder) the Video studio renders against. There are no accounts, so the
 * per-user access tables collapse to "the single admin can see everything".
 *
 * Heavy render artifacts (run folders, images, clips, MP4s) stay on disk +
 * optional Google Drive — only lightweight channel config lives here.
 */

export type Channel = {
  id: number;
  display_order: number;
  name: string;
  handle: string | null;
  youtube_channel_id: string | null;
  avatar_url: string | null;
  description: string | null;
  // Ideation side (kept for type-compatibility with shared code)
  brief: string | null;
  style_rules: string | null;
  ideation_rules: unknown;
  brand_topics: unknown;
  // Production profile (editing tool)
  voice_provider: string | null;
  voice_id: string | null;
  video_style: unknown;
  image_prompt: string | null;
  stock_folder: string | null;
  prompt_presets: unknown;
  created_at: string;
  updated_at: string;
  // Business metadata
  subscriber_count: number | null;
  video_count: number | null;
  editor_name: string | null;
  monetization_status: "monetized" | "pending" | "not_eligible" | null;
  notes: string | null;
  cms_name: string | null;
  cms_cut_percent: number | null;
  adsense_name: string | null;
  expected_videos_per_month: number | null;
  banned_topics: string | null;
  reddit_sources: string | null;
  thumbnail_style_goals: string | null;
  thumbnail_design_rules: string | null;
  legacy_context: Record<string, string> | null;
};

export type ChannelFeatures = Record<string, boolean>;

/** Single source of truth for the per-channel feature columns. */
export const CHANNEL_FEATURES = FEATURES;

/** Single user ⇒ every feature is always granted. */
const ALL_FEATURES: ChannelFeatures = Object.fromEntries(
  FEATURES.map((f) => [f.key, true])
);

/* ════════════════════════════════════════════════
   SCHEMA
════════════════════════════════════════════════ */
db.exec(`
  CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    display_order INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL,
    handle TEXT,
    youtube_channel_id TEXT,
    avatar_url TEXT,
    description TEXT,
    brief TEXT,
    style_rules TEXT,
    ideation_rules TEXT,
    brand_topics TEXT,
    voice_provider TEXT,
    voice_id TEXT,
    video_style TEXT,
    image_prompt TEXT,
    stock_folder TEXT,
    prompt_presets TEXT,
    subscriber_count INTEGER,
    video_count INTEGER,
    editor_name TEXT,
    monetization_status TEXT,
    notes TEXT,
    cms_name TEXT,
    cms_cut_percent REAL,
    adsense_name TEXT,
    expected_videos_per_month INTEGER,
    banned_topics TEXT,
    reddit_sources TEXT,
    thumbnail_style_goals TEXT,
    thumbnail_design_rules TEXT,
    legacy_context TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

/** Columns whose values are stored as JSON text and parsed back into objects. */
const JSON_COLUMNS = new Set([
  "ideation_rules",
  "brand_topics",
  "video_style",
  "prompt_presets",
  "legacy_context",
]);

type ChannelRow = Record<string, unknown>;

function parseMaybeJson(value: unknown): unknown {
  if (value == null) return null;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value; // plain-string values (e.g. a raw video_style prompt)
  }
}

function rowToChannel(row: ChannelRow | undefined): Channel | null {
  if (!row) return null;
  const out: ChannelRow = { ...row };
  for (const col of JSON_COLUMNS) out[col] = parseMaybeJson(row[col]);
  return out as unknown as Channel;
}

function encodeValue(column: string, value: unknown): unknown {
  if (value == null) return null;
  if (JSON_COLUMNS.has(column) && typeof value === "object") {
    return JSON.stringify(value);
  }
  return value as string | number;
}

/* ════════════════════════════════════════════════
   CHANNELS
════════════════════════════════════════════════ */
export async function listChannels(): Promise<Channel[]> {
  const rows = db
    .prepare("SELECT * FROM channels ORDER BY display_order ASC, id ASC")
    .all() as ChannelRow[];
  return rows.map((r) => rowToChannel(r)!).filter(Boolean);
}

export async function getChannel(id: number): Promise<Channel | null> {
  const row = db.prepare("SELECT * FROM channels WHERE id = ?").get(id) as ChannelRow | undefined;
  return rowToChannel(row);
}

export async function getChannelByYoutubeId(youtubeChannelId: string): Promise<Channel | null> {
  const row = db
    .prepare("SELECT * FROM channels WHERE youtube_channel_id = ? ORDER BY id ASC LIMIT 1")
    .get(youtubeChannelId) as ChannelRow | undefined;
  return rowToChannel(row);
}

function nextDisplayOrder(): number {
  const row = db
    .prepare("SELECT display_order FROM channels ORDER BY display_order DESC, id DESC LIMIT 1")
    .get() as { display_order: number } | undefined;
  return typeof row?.display_order === "number" ? row.display_order + 1 : 0;
}

export async function createChannel(input: {
  name: string;
  handle?: string | null;
  youtube_channel_id?: string | null;
  avatar_url?: string | null;
  description?: string | null;
  subscriber_count?: number | null;
  video_count?: number | null;
}): Promise<Channel> {
  const info = db
    .prepare(
      `INSERT INTO channels
        (display_order, name, handle, youtube_channel_id, avatar_url, description, subscriber_count, video_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      nextDisplayOrder(),
      input.name.trim(),
      input.handle ?? null,
      input.youtube_channel_id ?? null,
      input.avatar_url ?? null,
      input.description ?? null,
      input.subscriber_count ?? null,
      input.video_count ?? null
    );
  const created = await getChannel(Number(info.lastInsertRowid));
  if (!created) throw new Error("Failed to create channel");
  return created;
}

export async function setChannelColumn(id: number, column: string, value: unknown): Promise<void> {
  try {
    db.prepare(`UPDATE channels SET ${column} = ?, updated_at = datetime('now') WHERE id = ?`).run(
      encodeValue(column, value) as never,
      id
    );
  } catch {
    /* column may not exist — match the lenient legacy contract */
  }
}

export async function updateChannel(
  id: number,
  patch: Partial<Omit<Channel, "id" | "created_at" | "updated_at">>
): Promise<Channel | null> {
  const entries = Object.entries(patch);
  if (entries.length === 0) return getChannel(id);
  const sets = entries.map(([k]) => `${k} = ?`).join(", ");
  const values = entries.map(([k, v]) => encodeValue(k, v));
  db.prepare(`UPDATE channels SET ${sets}, updated_at = datetime('now') WHERE id = ?`).run(
    ...(values as never[]),
    id
  );
  return getChannel(id);
}

export async function deleteChannel(id: number): Promise<boolean> {
  const info = db.prepare("DELETE FROM channels WHERE id = ?").run(id);
  return info.changes > 0;
}

export async function reorderChannels(orderedChannelIds: number[]): Promise<Channel[]> {
  const uniqueIds = Array.from(new Set(orderedChannelIds));
  if (uniqueIds.length !== orderedChannelIds.length) {
    throw new Error("orderedChannelIds must not contain duplicates.");
  }
  const existing = await listChannels();
  const existingIds = new Set(existing.map((c) => c.id));
  const missing = uniqueIds.filter((id) => !existingIds.has(id));
  if (missing.length > 0 || uniqueIds.length !== existing.length) {
    throw new Error("orderedChannelIds must include every channel exactly once.");
  }
  const stmt = db.prepare("UPDATE channels SET display_order = ?, updated_at = datetime('now') WHERE id = ?");
  const tx = db.transaction((ids: number[]) => {
    ids.forEach((id, index) => stmt.run(index, id));
  });
  tx(orderedChannelIds);
  return listChannels();
}

/* ════════════════════════════════════════════════
   USER ↔ CHANNEL ACCESS  (single-user: everything granted)
════════════════════════════════════════════════ */
export async function listChannelsForUser(_userId: string): Promise<Channel[]> {
  return listChannels();
}

export async function isChannelMember(_userId: string, channelId: number): Promise<boolean> {
  return (await getChannel(channelId)) != null;
}

export async function assignUserToChannel(): Promise<void> {
  /* no-op: single user */
}

export async function removeUserFromChannel(): Promise<void> {
  /* no-op: single user */
}

export async function setUserChannelFeatures(): Promise<void> {
  /* no-op: single user */
}

export async function getUserChannelFeatures(
  _userId?: string,
  _channelId?: number
): Promise<ChannelFeatures> {
  return { ...ALL_FEATURES };
}

export async function channelMemberIds(): Promise<string[]> {
  return ["local-admin"];
}

/* ════════════════════════════════════════════════
   ACTIVE CHANNEL  (stored as a single settings row)
════════════════════════════════════════════════ */
const ACTIVE_KEY = "studio.active_channel_id";
const getActiveStmt = db.prepare("SELECT value FROM settings WHERE key = ?");
const setActiveStmt = db.prepare(
  "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')"
);

export async function getActiveChannelId(_userId: string): Promise<number | null> {
  const row = getActiveStmt.get(ACTIVE_KEY) as { value: string } | undefined;
  const stored = row?.value ? parseInt(row.value, 10) : NaN;
  if (Number.isFinite(stored) && stored > 0 && (await getChannel(stored))) return stored;
  const first = (await listChannels())[0];
  return first?.id ?? null;
}

export async function setActiveChannel(_userId: string, channelId: number): Promise<void> {
  setActiveStmt.run(ACTIVE_KEY, String(channelId));
}

/* ════════════════════════════════════════════════
   TAGS  (not used in the standalone build — safe stubs)
════════════════════════════════════════════════ */
export type Tag = { id: number; name: string; cut_percent: number | null; color: string | null; created_at: string };
export type TagEntry = { id: number; name: string; cut_percent: number | null; color: string | null };

export async function listAllTags(): Promise<Tag[]> {
  return [];
}
export async function getTagByName(): Promise<Tag | null> {
  return null;
}
export async function createOrGetTag(input: { name: string; cut_percent?: number | null; color?: string | null }): Promise<Tag> {
  return {
    id: 0,
    name: input.name.trim(),
    cut_percent: input.cut_percent ?? null,
    color: input.color ?? null,
    created_at: new Date().toISOString(),
  };
}
export async function getTagsForChannel(): Promise<TagEntry[]> {
  return [];
}
export async function tagsByChannels(): Promise<Map<number, TagEntry[]>> {
  return new Map();
}
export async function attachTagToChannel(): Promise<void> {
  /* no-op */
}
export async function detachTagFromChannel(): Promise<void> {
  /* no-op */
}
