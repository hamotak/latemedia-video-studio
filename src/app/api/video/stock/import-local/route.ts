import fs from "node:fs";
import path from "node:path";
import { uploadFile } from "@/lib/video-engine/services/gdrive";
import { ensureChannelStockBrollFolder } from "@/lib/video-engine/services/drive-workspace";
import {
  listLocalCachedClips,
  listStockClips,
} from "@/lib/video-engine/services/stock-library";
import {
  isResponse,
  parseOptionalChannelId,
  requireActiveStockContext,
  stockJson,
} from "../generate/_shared";

export const runtime = "nodejs";

function cachedDriveId(filePath: string): string | null {
  const base = path.basename(filePath);
  const marker = base.indexOf("__");
  if (marker <= 0) return null;
  return base.slice(0, marker);
}

function safeDriveName(localPath: string): string {
  const base = path.basename(localPath).replace(/[^a-zA-Z0-9._-]/g, "_");
  return base.toLowerCase().endsWith(".mp4") ? base : `${base}.mp4`;
}

function removeLocalClip(localPath: string): void {
  fs.rmSync(localPath, { force: true });
  const sidecar = localPath.replace(/\.mp4$/i, ".manifest.json");
  if (sidecar !== localPath) fs.rmSync(sidecar, { force: true });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { channelId?: unknown };
  const parsedChannelId = parseOptionalChannelId(body.channelId);
  if (!parsedChannelId.ok) return parsedChannelId.response;
  const ctx = await requireActiveStockContext(parsedChannelId.value);
  if (isResponse(ctx)) return ctx;

  const errors: string[] = [];
  let imported = 0;
  let purged = 0;
  let kept = 0;
  const uploaded: string[] = [];

  try {
    const [driveClips, primary] = await Promise.all([
      listStockClips(ctx.stockFolder, { channelName: ctx.channelName }),
      ensureChannelStockBrollFolder(ctx.channelName),
    ]);
    const driveIds = new Set(driveClips.map((clip) => clip.driveFileId));
    const localRows = listLocalCachedClips(ctx.stockFolder);

    for (const row of localRows) {
      const localPath = row.localPath;
      const driveId = cachedDriveId(localPath);
      try {
        if (driveId && driveIds.has(driveId)) {
          kept++;
          continue;
        }
        if (driveId && !driveIds.has(driveId)) {
          removeLocalClip(localPath);
          purged++;
          continue;
        }
        const newId = await uploadFile(localPath, primary.id, {
          name: safeDriveName(localPath),
          mimeType: "video/mp4",
        });
        uploaded.push(newId);
        imported++;
        removeLocalClip(localPath);
      } catch (e) {
        errors.push(`${path.basename(localPath)}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 180));
      }
    }

    return stockJson({
      imported,
      purged,
      kept,
      uploaded,
      failed: errors.length,
      errors,
      driveFolderId: primary.id,
      driveFolderLink: primary.link,
    });
  } catch (e) {
    return stockJson({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
