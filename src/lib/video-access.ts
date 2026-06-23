import { createClient } from "@/lib/supabase/server";
import {
  getActiveChannelId,
  getChannel,
  getUserChannelFeatures,
  listChannels,
  listChannelsForUser,
  type Channel,
} from "@/lib/channels-store";
import { getAuthedUser, type AuthedUser } from "@/lib/supabase/auth";
import { userCanEditFeature } from "@/lib/role-permissions-store";
import { extractRole, isAdmin } from "@/lib/permissions";
import db from "@/lib/video-engine/db";

const getRunStmt = db.prepare("SELECT id, channel_id, preset_name FROM runs WHERE id = ?");

/**
 * Gate for the Video pipeline API. Returns the user if they may use Video on
 * their active channel: admins always, employees only with the `video`
 * feature granted on the channel they currently have selected.
 */
export async function requireVideoAccess() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  if (isAdmin(extractRole(user))) return user;

  const channelId = await getActiveChannelId(user.id);
  if (!channelId) return null;
  const features = await getUserChannelFeatures(user.id, channelId);
  return features.video ? user : null;
}

/**
 * Stricter gate used by the Studio video tool routes.
 */
export async function requireVideoEditUser(channelId?: number | null): Promise<{
  user: AuthedUser;
  channelId: number | null;
  channel: Channel | null;
} | null> {
  const user = await getAuthedUser();
  if (!user) return null;

  if (!(await userCanEditFeature(user, "video"))) return null;

  const admin = isAdmin(extractRole(user));
  const resolvedChannelId = channelId ?? (await getActiveChannelId(user.id));

  if (!admin) {
    if (!resolvedChannelId) return null;
    const features = await getUserChannelFeatures(user.id, resolvedChannelId);
    if (!features.video) return null;
  }

  const channel = resolvedChannelId ? await getChannel(resolvedChannelId) : null;
  if (resolvedChannelId && !channel) return null;
  return { user, channelId: resolvedChannelId, channel };
}

export async function requireVideoChannelAccess(
  channelId: number | null | undefined,
  opts: { edit?: boolean } = {}
): Promise<{
  user: AuthedUser;
  channelId: number | null;
  channel: Channel | null;
} | null> {
  if (opts.edit) return requireVideoEditUser(channelId);

  const user = await getAuthedUser();
  if (!user) return null;

  const admin = isAdmin(extractRole(user));
  const resolvedChannelId = channelId ?? (await getActiveChannelId(user.id));
  if (!admin) {
    if (!resolvedChannelId) return null;
    const features = await getUserChannelFeatures(user.id, resolvedChannelId);
    if (!features.video) return null;
  }

  const channel = resolvedChannelId ? await getChannel(resolvedChannelId) : null;
  if (resolvedChannelId && !channel) return null;
  return { user, channelId: resolvedChannelId, channel };
}

export async function requireVideoRunAccess(
  runId: string,
  opts: { edit?: boolean } = {}
): Promise<
  | { ok: true; user: AuthedUser; channelId: number | null; channel: Channel | null }
  | { ok: false; status: 403 | 404 }
> {
  const row = getRunStmt.get(runId) as
    | { id: string; channel_id: number | null; preset_name: string | null }
    | undefined;
  if (!row) return { ok: false, status: 404 };

  const user = await getAuthedUser();
  if (!user) return { ok: false, status: 403 };
  const admin = isAdmin(extractRole(user));
  const channelId = await resolveRunChannelId(row, user, admin);
  const gate = opts.edit
    ? await requireVideoEditUser(channelId)
    : await requireVideoChannelAccess(channelId);
  return gate ? { ok: true, ...gate } : { ok: false, status: 403 };
}

async function resolveRunChannelId(
  row: { channel_id: number | null; preset_name: string | null },
  user: AuthedUser,
  admin: boolean
): Promise<number | null> {
  if (Number.isFinite(row.channel_id) && Number(row.channel_id) > 0) return Number(row.channel_id);

  const presetChannelId = channelIdFromPresetName(row.preset_name);
  if (presetChannelId) return presetChannelId;

  const presetName = normalizeName(row.preset_name);
  if (!presetName) return null;
  const channels = admin ? await listChannels() : await listChannelsForUser(user.id);
  return channels.find((channel) => normalizeName(channel.name) === presetName)?.id ?? null;
}

let promptPresetStudioColumn: boolean | null = null;

function channelIdFromPresetName(presetName: string | null): number | null {
  const name = presetName?.trim();
  if (!name) return null;
  try {
    if (promptPresetStudioColumn == null) {
      const cols = db.prepare("PRAGMA table_info(prompt_presets)").all() as { name: string }[];
      promptPresetStudioColumn = cols.some((col) => col.name === "studio_channel_id");
    }
    if (!promptPresetStudioColumn) return null;
    const row = db
      .prepare("SELECT studio_channel_id FROM prompt_presets WHERE name = ?")
      .get(name) as { studio_channel_id: number | null } | undefined;
    const id = Number(row?.studio_channel_id ?? 0);
    return Number.isFinite(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

function normalizeName(value: string | null): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}
