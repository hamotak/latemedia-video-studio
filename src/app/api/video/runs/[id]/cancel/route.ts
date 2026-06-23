import { NextResponse } from "next/server";
import db from "@/lib/video-engine/db";
import { ensureInit } from "@/lib/video-engine/init";
import {
  cancelLocalProcesses,
  getActiveJobs,
  getActiveLocalProcesses,
  markCancelled,
} from "@/lib/video-engine/cancellation";
import { cancelJob } from "@/lib/video-engine/services/labs69";
import { log } from "@/lib/video-engine/logger";
import { isRunWorkerActive } from "@/lib/video-engine/pipeline";
import { mirrorVideoRun } from "@/lib/video-engine/supabase-video-mirror";
import { requireVideoRunAccess } from "@/lib/video-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const getRun = db.prepare("SELECT id, status FROM runs WHERE id = ?");
const updateStatus = db.prepare(
  "UPDATE runs SET status = ?, updated_at = datetime('now') WHERE id = ?"
);

export async function POST(_: Request, ctx: { params: Promise<{ id: string }> }) {
  ensureInit();
  const { id } = await ctx.params;
  const access = await requireVideoRunAccess(id, { edit: true });
  if (!access.ok) {
    return NextResponse.json(
      { error: access.status === 404 ? "run not found" : "Forbidden" },
      { status: access.status }
    );
  }
  const row = getRun.get(id) as { id: string; status: string } | undefined;
  if (!row) return NextResponse.json({ error: "run not found" }, { status: 404 });

  const jobs = getActiveJobs(id);
  const localProcesses = getActiveLocalProcesses(id);
  const workerActive = isRunWorkerActive(id);
  if (row.status === "running" || row.status === "pending" || workerActive || jobs.length > 0 || localProcesses.length > 0) {
    markCancelled(id);
    if (row.status === "running" || row.status === "pending") {
      updateStatus.run("cancelled", id);
    }

    if (jobs.length > 0) {
      log(id, "warn", `Cancelling ${jobs.length} active 69labs job(s)...`, { stage: "pipeline" });
      await Promise.all(
        jobs.map(async (j) => {
          try {
            const ok = await cancelJob(j.kind, j.jobId);
            log(id, "info", `Cancel ${j.kind} ${j.jobId.slice(0, 8)} -> ${ok ? "ok" : "skipped"}`, {
              stage: "pipeline",
            });
          } catch (e) {
            log(id, "warn", `Cancel ${j.kind} ${j.jobId.slice(0, 8)} failed: ${e instanceof Error ? e.message : String(e)}`, {
              stage: "pipeline",
            });
          }
        })
      );
    }
    if (localProcesses.length > 0) {
      const stopped = cancelLocalProcesses(id);
      log(id, "warn", `Stopping ${stopped.length} local ffmpeg/process task(s)...`, {
        stage: "pipeline",
        data: { processes: stopped.map((p) => ({ label: p.label, pid: p.pid ?? null })) },
      });
    }
    log(id, "warn", "Cancelled by user", { stage: "pipeline" });
    await mirrorVideoRun(id).catch(() => {});
  }

  return NextResponse.json({
    ok: true,
    previousStatus: row.status,
    providerJobs: jobs.length,
    localProcesses: localProcesses.length,
  });
}
