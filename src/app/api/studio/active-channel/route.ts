import { NextRequest, NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/auth";
import {
  getActiveChannelId,
  setActiveChannel,
  getChannel,
  listChannels,
  isChannelMember,
  getUserChannelFeatures,
  CHANNEL_FEATURES,
  type ChannelFeatures,
} from "@/lib/channels-store";
import { extractRole, isAdmin as roleIsAdmin } from "@/lib/permissions";
import { effectivePermissionsForRole } from "@/lib/role-permissions-store";

export const runtime = "nodejs";

function isAdmin(user: { app_metadata?: Record<string, unknown>; user_metadata?: Record<string, unknown> } | null) {
  return roleIsAdmin(extractRole(user));
}

const ALL_FEATURES: ChannelFeatures = Object.fromEntries(
  CHANNEL_FEATURES.map((f) => [f.key, true])
);

function parseChannelId(rawId: unknown): number | null {
  const id =
    typeof rawId === "number"
      ? rawId
      : typeof rawId === "string"
      ? parseInt(rawId, 10)
      : NaN;
  return Number.isFinite(id) && id > 0 ? id : null;
}

/** GET /api/studio/active-channel — current user's selected channel + their feature access on it. */
export async function GET() {
  const user = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let activeChannelId = await getActiveChannelId(user.id);
  let channel = activeChannelId ? await getChannel(activeChannelId) : null;

  if ((!activeChannelId || !channel) && isAdmin(user)) {
    channel = (await listChannels())[0] ?? null;
    activeChannelId = channel?.id ?? null;
    if (activeChannelId) {
      try {
        await setActiveChannel(user.id, activeChannelId);
      } catch {
        // Fallback selection still works for this response even if persistence fails.
      }
    }
  }

  // Admins have every feature everywhere; employees get their per-channel grant.
  const features: ChannelFeatures = isAdmin(user)
    ? ALL_FEATURES
    : activeChannelId
      ? await getUserChannelFeatures(user.id, activeChannelId)
      : {};
  // The role's view/edit level per tool (admin ⇒ all "edit"). The sidebar
  // layers this with `features`: a tool shows only if the channel grants it
  // AND the role allows it.
  const permissions = await effectivePermissionsForRole(extractRole(user));
  return NextResponse.json({ activeId: activeChannelId, activeChannelId, channel, features, permissions });
}

/** POST /api/studio/active-channel — switch the active channel. */
export async function POST(req: NextRequest) {
  const user = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { channelId?: unknown; id?: unknown };
  const channelId = parseChannelId(body.channelId ?? body.id);
  if (!channelId) {
    return NextResponse.json({ error: "channelId is required" }, { status: 400 });
  }

  const channel = await getChannel(channelId);
  if (!channel) return NextResponse.json({ error: "Unknown channel" }, { status: 404 });

  // Employees can only switch to channels they're assigned to.
  if (!isAdmin(user) && !(await isChannelMember(user.id, channelId))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  await setActiveChannel(user.id, channelId);

  // Include features + permissions in the POST response so the client
  // needs only this one round-trip to complete a channel switch.
  const features: ChannelFeatures = isAdmin(user)
    ? ALL_FEATURES
    : await getUserChannelFeatures(user.id, channelId);
  const permissions = await effectivePermissionsForRole(extractRole(user));

  return NextResponse.json({ activeId: channelId, activeChannelId: channelId, channel, features, permissions });
}
