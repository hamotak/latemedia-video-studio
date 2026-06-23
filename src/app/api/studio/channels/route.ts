import { NextRequest, NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/auth";
import { listChannels, listChannelsForUser, createChannel, getChannelByYoutubeId, updateChannel } from "@/lib/channels-store";
import { getConnectionStatus } from "@/lib/video-engine/services/gdrive";
import { ensureChannelWorkspace } from "@/lib/video-engine/services/drive-workspace";
import { extractRole, isAdmin as roleIsAdmin } from "@/lib/permissions";

export const runtime = "nodejs";

function isAdmin(user: { app_metadata?: Record<string, unknown>; user_metadata?: Record<string, unknown> } | null) {
  return roleIsAdmin(extractRole(user));
}

async function ensureDriveWorkspaceForChannel(name: string): Promise<void> {
  try {
    const connection = await getConnectionStatus();
    if (connection.connected) await ensureChannelWorkspace(name);
  } catch {
    // Channel creation should never fail because Drive setup needs attention.
  }
}

/**
 * GET /api/studio/channels — channels the signed-in user can switch to.
 * Admins see every channel; employees see only the ones they're assigned to.
 */
export async function GET() {
  const user = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const channels = isAdmin(user)
    ? await listChannels()
    : await listChannelsForUser(user.id);
  return NextResponse.json({ channels });
}

/** POST /api/studio/channels — admin creates a channel. */
export async function POST(req: NextRequest) {
  const user = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAdmin(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as {
    name?: string;
    handle?: string | null;
    youtube_channel_id?: string | null;
    avatar_url?: string | null;
    description?: string | null;
    subscriber_count?: number | null;
    video_count?: number | null;
  };
  if (!body.name?.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  const avatarUrl = body.avatar_url?.trim() || null;

  // Idempotent on the YouTube link: if a channel is already bound to this
  // YouTube id, return it instead of creating a duplicate. Lets the legacy
  // binder and the studio "Add & sync" flow safely re-run. Backfill the
  // avatar/handle if a re-sync now has them and the saved row was missing them.
  const ytId = body.youtube_channel_id?.trim() || null;
  if (ytId) {
    const existing = await getChannelByYoutubeId(ytId);
    if (existing) {
      const patch: {
        avatar_url?: string | null;
        handle?: string | null;
        subscriber_count?: number | null;
        video_count?: number | null;
      } = {};
      if (!existing.avatar_url && avatarUrl) patch.avatar_url = avatarUrl;
      if (!existing.handle && body.handle) patch.handle = body.handle;
      if (typeof body.subscriber_count === "number") patch.subscriber_count = body.subscriber_count;
      if (typeof body.video_count === "number") patch.video_count = body.video_count;
      const channel =
        Object.keys(patch).length > 0 ? (await updateChannel(existing.id, patch)) ?? existing : existing;
      await ensureDriveWorkspaceForChannel(channel.name);
      return NextResponse.json({ channel }, { status: 200 });
    }
  }

  const channel = await createChannel({
    name: body.name.trim(),
    handle: body.handle ?? null,
    youtube_channel_id: ytId,
    avatar_url: avatarUrl,
    description: body.description ?? null,
    subscriber_count: typeof body.subscriber_count === "number" ? body.subscriber_count : null,
    video_count: typeof body.video_count === "number" ? body.video_count : null,
  });
  await ensureDriveWorkspaceForChannel(channel.name);
  return NextResponse.json({ channel }, { status: 201 });
}
