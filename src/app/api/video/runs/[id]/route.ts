import { NextResponse } from "next/server";
import fs from "node:fs";
import db from "@/lib/video-engine/db";
import { getLogs } from "@/lib/video-engine/logger";
import { ensureInit } from "@/lib/video-engine/init";
import { getRunDir } from "@/lib/video-engine/run-paths";
import { isRunWorkerActive, reconcileDeadVideoWorkers } from "@/lib/video-engine/pipeline";
import { driveFileLink, driveFolderLink } from "@/lib/video-engine/services/drive-workspace";
import { requireVideoRunAccess } from "@/lib/video-access";

export const runtime = "nodejs";

const getRun = db.prepare("SELECT * FROM runs WHERE id = ?");
const deleteRunStmt = db.prepare("DELETE FROM runs WHERE id = ?");
const deleteLogsStmt = db.prepare("DELETE FROM run_logs WHERE run_id = ?");

export async function GET(_: Request, ctx: { params: Promise<{ id: string }> }) {
  ensureInit();
  const { id } = await ctx.params;
  const access = await requireVideoRunAccess(id);
  if (!access.ok) {
    return NextResponse.json(
      { error: access.status === 404 ? "not found" : "Forbidden" },
      { status: access.status }
    );
  }
  reconcileDeadVideoWorkers(id);
  const run = getRun.get(id) as Record<string, unknown> | undefined;
  if (!run) return NextResponse.json({ error: "not found" }, { status: 404 });
  const dbStatus = String(run.status ?? "");
  const workerActive = isRunWorkerActive(id);
  const runtimeStatus = workerActive
    ? "running"
    : (dbStatus === "running" || dbStatus === "pending") && !run.output_path
      ? "paused"
      : dbStatus;
  return NextResponse.json({
    run: {
      ...run,
      finalVideoLink: driveFileLink(String(run.drive_final_video_id ?? "")) ?? null,
      clipsFolderLink: driveFolderLink(String(run.drive_clips_folder_id ?? "")) ?? null,
      driveStatus: {
        synced: !!run.drive_final_video_id || !!run.drive_clips_folder_id,
        syncedAt: run.drive_synced_at ?? null,
        finalVideoId: run.drive_final_video_id ?? null,
        clipsFolderId: run.drive_clips_folder_id ?? null,
      },
      db_status: dbStatus,
      status: runtimeStatus,
      worker_active: workerActive,
      needs_recovery: runtimeStatus === "paused",
    },
    logs: getLogs(id),
  });
}

/** Delete a run: its DB row, its logs, and its output folder on disk. */
export async function DELETE(_: Request, ctx: { params: Promise<{ id: string }> }) {
  ensureInit();
  const { id } = await ctx.params;
  const access = await requireVideoRunAccess(id, { edit: true });
  if (!access.ok) {
    return NextResponse.json(
      { error: access.status === 404 ? "not found" : "Forbidden" },
      { status: access.status }
    );
  }
  const run = getRun.get(id) as { status?: string; output_path?: string | null } | undefined;
  if (!run) return NextResponse.json({ error: "not found" }, { status: 404 });
  const active = isRunWorkerActive(id);
  if (active) {
    return NextResponse.json({ error: "Stop the run before deleting it." }, { status: 409 });
  }
  // Remove the output folder (best-effort) before clearing the DB row that maps to it.
  try {
    const dir = getRunDir(id);
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* folder may already be gone */
  }
  try {
    deleteLogsStmt.run(id);
  } catch {
    /* logs table may be empty */
  }
  deleteRunStmt.run(id);
  return NextResponse.json({ deleted: true });
}
