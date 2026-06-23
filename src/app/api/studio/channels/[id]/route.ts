import { NextRequest, NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/auth";
import { getChannel, updateChannel, deleteChannel } from "@/lib/channels-store";
import { syncPresetForChannel } from "@/lib/video-bridge";

export const runtime = "nodejs";

async function requireAdmin() {
  const user = await getAuthedUser();
  const role = user?.app_metadata?.role;
  if (!user || role !== "admin") return null;
  return user;
}

type Ctx = { params: Promise<{ id: string }> };

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
    "voice_provider", "voice_id", "video_style", "image_prompt",
    "stock_folder", "prompt_presets",
  ];
  const patch: Record<string, unknown> = {};
  for (const k of allowed) if (k in body) patch[k] = body[k];

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
      voice_provider: channel.voice_provider,
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
  const ok = await deleteChannel(channelId);
  if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
