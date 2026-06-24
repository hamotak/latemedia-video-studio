import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/video-engine/init";
import { resolveChannelStockFolder } from "@/lib/video-engine/channel-stock";
import {
  stockClipDisplayName,
  type StockGenClipStep,
  type StockGenStatus,
} from "@/lib/video-engine/services/stock-gen";
import { requireVideoEditUser } from "@/lib/video-access";
import { loadAppSettingsIntoCache } from "@/lib/app-settings-store";
import { loadProviderSecretsIntoCache } from "@/lib/provider-secrets-store";

export interface ActiveStockContext {
  userId: string;
  channelId: number;
  channelName: string;
  stockFolder: string;
  channelVideoStyle: string | null;
}

export function stockJson(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store");
  return NextResponse.json(body, { ...init, headers });
}

export function parseOptionalChannelId(value: unknown): { ok: true; value: number | null } | { ok: false; response: NextResponse } {
  if (value == null || value === "") return { ok: true, value: null };
  const id = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(id) || id <= 0) {
    return { ok: false, response: stockJson({ error: "Invalid channelId" }, { status: 400 }) };
  }
  return { ok: true, value: Math.floor(id) };
}

function toStyleString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  return null;
}

export async function requireActiveStockContext(channelId?: number | null): Promise<ActiveStockContext | NextResponse> {
  const gate = await requireVideoEditUser(channelId);
  if (!gate) {
    return stockJson({ error: "Forbidden" }, { status: 403 });
  }
  if (!gate.channel || !gate.channelId) {
    return stockJson({ error: "Pick a channel before using B-roll generation." }, { status: 400 });
  }

  await Promise.all([
    loadProviderSecretsIntoCache(),
    loadAppSettingsIntoCache(),
  ]);
  ensureInit();

  return {
    userId: gate.user.id,
    channelId: gate.channelId,
    channelName: gate.channel.name,
    stockFolder: resolveChannelStockFolder(gate.channel.name, gate.channel.stock_folder),
    channelVideoStyle: toStyleString(gate.channel.video_style),
  };
}

export function isResponse(value: ActiveStockContext | NextResponse): value is NextResponse {
  return value instanceof NextResponse;
}

export function statusBelongsToContext(status: StockGenStatus | null, ctx: ActiveStockContext): boolean {
  if (!status) return true;
  if (status.channelId != null && String(status.channelId) !== String(ctx.channelId)) return false;
  if (status.channelName && status.channelName !== ctx.channelName) return false;
  return true;
}

export type PublicStockGenClipStep = StockGenClipStep & {
  displayName: string;
  imageUrl?: string;
  posterUrl?: string;
  videoUrl?: string;
  driveFileLink?: string | null;
};

export type PublicStockGenStatus = Omit<StockGenStatus, "clips"> & {
  clips?: PublicStockGenClipStep[];
};

function assetUrl(jobId: string, index: number, kind: "image" | "video", channelId?: number | string | null): string {
  const params = new URLSearchParams({
    jobId,
    index: String(index),
    kind,
  });
  if (channelId != null) params.set("channelId", String(channelId));
  return `/api/video/stock/generate/asset?${params.toString()}`;
}

export function publicStockGenStatus(status: StockGenStatus): PublicStockGenStatus {
  const jobId = status.jobId;
  return {
    ...status,
    clips: (status.clips ?? []).filter((clip) => clip.status !== "deleted").map((clip) => {
      const {
        imagePath: _imagePath,
        videoPath: _videoPath,
        ...publicClip
      } = clip;
      const displayName = clip.displayName || stockClipDisplayName(clip.index);
      const driveLink = clip.driveFileLink !== undefined ? clip.driveFileLink : null;
      const videoUrl = clip.driveFileId
        ? `/api/video/stock/file?id=${encodeURIComponent(clip.driveFileId)}`
        : clip.videoPath
          ? assetUrl(jobId, clip.index, "video", status.channelId)
          : undefined;
      const imageUrl = clip.imagePath ? assetUrl(jobId, clip.index, "image", status.channelId) : undefined;
      return {
        ...publicClip,
        displayName,
        driveFileLink: driveLink,
        imageUrl,
        posterUrl: clip.driveFileId
          ? `/api/video/stock/poster?${new URLSearchParams({
              id: clip.driveFileId,
              folder: status.folder,
              name: clip.driveName || `${displayName}.mp4`,
            }).toString()}`
          : imageUrl,
        videoUrl,
      };
    }),
  };
}
