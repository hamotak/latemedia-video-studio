import { NextRequest, NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/auth";
import { getChannel, updateChannel, deleteChannel } from "@/lib/channels-store";
import { deletePresetForChannel, syncPresetForChannel } from "@/lib/video-bridge";

export const runtime = "nodejs";

async function requireAdmin() {
  const user = await getAuthedUser();
  const role = user?.app_metadata?.role;
  if (!user || role !== "admin") return null;
  return user;
}

type Ctx = { params: Promise<{ id: string }> };

const VOICE_NUMBER_FIELDS = [
  "voice_speed",
  "voice_stability",
  "voice_similarity_boost",
  "voice_style",
] as const;

const VOICE_NUMBER_LIMITS: Record<(typeof VOICE_NUMBER_FIELDS)[number], { min: number; max: number }> = {
  voice_speed: { min: 0.7, max: 1.2 },
  voice_stability: { min: 0, max: 1 },
  voice_similarity_boost: { min: 0, max: 1 },
  voice_style: { min: 0, max: 1 },
};

function normalizeOptionalVoiceNumber(field: (typeof VOICE_NUMBER_FIELDS)[number], value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return null;
  const { min, max } = VOICE_NUMBER_LIMITS[field];
  return Math.min(max, Math.max(min, n));
}

/** GET /api/studio/channels/[id] — full channel record (admin). */
export async function GET(_req: NextRequest, ctx: Ctx) {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id } = await ctx.params;
  const channelId = parseInt(id, 10);
  if (!Number.isFinite(channelId)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  const channel = await getChannel(channelId);
  if (!channel) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ channel });
}

/** PATCH /api/studio/channels/[id] — admin edits channel fields/config. */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id } = await ctx.params;
  const channelId = parseInt(id, 10);
  if (!Number.isFinite(channelId)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  // Whitelist editable columns.
  const allowed = [
    "name", "handle", "youtube_channel_id", "avatar_url", "description",
    "brief", "style_rules", "ideation_rules", "brand_topics",
    "voice_id", "video_style", "image_prompt",
    "stock_folder",
  ];
  const patch: Record<string, unknown> = {};
  for (const k of allowed) if (k in body) patch[k] = body[k];
  for (const k of VOICE_NUMBER_FIELDS) if (k in body) patch[k] = normalizeOptionalVoiceNumber(k, body[k]);
  patch.voice_provider = "elevenlabs";

  const channel = await updateChannel(channelId, patch);
  if (!channel) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Keep the channel's Video render profile in sync with its production fields.
  try {
    syncPresetForChannel({
      id: channel.id,
      name: channel.name,
      handle: channel.handle,
      avatar_url: channel.avatar_url,
      description: channel.description,
      video_style: channel.video_style,
      voice_id: channel.voice_id,
      voice_provider: "elevenlabs",
      voice_speed: channel.voice_speed,
      voice_stability: channel.voice_stability,
      voice_similarity_boost: channel.voice_similarity_boost,
      voice_style: channel.voice_style,
      stock_folder: channel.stock_folder,
    });
  } catch {
    // Engine profile sync is best-effort; never block a channel save on it.
  }

  return NextResponse.json({ channel });
}

/** DELETE /api/studio/channels/[id] — admin removes a channel. */
export async function DELETE(_req: NextRequest, ctx: Ctx) {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id } = await ctx.params;
  const channelId = parseInt(id, 10);
  if (!Number.isFinite(channelId)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  const existing = await getChannel(channelId);
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const ok = await deleteChannel(channelId);
  if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 });
  deletePresetForChannel(channelId);
  return NextResponse.json({ ok: true });
}
