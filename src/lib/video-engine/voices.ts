import { randomUUID } from "node:crypto";
import db from "./db";
import { getSetting } from "./settings";

const BASE = "https://69labs.vip/api/v1";

/** A voice the user can pick in the library modal. */
export interface VoiceOption {
  /** The id sent to TTS as voiceId. */
  voiceId: string;
  /** Which TTS sub-engine this voice routes through. */
  provider: "voice-clone" | "elevenlabs";
  name: string;
  language: string | null;
  gender: string | null;
  previewUrl: string | null;
  /** Origin — drives the picker's Source filter. */
  source: "library" | "saved";
  /** DB primary key for saved voices — unique React key + delete target. Null for library voices. */
  savedId?: string | null;
}

function firstLabsKey(): string | null {
  const k = getSetting("LABS69_API_KEY")
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean)[0];
  return k ?? null;
}

/**
 * Fetch the 69labs global voice-clone library. These are clone voices (UUID
 * ids, provider "voice-clone"). Returns [] on any failure so the picker still
 * renders the saved voices.
 */
export async function fetchGlobalVoiceLibrary(): Promise<VoiceOption[]> {
  const key = firstLabsKey();
  if (!key) return [];
  try {
    const r = await fetch(`${BASE}/voice-clones/library`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!r.ok) return [];
    const json = (await r.json()) as {
      voiceClones?: Array<{
        id: string;
        name: string;
        language?: string;
        gender?: string;
        previewUrl?: string;
        status?: string;
      }>;
    };
    return (json.voiceClones ?? [])
      .filter((v) => v.status === "ready")
      .map((v) => ({
        voiceId: v.id,
        provider: "voice-clone" as const,
        name: v.name,
        language: v.language ?? null,
        gender: v.gender ?? null,
        previewUrl: v.previewUrl ?? null,
        source: "library" as const,
      }));
  } catch {
    return [];
  }
}

// ── Saved voices (local table) ──────────────────────────────────────────────

export interface SavedVoice {
  id: string;
  name: string;
  voice_id: string;
  provider: string;
  language: string | null;
  gender: string | null;
  preview_url: string | null;
  created_at: string;
}

const listSavedStmt = db.prepare("SELECT * FROM saved_voices ORDER BY created_at DESC");
const insertSavedStmt = db.prepare(
  "INSERT INTO saved_voices (id, name, voice_id, provider, language, gender, preview_url) VALUES (?, ?, ?, ?, ?, ?, ?)"
);
const findDupStmt = db.prepare(
  "SELECT id FROM saved_voices WHERE provider = ? AND voice_id = ? LIMIT 1"
);
const deleteSavedStmt = db.prepare("DELETE FROM saved_voices WHERE id = ?");
const countSavedStmt = db.prepare("SELECT COUNT(*) AS n FROM saved_voices");

function normalizeSavedVoiceProvider(provider: string | null | undefined): VoiceOption["provider"] {
  return (provider || "").trim().toLowerCase() === "voice-clone" ? "voice-clone" : "elevenlabs";
}

export function listSavedVoices(): SavedVoice[] {
  return listSavedStmt.all() as SavedVoice[];
}

export function addSavedVoice(input: {
  name: string;
  voice_id: string;
  provider?: string;
  language?: string | null;
  gender?: string | null;
  preview_url?: string | null;
}): string {
  const name = input.name.trim();
  const voiceId = input.voice_id.trim();
  if (!name) throw new Error("Voice name is required");
  if (!voiceId) throw new Error("Voice ID is required");
  const provider = normalizeSavedVoiceProvider(input.provider);

  // Reject duplicates of the same provider + voice id. App-level (not a UNIQUE
  // index) so older DBs that already contain duplicates keep working — we just
  // stop NEW dupes from being added. Existing rows are never auto-deleted.
  const dup = findDupStmt.get(provider, voiceId) as { id: string } | undefined;
  if (dup) {
    throw new Error(
      `That voice is already saved (provider "${provider}", id "${voiceId}"). Pick it from the list instead.`
    );
  }

  const id = randomUUID();
  insertSavedStmt.run(
    id,
    name,
    voiceId,
    provider,
    input.language ?? null,
    input.gender ?? null,
    input.preview_url ?? null
  );
  return id;
}

export function deleteSavedVoice(id: string): void {
  deleteSavedStmt.run(id);
}

export function savedVoicesAsOptions(): VoiceOption[] {
  return listSavedVoices().map((v) => ({
    voiceId: v.voice_id,
    provider: normalizeSavedVoiceProvider(v.provider),
    name: v.name,
    language: v.language,
    gender: v.gender,
    previewUrl: v.preview_url,
    source: "saved",
    savedId: v.id,
  }));
}

/**
 * One-time: save the current global TTS voice so it survives the switch from a
 * raw voice-ID text field to the library picker (the picker lists clones, which
 * won't include an ElevenLabs catalog voice like the current default).
 */
export function seedCurrentVoice(): void {
  if ((countSavedStmt.get() as { n: number }).n > 0) return;
  const voiceId = getSetting("TTS_VOICE_ID").trim();
  if (!voiceId) return;
  const provider = normalizeSavedVoiceProvider(getSetting("TTS_VOICE_PROVIDER"));
  addSavedVoice({
    name: voiceId === "G17SuINrv2H9FC6nvetn" ? "Christopher" : "My voice",
    voice_id: voiceId,
    provider,
    language: "English",
    gender: null,
    preview_url: null,
  });
}
