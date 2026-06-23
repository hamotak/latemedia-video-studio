import { NextResponse } from "next/server";
import { requireVideoChannelAccess } from "@/lib/video-access";
import { ensurePresetForChannel } from "@/lib/video-bridge";
import { getPromptPreset } from "@/lib/video-engine/prompts";

export const runtime = "nodejs";

/**
 * GET /api/video/active-profile — the engine production profile for the
 * caller's active Studio channel (created on demand). The Video studio uses
 * this so renders are scoped to the selected channel automatically.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const rawChannelId = url.searchParams.get("channelId");
  let requestedChannelId: number | null = null;
  if (rawChannelId) {
    const parsedChannelId = Number(rawChannelId);
    if (!Number.isFinite(parsedChannelId) || parsedChannelId <= 0) {
      return NextResponse.json({ error: "Invalid channelId" }, { status: 400 });
    }
    requestedChannelId = parsedChannelId;
  }
  const gate = await requireVideoChannelAccess(requestedChannelId);
  if (!gate) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const channel = gate.channel;
  if (!channel) return NextResponse.json({ profile: null });

  const presetId = ensurePresetForChannel({
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
  const preset = getPromptPreset(presetId);

  return NextResponse.json({
    profile: {
      presetId,
      channelId: channel.id,
      channelName: channel.name,
      profileName: preset?.name ?? channel.name,
      stylePresetId: preset?.style_preset_id ?? null,
      videoStyle: preset?.video_style ?? null,
      videoModel: preset?.video_model ?? null,
      aspectRatio: preset?.aspect_ratio ?? null,
      voiceProvider: preset?.voice_provider ?? null,
      voiceId: preset?.voice_id ?? null,
      stockFolder: preset?.stock_folder ?? null,
      hybridFreshMinutes: preset?.hybrid_fresh_minutes ?? null,
    },
  });
}
