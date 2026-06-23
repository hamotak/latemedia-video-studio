import { NextResponse } from "next/server";
import db from "@/lib/video-engine/db";
import { ensureInit } from "@/lib/video-engine/init";
import { log } from "@/lib/video-engine/logger";
import { getRunDir } from "@/lib/video-engine/run-paths";
import { getConnectionStatus } from "@/lib/video-engine/services/gdrive";
import { countRawClipsOnDisk } from "@/lib/video-engine/services/scene-assets-disk";
import { rebuildSceneAssetsFromDisk, syncRunToDrive } from "@/lib/video-engine/services/run-upload";
import { driveFileLink, driveFolderLink } from "@/lib/video-engine/services/drive-workspace";
import { readRunExportState } from "@/lib/video-engine/run-export-state";
import { mirrorVideoRun } from "@/lib/video-engine/supabase-video-mirror";
import { requireVideoRunAccess } from "@/lib/video-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface DriveStatus {
  syncEnabled: boolean;
  connected: boolean;
  synced: boolean;
  syncedAt?: string;
  clipsFolderId?: string;
  finalVideoId?: string;
  clipsFolderLink?: string;
  finalVideoLink?: string;
  canRetry: boolean;
  rawClipsRemainCount: number;
}

const getRun = db.prepare(
  "SELECT id, status, folder_name, config_json, drive_clips_folder_id, drive_final_video_id, drive_synced_at FROM runs WHERE id = ?"
);

function runMode(configJson: string | null): string {
  if (!configJson) return "hybrid";
  try {
    const cfg = JSON.parse(configJson) as { mode?: string };
    return typeof cfg.mode === "string" ? cfg.mode : "hybrid";
  } catch {
    return "hybrid";
  }
}

function buildLinks(clipsFolderId?: string | null, finalVideoId?: string | null) {
  return {
    clipsFolderLink: driveFolderLink(clipsFolderId) ?? undefined,
    finalVideoLink: driveFileLink(finalVideoId) ?? undefined,
  };
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  ensureInit();
  const { id } = await ctx.params;
  const access = await requireVideoRunAccess(id);
  if (!access.ok) {
    return NextResponse.json(
      { error: access.status === 404 ? "Run not found" : "Forbidden" },
      { status: access.status }
    );
  }

  const row = getRun.get(id) as
    | {
        id: string;
        status: string;
        folder_name: string | null;
        config_json: string | null;
        drive_clips_folder_id: string | null;
        drive_final_video_id: string | null;
        drive_synced_at: string | null;
      }
    | undefined;

  if (!row) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  const gdrive = await getConnectionStatus();
  const runDir = getRunDir(id);
  const rawClipsRemainCount = countRawClipsOnDisk(runDir);

  const status: DriveStatus = {
    syncEnabled: gdrive.syncEnabled,
    connected: gdrive.connected,
    synced: !!row.drive_clips_folder_id || !!row.drive_final_video_id,
    syncedAt: row.drive_synced_at ?? undefined,
    clipsFolderId: row.drive_clips_folder_id ?? undefined,
    finalVideoId: row.drive_final_video_id ?? undefined,
    ...buildLinks(row.drive_clips_folder_id, row.drive_final_video_id),
    canRetry: rawClipsRemainCount > 0 && readRunExportState(id, "done", { mode: runMode(row.config_json) }).finalReady,
    rawClipsRemainCount,
  };

  return NextResponse.json(status, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  ensureInit();
  const { id } = await ctx.params;
  const access = await requireVideoRunAccess(id, { edit: true });
  if (!access.ok) {
    return NextResponse.json(
      { error: access.status === 404 ? "Run not found" : "Forbidden" },
      { status: access.status }
    );
  }

  const row = getRun.get(id) as { id: string; status: string; folder_name: string | null; config_json: string | null } | undefined;
  if (!row) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  const gdrive = await getConnectionStatus();
  if (!gdrive.connected) {
    return NextResponse.json(
      { error: "Google Drive is not connected. Open Settings and connect first." },
      { status: 400 }
    );
  }

  const runDir = getRunDir(id);
  const exportState = readRunExportState(id, row.status, { mode: runMode(row.config_json) });
  const finalPath = exportState.finalPath;
  if (!exportState.finalFileExists) {
    return NextResponse.json({ error: "Final video not found on disk — cannot sync." }, { status: 400 });
  }
  if (!exportState.finalReady) {
    return NextResponse.json(
      {
        error: exportState.finalNeedsRepair
          ? "Final video needs chunk repair before Drive sync."
          : "Final video is not export-ready yet.",
      },
      { status: 409 }
    );
  }

  const sceneAssets = rebuildSceneAssetsFromDisk(runDir);
  log(id, "info", `Manual Drive re-sync requested (${sceneAssets.length} scenes on disk)`, {
    stage: "gdrive",
  });

  try {
    const ok = await syncRunToDrive(id, sceneAssets, runDir, finalPath, { force: true });
    if (!ok) {
      return NextResponse.json({ error: "Sync skipped — connection unavailable mid-flight." }, { status: 500 });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  const updated = getRun.get(id) as {
    drive_clips_folder_id: string | null;
    drive_final_video_id: string | null;
    drive_synced_at: string | null;
  };
  if (!updated.drive_final_video_id) {
    return NextResponse.json(
      { error: "Drive sync completed but the final Drive file ID was not saved." },
      { status: 500 }
    );
  }
  try {
    await mirrorVideoRun(id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `Drive metadata was saved locally but not mirrored to Supabase: ${msg}` }, { status: 500 });
  }
  return NextResponse.json({
    ok: true,
    syncedAt: updated.drive_synced_at,
    clipsFolderId: updated.drive_clips_folder_id,
    finalVideoId: updated.drive_final_video_id,
    ...buildLinks(updated.drive_clips_folder_id, updated.drive_final_video_id),
  });
}
