import { NextResponse } from "next/server";
import path from "node:path";
import { ensureInit } from "@/lib/video-engine/init";
import { resolveChannelStockFolder } from "@/lib/video-engine/channel-stock";
import { getSetting } from "@/lib/video-engine/settings";
import { channelStockBrollFolderName, driveFileLink } from "@/lib/video-engine/services/drive-workspace";
import { listStockGenerationHistory, stockClipDisplayName } from "@/lib/video-engine/services/stock-gen";
import {
  isDriveAuthError,
  listChannelStockClips,
  listLocalCachedClips,
  listLocalStockFolders,
  mergeDriveAndLocalStockClips,
} from "@/lib/video-engine/services/stock-library";
import { requireVideoEditUser } from "@/lib/video-access";
import { parseOptionalChannelId } from "../generate/_shared";

export const runtime = "nodejs";

const DRIVE_TIMEOUT_MS = 30000;

function stockJson(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store");
  return NextResponse.json(body, { ...init, headers });
}

function cachedDriveId(filePath: string): string | null {
  const base = path.basename(filePath);
  const marker = base.indexOf("__");
  if (marker <= 0) return null;
  return base.slice(0, marker);
}

function fallbackDisplayName(index: number): string {
  return stockClipDisplayName(index);
}

function withTimeout<T>(label: string, promise: Promise<T>, timeoutMs = DRIVE_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s. Reconnect Drive or try again.`)),
      timeoutMs
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * GET /api/video/stock/list — list the active channel's Drive B-roll clips.
 *
 * Active Studio channels always use their canonical channel B-roll root:
 * Late Media Editing Tool / Channels / <channel> / <channel> B-rolls.
 * Legacy folders are reported separately so they do not pollute the channel grid.
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

  const cacheFolder = resolveChannelStockFolder(
    gate.channel.name,
    gate.channel.stock_folder
  );
  const displayFolder = channelStockBrollFolderName(gate.channel.name);

  const started = Date.now();
  const listedAt = new Date().toISOString();
  const localFolders = listLocalStockFolders();
  const connectedEmail = getSetting("GDRIVE_CONNECTED_EMAIL") || null;
  try {
    const stock = await withTimeout(
      "Drive clip list",
      listChannelStockClips(gate.channel.name, {
        legacyFolders: [cacheFolder, gate.channel.stock_folder],
        includeLegacy: false,
      })
    );
    const driveClips = stock.clips;
    const localRows = listLocalCachedClips(cacheFolder);
    const driveIds = new Set(driveClips.map((c) => c.driveFileId));
    const localOnlyCount = localRows.filter((row) => !cachedDriveId(row.localPath)).length;
    const staleCacheCount = localRows.filter((row) => {
      const id = cachedDriveId(row.localPath);
      return !!id && !driveIds.has(id);
    }).length;
    const jobMetaByDriveId = new Map<
      string,
      {
        displayName: string;
        jobId: string;
        index: number;
        prompt: string;
        reviewStatus: "unreviewed" | "good" | "weak" | "needs_review";
        driveFileLink: string | null;
      }
    >();
    for (const job of listStockGenerationHistory({
      channelId: gate.channelId ? String(gate.channelId) : undefined,
      folder: cacheFolder,
      limit: 100,
    })) {
      for (const step of job.clips ?? []) {
        if (!step.driveFileId) continue;
        jobMetaByDriveId.set(step.driveFileId, {
          displayName: step.displayName || stockClipDisplayName(step.index),
          jobId: job.jobId,
          index: step.index,
          prompt: step.prompt,
          reviewStatus: step.reviewStatus || "unreviewed",
          driveFileLink: step.driveFileLink ?? driveFileLink(step.driveFileId),
        });
      }
    }
    const clips = mergeDriveAndLocalStockClips(driveClips, localRows)
      .filter((clip) => clip.source !== "local")
      .map((clip, index) => {
        const meta = jobMetaByDriveId.get(clip.driveFileId);
        return {
          ...clip,
          displayName: meta?.displayName || fallbackDisplayName(index),
          jobId: meta?.jobId,
          index: meta?.index ?? index,
          prompt: meta?.prompt,
          reviewStatus: meta?.reviewStatus ?? "unreviewed",
          driveFileLink: meta?.driveFileLink ?? driveFileLink(clip.driveFileId),
        };
      });
    return stockJson({
      folder: stock.primaryFolderName,
      cacheFolder,
      count: clips.length,
      driveCount: driveClips.length,
      localOnlyCount,
      staleCacheCount,
      localFolders,
      driveFolderId: stock.primaryFolderId,
      driveFolderLink: stock.primaryFolderLink,
      legacyFoldersFound: stock.legacyFoldersFound,
      quarantinedLegacyFolders: stock.legacyFoldersFound,
      connectedEmail,
      listedAt,
      driveMs: Date.now() - started,
      source: "drive",
      clips,
      message: null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const driveAuth =
      isDriveAuthError(msg) ||
      msg.includes("Google Drive is not connected") ||
      msg.includes("Drive not connected") ||
      msg.includes("deleted_client") ||
      msg.includes("unauthorized_client") ||
      msg.includes("invalid_token");
    return stockJson(
      {
        folder: displayFolder,
        cacheFolder,
        count: 0,
        driveCount: 0,
        localOnlyCount: 0,
        staleCacheCount: 0,
        clips: [],
        localFolders,
        connectedEmail,
        listedAt,
        driveMs: Date.now() - started,
        source: "unavailable",
        errorKind: driveAuth ? "drive_auth" : "stock_list_failed",
        message: driveAuth
          ? "Reconnect Google Drive before clips can be loaded."
          : msg,
        detail: msg,
      },
      { status: driveAuth ? 401 : 400 }
    );
  }
}
