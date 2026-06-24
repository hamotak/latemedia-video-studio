import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/video-engine/init";
import { listBRollClips } from "@/lib/video-engine/local-output";
import { requireVideoEditUser } from "@/lib/video-access";
import { parseOptionalChannelId } from "../generate/_shared";

export const runtime = "nodejs";

function stockJson(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store");
  return NextResponse.json(body, { ...init, headers });
}

/**
 * GET /api/video/stock/list — the active channel's B-roll clips from the local
 * library (~/Desktop/Late Media Videos/<Channel>/B-Rolls). No Google Drive.
 */
export async function GET(req: Request) {
  const parsedChannelId = parseOptionalChannelId(new URL(req.url).searchParams.get("channelId"));
  if (!parsedChannelId.ok) return parsedChannelId.response;
  const gate = await requireVideoEditUser(parsedChannelId.value);
  if (!gate) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  ensureInit();
  if (!gate.channel) {
    return stockJson(
      { folder: null, count: 0, clips: [], message: "Pick a channel to load its B-roll folder." },
      { status: 200 }
    );
  }

  const folder = gate.channel.name;
  const clips = listBRollClips(folder).map((clip, index) => ({
    ...clip,
    displayName: clip.displayName || clip.name,
    index,
    reviewStatus: "unreviewed" as const,
  }));

  return stockJson({
    folder,
    cacheFolder: folder,
    count: clips.length,
    source: "local",
    clips,
    message: null,
  });
}
