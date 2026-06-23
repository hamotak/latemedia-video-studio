import "server-only";

import { NextResponse } from "next/server";
import {
  getActiveChannelId,
  getChannel,
  getChannelByYoutubeId,
  getUserChannelFeatures,
  isChannelMember,
  listChannels,
  listChannelsForUser,
  type Channel,
} from "@/lib/channels-store";
import {
  canEditLevel,
  canView,
  extractRole,
  isAdmin,
  type FeatureKey,
  type PermissionLevel,
} from "@/lib/permissions";
import { getRoleFeatureLevel } from "@/lib/role-permissions-store";
import { getAuthedUser, type AuthedUser } from "@/lib/supabase/auth";

export type AccessLevel = "view" | "edit";

export type AccessFailure = {
  ok: false;
  status: 401 | 403;
  error: string;
};

export type FeatureAccess = AccessFailure | {
  ok: true;
  user: AuthedUser;
  role: string;
  channelId: number | null;
  channel: Channel | null;
};

export type FeatureChannelListAccess = AccessFailure | {
  ok: true;
  user: AuthedUser;
  role: string;
  channels: Channel[];
};

function unauthenticated(): AccessFailure {
  return { ok: false, status: 401, error: "Unauthorized" };
}

function forbidden(error = "Forbidden"): AccessFailure {
  return { ok: false, status: 403, error };
}

function roleAllows(feature: FeatureKey, requested: AccessLevel, level: PermissionLevel): boolean {
  if (feature === "board") return level !== "none";
  return requested === "edit" ? canEditLevel(level) : canView(level);
}

export function accessResponse(access: AccessFailure, fallback = "Forbidden") {
  return NextResponse.json(
    { error: access.status === 401 ? "Unauthorized" : access.error || fallback },
    { status: access.status }
  );
}

export async function requireAdminAccess(): Promise<
  AccessFailure | { ok: true; user: AuthedUser; role: string }
> {
  const user = await getAuthedUser();
  if (!user) return unauthenticated();
  const role = extractRole(user);
  if (!isAdmin(role)) return forbidden("Admin access required.");
  return { ok: true, user, role };
}

export async function requireChannelMembership(channelId: number): Promise<FeatureAccess> {
  const user = await getAuthedUser();
  if (!user) return unauthenticated();
  const role = extractRole(user);
  const channel = await getChannel(channelId);
  if (!channel) return forbidden("Channel access required.");
  if (!isAdmin(role) && !(await isChannelMember(user.id, channelId))) {
    return forbidden("Channel access required.");
  }
  return { ok: true, user, role, channelId, channel };
}

export async function requireFeatureAccess(
  feature: FeatureKey,
  opts: {
    level?: AccessLevel;
    channelId?: number | null;
    requireChannel?: boolean;
  } = {}
): Promise<FeatureAccess> {
  const user = await getAuthedUser();
  if (!user) return unauthenticated();

  const role = extractRole(user);
  const admin = isAdmin(role);
  const requestedLevel = opts.level ?? "view";
  if (!admin) {
    const roleLevel = await getRoleFeatureLevel(role, feature);
    if (!roleAllows(feature, requestedLevel, roleLevel)) {
      return forbidden(
        requestedLevel === "edit" ? "Feature edit access required." : "Feature access required."
      );
    }
  }

  let resolvedChannelId =
    opts.channelId !== undefined ? opts.channelId : await getActiveChannelId(user.id);

  if (!resolvedChannelId && admin && opts.requireChannel) {
    resolvedChannelId = (await listChannels())[0]?.id ?? null;
  }

  if (!resolvedChannelId) {
    return opts.requireChannel
      ? forbidden("Channel access required.")
      : { ok: true, user, role, channelId: null, channel: null };
  }

  const channel = await getChannel(resolvedChannelId);
  if (!channel) return forbidden("Channel access required.");

  if (!admin) {
    if (!(await isChannelMember(user.id, resolvedChannelId))) {
      return forbidden("Channel access required.");
    }
    const features = await getUserChannelFeatures(user.id, resolvedChannelId);
    if (!features[feature]) {
      return forbidden("Feature access required.");
    }
  }

  return { ok: true, user, role, channelId: resolvedChannelId, channel };
}

export async function requireLegacyChannelFeatureAccess(
  feature: FeatureKey,
  youtubeChannelId: string | null | undefined,
  opts: { level?: AccessLevel } = {}
): Promise<FeatureAccess> {
  if (!youtubeChannelId) {
    return requireFeatureAccess(feature, {
      level: opts.level,
      requireChannel: true,
    });
  }
  const channel = await getChannelByYoutubeId(youtubeChannelId);
  if (channel) {
    return requireFeatureAccess(feature, {
      level: opts.level,
      channelId: channel.id,
      requireChannel: true,
    });
  }

  const admin = await requireAdminAccess();
  if (!admin.ok) return admin;
  return {
    ok: true,
    user: admin.user,
    role: admin.role,
    channelId: null,
    channel: null,
  };
}

export async function requireAnyLegacyChannelFeatureAccess(
  features: FeatureKey[],
  youtubeChannelId: string | null | undefined,
  opts: { level?: AccessLevel } = {}
): Promise<FeatureAccess> {
  let lastFailure: AccessFailure = forbidden("Feature access required.");
  for (const feature of features) {
    const access = await requireLegacyChannelFeatureAccess(feature, youtubeChannelId, opts);
    if (access.ok) return access;
    lastFailure = access;
  }
  return lastFailure;
}

export async function listFeatureChannelsForUser(
  feature: FeatureKey,
  level: AccessLevel = "view"
): Promise<FeatureChannelListAccess> {
  const user = await getAuthedUser();
  if (!user) return unauthenticated();

  const role = extractRole(user);
  if (isAdmin(role)) {
    return { ok: true, user, role, channels: await listChannels() };
  }

  const roleLevel = await getRoleFeatureLevel(role, feature);
  if (!roleAllows(feature, level, roleLevel)) {
    return { ok: true, user, role, channels: [] };
  }

  const channels = await listChannelsForUser(user.id);
  const allowed: Channel[] = [];
  for (const channel of channels) {
    const features = await getUserChannelFeatures(user.id, channel.id);
    if (features[feature]) allowed.push(channel);
  }
  return { ok: true, user, role, channels: allowed };
}
