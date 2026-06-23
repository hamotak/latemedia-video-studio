import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/auth";
import { listChannels } from "@/lib/channels-store";

export const runtime = "nodejs";

async function requireAdmin() {
  const user = await getAuthedUser();
  const role = user?.app_metadata?.role;
  if (!user || role !== "admin") return null;
  return user;
}

/**
 * Slim, local dashboard summary. The standalone build has no users or boards,
 * so those counts are zero; channel data comes straight from local SQLite.
 * Shape matches what the Dashboard UI reads (`users`, `totals`, `channels`).
 */
export async function GET() {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const channels = await listChannels();

  return NextResponse.json({
    users: { total: 1, admins: 1, employees: 0 },
    totals: {
      channels: channels.length,
      boards: 0,
      cards: 0,
      ready: 0,
      blocked: 0,
      pendingThumbnails: 0,
    },
    channels: channels.map((c) => ({
      id: c.id,
      name: c.name,
      handle: c.handle,
      avatar_url: c.avatar_url,
      subscriber_count: c.subscriber_count,
      video_count: c.video_count,
    })),
  });
}
