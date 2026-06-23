import { NextResponse } from "next/server";
import path from "node:path";
import fs from "node:fs";
import db from "@/lib/video-engine/db";
import { ensureInit } from "@/lib/video-engine/init";
import { getRunDir } from "@/lib/video-engine/run-paths";
import { isRunWorkerActive } from "@/lib/video-engine/pipeline";
import { countTextChunks } from "@/lib/video-engine/text-chunking";
import { getSetting } from "@/lib/video-engine/settings";
import { buildExportQualityReport } from "@/lib/video-engine/export-quality";
import { analyzeExportScenePlan, readRunExportState } from "@/lib/video-engine/run-export-state";
import { getActiveJobs, getActiveLocalProcesses } from "@/lib/video-engine/cancellation";
import { discoverLabs69AccountLimits } from "@/lib/video-engine/services/labs69";
import { countRawClipsOnDisk } from "@/lib/video-engine/services/scene-assets-disk";
import { requireVideoRunAccess } from "@/lib/video-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const getRun = db.prepare(
  "SELECT id, status, config_json, preset_hybrid_fresh_minutes, drive_clips_folder_id, drive_final_video_id, drive_synced_at FROM runs WHERE id = ?"
);

export type SceneStage = "pending" | "audio" | "image" | "video" | "rendered";

interface SceneAsset {
  index: number;
  text?: string;
  visual_prompt?: string;
  duration_hint_sec?: number;
  source_kind?: "fresh" | "stock" | "image_card";
  stage: SceneStage;
  audio?: { name: string; size: number };
  image?: { name: string; size: number };
  animation?: { name: string; size: number };
  clip?: { name: string; size: number };
}

interface FreshFallbackRecord {
  sceneIndex: number;
  kind: "still-motion" | "stock";
  reason: string;
  createdAt: string;
  path: string;
}

interface DriveSyncReport {
  schema_version?: number;
  run_id?: string;
  synced_at?: string;
  requested_asset_count?: number;
  uploaded_clip_count?: number;
  raw_clip_count_before?: number;
  fallback_count?: number;
  still_motion_fallback_count?: number;
  stock_fallback_count?: number;
  cleanup?: {
    cleaned?: boolean;
    deleted_clip_count?: number;
    reason?: string;
  };
  clips_folder_id?: string;
  final_video_id?: string;
}

interface RunDriveFields {
  drive_clips_folder_id: string | null;
  drive_final_video_id: string | null;
  drive_synced_at: string | null;
}

function countContinuousChunks(text: string, maxChars = 9000): number {
  return countTextChunks(text, { maxChars });
}

function sceneStage(a: Omit<SceneAsset, "stage">): SceneStage {
  if (a.clip) return "rendered";
  if (a.animation) return "video";
  if (a.image) return "image";
  if (a.audio) return "audio";
  return "pending";
}

function readFreshFallbacks(runDir: string): FreshFallbackRecord[] {
  const p = path.join(runDir, "fresh-fallbacks.json");
  if (!fs.existsSync(p)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf-8")) as FreshFallbackRecord[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((row) => Number.isInteger(row.sceneIndex) && row.sceneIndex >= 0);
  } catch {
    return [];
  }
}

function readJsonReport(runDir: string, name: string): Record<string, unknown> | null {
  const p = path.join(runDir, name);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readDriveSyncReport(runDir: string): DriveSyncReport | null {
  return readJsonReport(runDir, "drive-sync-report.json") as DriveSyncReport | null;
}

function buildFallbackSummary(records: FreshFallbackRecord[], providerVideos: number) {
  const stillMotion = records.filter((row) => row.kind === "still-motion").length;
  const stock = records.filter((row) => row.kind === "stock").length;
  const missingRawClipCount = records.filter((row) => !fs.existsSync(row.path)).length;
  return {
    providerVideos,
    total: records.length,
    stillMotion,
    stock,
    missingRawClipCount,
    cleanedRawClipCount: missingRawClipCount,
    scenes: records.map((row) => ({
      sceneIndex: row.sceneIndex,
      kind: row.kind,
      reason: row.reason,
      createdAt: row.createdAt,
      path: row.path,
      existsOnDisk: fs.existsSync(row.path),
    })),
  };
}

function buildRawClipSummary({
  run,
  finalReady,
  rawClipsOnDisk,
  estimatedRawClipCount,
  driveSyncReport,
}: {
  run: RunDriveFields;
  finalReady: boolean;
  rawClipsOnDisk: number;
  estimatedRawClipCount: number;
  driveSyncReport: DriveSyncReport | null;
}) {
  const driveSynced = !!run.drive_clips_folder_id || !!run.drive_final_video_id;
  const cleanedAfterSync =
    !!driveSyncReport?.cleanup?.cleaned ||
    (driveSynced && finalReady && rawClipsOnDisk === 0 && estimatedRawClipCount > 0);
  const cleanupReason =
    driveSyncReport?.cleanup?.reason ??
    (cleanedAfterSync ? "raw clips are no longer on disk after Drive sync" : null);

  return {
    rawClipsOnDisk,
    rawClipsBeforeLastSync:
      driveSyncReport?.raw_clip_count_before ?? (cleanedAfterSync ? estimatedRawClipCount : rawClipsOnDisk),
    uploadedClipCount: driveSyncReport?.uploaded_clip_count ?? null,
    fallbackClipCount: driveSyncReport?.fallback_count ?? null,
    cleanedAfterSync,
    cleanupReason,
    syncAgainAvailable: rawClipsOnDisk > 0 && finalReady,
    driveSynced,
    syncedAt: run.drive_synced_at ?? driveSyncReport?.synced_at ?? null,
    clipsFolderId: run.drive_clips_folder_id ?? driveSyncReport?.clips_folder_id ?? null,
    finalVideoId: run.drive_final_video_id ?? driveSyncReport?.final_video_id ?? null,
  };
}

export async function GET(_: Request, ctx: { params: Promise<{ id: string }> }) {
  ensureInit();
  const { id } = await ctx.params;
  const access = await requireVideoRunAccess(id);
  if (!access.ok) {
    return NextResponse.json(
      { error: access.status === 404 ? "run not found" : "Forbidden" },
      { status: access.status }
    );
  }
  const run = getRun.get(id) as
    | {
        id: string;
        status: string;
        config_json: string | null;
        preset_hybrid_fresh_minutes: number | null;
        drive_clips_folder_id: string | null;
        drive_final_video_id: string | null;
        drive_synced_at: string | null;
      }
    | undefined;
  if (!run) return NextResponse.json({ error: "run not found" }, { status: 404 });

  const [apiLimits, activeProviderJobs] = await Promise.all([
    discoverLabs69AccountLimits().catch(() => null),
    Promise.resolve(getActiveJobs(id)),
  ]);
  const hedgedScenes = [
    ...new Set(
      activeProviderJobs
        .filter((job) => job.isHedge && Number.isInteger(job.sceneIndex))
        .map((job) => job.sceneIndex as number)
    ),
  ].sort((a, b) => a - b);

  let mode = "hybrid";
  if (run.config_json) {
    try {
      const cfg = JSON.parse(run.config_json) as { mode?: string };
      if (cfg.mode === "full" || cfg.mode === "hybrid" || cfg.mode === "stock" || cfg.mode === "image") mode = cfg.mode;
    } catch {
      /* ignore */
    }
  }

  const runDir = getRunDir(id);
  if (!fs.existsSync(runDir)) {
    const driveSyncReport = null;
    const fallbackSummary = buildFallbackSummary([], 0);
    const rawClipSummary = buildRawClipSummary({
      run,
      finalReady: false,
      rawClipsOnDisk: 0,
      estimatedRawClipCount: 0,
      driveSyncReport,
    });
    return NextResponse.json({
      runDir,
      scenes: [],
      planReady: false,
      tailKnown: false,
      imageTailSceneCount: mode === "image" ? 0 : undefined,
      planSceneCount: 0,
      stockSceneCount: 0,
      freshSceneCount: 0,
      finalExists: false,
      finalSize: 0,
      mode,
      progress: { total: 0, rendered: 0, withVideo: 0, withAudio: 0 },
      syncReport: null,
      apiLimits,
      activeProviderJobs,
      hedgedScenes,
      fallbackScenes: [],
      fallbackSummary,
      rawClipSummary,
      driveSyncReport,
    });
  }

  let plan: { index: number; text?: string; visual_prompt?: string; duration_hint_sec?: number; source_kind?: "fresh" | "stock" | "image_card" }[] = [];
  const scenesPath = path.join(runDir, "scenes.json");
  if (fs.existsSync(scenesPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(scenesPath, "utf-8")) as typeof plan;
      if (Array.isArray(parsed)) plan = parsed;
    } catch {
      /* corrupt scenes.json — fall back to disk scan only */
    }
  }

  const scenes = new Map<number, SceneAsset>();
  function take(rel: string): { name: string; size: number } | undefined {
    const full = path.join(runDir, rel);
    if (!fs.existsSync(full)) return undefined;
    return { name: path.basename(rel), size: fs.statSync(full).size };
  }
  function ensureScene(i: number) {
    if (!scenes.has(i)) scenes.set(i, { index: i, stage: "pending" });
    return scenes.get(i)!;
  }
  function scanDir(sub: string, key: "audio" | "image" | "animation" | "clip", pattern: RegExp) {
    const dir = path.join(runDir, sub);
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(pattern);
      if (!m) continue;
      const idx = Number(m[1]);
      const asset = take(path.join(sub, f));
      if (asset) ensureScene(idx)[key] = asset;
    }
  }
  scanDir("audio", "audio", /^scene_(\d+)\.mp3$/i);
  scanDir("images", "image", /^scene_(\d+)\.(?:png|jpe?g|webp)$/i);
  scanDir("animations", "animation", /^scene_(\d+)\.mp4$/i);
  scanDir("clips", "clip", /^clip_(\d+)\.mp4$/i);

  for (const p of plan) {
    if (!Number.isInteger(p.index) || p.index < 0) continue;
    const s = ensureScene(p.index);
    if (p.text) s.text = p.text;
    if (p.visual_prompt) s.visual_prompt = p.visual_prompt;
    if (p.duration_hint_sec != null) s.duration_hint_sec = p.duration_hint_sec;
    if (p.source_kind === "fresh" || p.source_kind === "stock" || p.source_kind === "image_card") s.source_kind = p.source_kind;
  }

  const list = [...scenes.values()]
    .sort((a, b) => a.index - b.index)
    .map((s) => ({ ...s, stage: sceneStage(s) }));
  const planReady = plan.length > 0;

  const exportState = readRunExportState(id, run.status, { mode });
  const scenePlanHealth = plan.length > 0 ? analyzeExportScenePlan(plan, mode) : exportState.scenePlanHealth;
  const finalOnDisk = exportState.finalOnDisk;
  const finalNeedsRepair = exportState.finalNeedsRepair;
  const finalReady = exportState.finalReady;

  const syncReport = readJsonReport(runDir, "sync-report.json");
  const driveSyncReport = readDriveSyncReport(runDir);
  const watermarkReport = readJsonReport(runDir, "watermark-cleanup-report.json");

  const freshCutoff =
    (mode === "hybrid" || mode === "image") && run.preset_hybrid_fresh_minutes != null
      ? run.preset_hybrid_fresh_minutes * 60
      : null;
  const explicitFreshCount = plan.filter((p) => p.source_kind === "fresh").length;
  let freshSceneCount = mode === "stock" ? 0 : list.length;
  if ((mode === "hybrid" || mode === "image" || mode === "full") && explicitFreshCount > 0) {
    freshSceneCount = explicitFreshCount;
  } else if ((mode === "hybrid" || mode === "image") && freshCutoff != null && plan.length > 0) {
    let acc = 0;
    freshSceneCount = 0;
    for (const p of plan) {
      if (acc >= freshCutoff) break;
      freshSceneCount++;
      acc += p.duration_hint_sec ?? 6;
    }
  }

  const freshList = list.filter((s) => s.index < freshSceneCount);
  const stockSceneCount = Math.max(0, plan.length - freshSceneCount);
  const tailKnown = planReady;
  const tailVoicePath = path.join(runDir, "audio", "tail_voiceover.mp3");
  const tailSegPath = path.join(runDir, "tail.mp4");
  const audioDir = path.join(runDir, "audio");
  const tailVoicePartCount = fs.existsSync(audioDir)
    ? fs.readdirSync(audioDir).filter((f) => /^tail_voiceover_part\d+\.mp3$/i.test(f)).length
    : 0;
  const tailClipsDir = path.join(runDir, "tail-clips");
  const tailRenderedClipCount = fs.existsSync(tailClipsDir)
    ? fs.readdirSync(tailClipsDir).filter((f) => /^t_\d+\.mp4$/i.test(f)).length
    : 0;
  const tailCacheProgressPath = path.join(runDir, "tail-cache-progress.json");
  let tailCacheProgress: {
    normalizedCacheReadyCount?: number;
    normalizedCacheMissCount?: number;
    normalizedCacheBadCount?: number;
    tailRenderedDurationSec?: number;
    tailTargetDurationSec?: number;
    tailPickedClipCount?: number;
    buildingTail?: boolean;
    joiningFinal?: boolean;
  } = {};
  if (fs.existsSync(tailCacheProgressPath)) {
    try {
      tailCacheProgress = JSON.parse(fs.readFileSync(tailCacheProgressPath, "utf-8")) as typeof tailCacheProgress;
    } catch {
      tailCacheProgress = {};
    }
  }

  const isImageCut = mode === "image";
  const isHybridLike = mode === "hybrid" || mode === "stock" || isImageCut;
  const freshWithVideo = freshList.filter((s) => s.animation || s.clip).length;
  const freshWithAudio = freshList.filter((s) => s.audio).length;
  const freshRendered = freshList.filter((s) => s.stage === "rendered").length;
  const continuousVoicePath = path.join(runDir, "voiceover_full.mp3");
  const imageCutVisualsReady = list.filter((s) => s.image || s.animation || s.clip).length;
  const imageCutVoiceReady = fs.existsSync(continuousVoicePath);
  const imageCutRendered = list.filter((s) => s.clip).length;
  const imageCutFreshWithVideo = freshList.filter((s) => s.animation || s.clip).length;
  const imageCutFreshRendered = freshList.filter((s) => s.clip).length;
  const workerActive = isRunWorkerActive(id);
  const localProcesses = getActiveLocalProcesses(id);
  const fallbackScenes = readFreshFallbacks(runDir);
  const runtimeStatus =
    workerActive
      ? "running"
      : (run.status === "running" || run.status === "pending") && !finalReady
        ? "paused"
        : run.status;
  const tailPlanText = plan
    .filter((s) => s.index >= freshSceneCount)
    .map((s) => s.text ?? "")
    .join(" ");
  const expectedTailVoiceChunks = countContinuousChunks(tailPlanText);
  const tailVoiceReady =
    fs.existsSync(tailVoicePath) ||
    (expectedTailVoiceChunks > 0 && tailVoicePartCount >= expectedTailVoiceChunks);
  const providerVideoCount = Math.max(0, freshSceneCount - fallbackScenes.length);
  const fallbackSummary = buildFallbackSummary(fallbackScenes, providerVideoCount);
  const rawClipsOnDisk = countRawClipsOnDisk(runDir);
  const estimatedRawClipCount = mode === "stock" ? rawClipsOnDisk : Math.max(rawClipsOnDisk, freshSceneCount);
  const rawClipSummary = buildRawClipSummary({
    run,
    finalReady,
    rawClipsOnDisk,
    estimatedRawClipCount,
    driveSyncReport,
  });
  const progress = finalReady
    ? isImageCut
      ? {
          total: list.length,
          rendered: list.length,
          withVideo: list.length,
          withAudio: list.length,
        }
      : mode === "hybrid"
        ? {
            total: freshSceneCount,
            rendered: freshSceneCount,
            withVideo: freshSceneCount,
            withAudio: freshSceneCount,
          }
        : mode === "stock"
          ? {
              total: plan.length,
              rendered: plan.length,
              withVideo: plan.length,
              withAudio: plan.length,
            }
          : {
              total: list.length,
              rendered: list.length,
              withVideo: list.length,
              withAudio: list.length,
            }
    : isHybridLike
      ? isImageCut
        ? {
            total: list.length,
            rendered: imageCutRendered,
            withVideo: imageCutVisualsReady,
            withAudio: imageCutVoiceReady ? list.length : 0,
          }
        : {
            total: freshSceneCount,
            rendered: freshRendered,
            withVideo: freshWithVideo,
            withAudio: freshWithAudio,
          }
      : {
          total: list.length,
          rendered: list.filter((s) => s.stage === "rendered").length,
          withVideo: list.filter((s) => s.animation || s.clip).length,
          withAudio: list.filter((s) => s.audio).length,
        };
  const hybridProgress = isHybridLike
    ? isImageCut
      ? {
          freshTotal: freshSceneCount,
          freshWithVideo: finalReady ? freshSceneCount : imageCutFreshWithVideo,
          freshRendered: finalReady ? freshSceneCount : imageCutFreshRendered,
          stockSceneCount,
        }
      : {
          freshTotal: freshSceneCount,
          freshWithVideo: finalReady ? freshSceneCount : freshWithVideo,
          freshRendered: finalReady ? freshSceneCount : freshRendered,
          stockSceneCount,
        }
    : null;

  return NextResponse.json({
    runDir,
    scenes: isImageCut ? list : isHybridLike ? freshList : list,
    freshScenes: freshList,
    planReady,
    tailKnown,
    planSceneCount: plan.length,
    stockSceneCount: isHybridLike ? stockSceneCount : 0,
    imageTailSceneCount: isImageCut ? stockSceneCount : undefined,
    finalExists: finalReady,
    finalSize: finalReady ? exportState.finalSize : 0,
    finalOnDisk,
    finalNeedsRepair,
    canRepairPlan: exportState.canRepairPlan,
    oldFinalSize: finalNeedsRepair ? exportState.finalSize : 0,
    exportQuality: buildExportQualityReport({
      finalReady,
      finalOnDisk,
      finalNeedsRepair,
      finalSize: finalReady ? exportState.finalSize : 0,
      scenePlanHealth,
      syncReport,
      watermarkCleanupEnabled: getSetting("CLEAN_PROVIDER_WATERMARK") !== "0",
      watermarkReport,
    }),
    mode,
    runtimeStatus,
    workerActive,
    localProcesses,
    apiLimits,
    activeProviderJobs,
    hedgedScenes,
    fallbackScenes,
    fallbackSummary,
    rawClipSummary,
    driveSyncReport,
    freshSceneCount: isHybridLike ? freshSceneCount : list.length,
    scenePlanHealth,
    tail: {
      voiceoverReady: tailVoiceReady,
      voiceoverFileReady: fs.existsSync(tailVoicePath),
      voiceoverPartCount: tailVoicePartCount,
      expectedVoiceoverPartCount: expectedTailVoiceChunks,
      segmentReady: fs.existsSync(tailSegPath),
      renderedClipCount: tailRenderedClipCount,
      normalizedCacheReadyCount: Number(tailCacheProgress.normalizedCacheReadyCount ?? 0),
      normalizedCacheMissCount: Number(tailCacheProgress.normalizedCacheMissCount ?? 0),
      normalizedCacheBadCount: Number(tailCacheProgress.normalizedCacheBadCount ?? 0),
      tailRenderedDurationSec: Number(tailCacheProgress.tailRenderedDurationSec ?? 0),
      tailTargetDurationSec: Number(tailCacheProgress.tailTargetDurationSec ?? 0),
      tailPickedClipCount: Number(tailCacheProgress.tailPickedClipCount ?? 0),
      buildingTail: Boolean(tailCacheProgress.buildingTail),
      joiningFinal: Boolean(tailCacheProgress.joiningFinal),
    },
    recovery: {
      paused: runtimeStatus === "paused",
      canResume:
        (runtimeStatus === "paused" ||
          runtimeStatus === "cancelled" ||
          runtimeStatus === "error" ||
          exportState.canRepairPlan) &&
        plan.length > 0 &&
        !workerActive,
      canRepairPlan: exportState.canRepairPlan,
      openingReady: isImageCut
        ? freshSceneCount > 0 && imageCutVoiceReady && imageCutFreshWithVideo >= freshSceneCount
        : freshSceneCount > 0 && freshWithAudio >= freshSceneCount && freshWithVideo >= freshSceneCount,
      tailVoiceReady,
      tailSegmentReady: fs.existsSync(tailSegPath),
      finalReady,
      nextAction: finalReady
        ? "download"
        : finalNeedsRepair
          ? "repair"
          : runtimeStatus === "paused" || runtimeStatus === "cancelled" || runtimeStatus === "error"
            ? "resume"
            : workerActive
              ? "wait"
              : "inspect",
    },
    progress,
    hybridProgress,
    syncReport,
  });
}
