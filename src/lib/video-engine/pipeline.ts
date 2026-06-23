import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import db from "./db";
import { log } from "./logger";
import { getSetting } from "./settings";
import { defaultStockFolder, resolveHybridFreshMinutes } from "./channel-stock";
import { getRunDir } from "./run-paths";
import { pLimit } from "./plimit";
import { splitFreshOpeningScript, splitHybridScript, type Scene } from "./services/scene-split";
import { synthesizeFullScript, synthesizeScene, synthesizeContinuous, type TtsOptions, type TtsResult } from "./services/tts";
import { generateImage, type ImageResult } from "./services/image-gen";
import { animateScene } from "./services/img2vid";
import {
  assembleHybrid,
  assembleImageCut,
  assembleTail,
  normalizeFinalFraming,
  probeDurationSafe,
  renderStillMotionClip,
  type AssembleInput,
  type ImageCutVisualInput,
  type SceneAVItem,
} from "./services/video-assemble";
import { planVisualThroughline, sanitizeImageCutPrompt } from "./services/visual-director";
import { applyAtmosphere } from "./services/atmosphere";
import { cacheStockLibrary } from "./services/stock-library";
import { createShuffledStockDeckPicker } from "./stock-relevance";
import { ensureVideoPoster } from "./services/video-poster";
import { cancelJob, discoverLabs69AccountLimits, discoverLabs69Runtime } from "./services/labs69";
import { effectiveLiveSlots, effectiveProviderSlots } from "./services/labs69-capacity";
import { syncRunToDrive } from "./services/run-upload";
import { checkCancelled, clearCancelled, isCancelled, CancelledError } from "./cancellation";
import { loadStylePreset } from "./style-presets";
import { WORDS_PER_MINUTE } from "./script-estimate";
import { chunkTextByNarrationUnits } from "./text-chunking";
import { analyzeScenePlan } from "./scene-plan-health";
import { archiveMediaForScenePlanChange } from "./repair-archive";
import {
  imageHedgeDelayMs,
  limitHasSpareSlot,
  normalizeVideoHedgeConfig,
  positiveSettingInt,
  positiveSettingMs,
} from "./generation-scheduler";
import { mirrorVideoRun } from "./supabase-video-mirror";
import { isNonRetriableMediaConfigError } from "./media-errors";
import { parseImageFallbackModels } from "./provider-models";
import { loadAppSettingsIntoCache } from "../app-settings-store";
import { loadProviderSecretsIntoCache } from "../provider-secrets-store";

const getPresetSnapshotStmt = db.prepare(
  "SELECT preset_animation_motion, preset_voice_id, preset_name, preset_video_style, preset_voice_speed, preset_voice_provider, preset_style_preset_id, preset_video_model, preset_aspect_ratio, preset_voice_stability, preset_voice_similarity_boost, preset_voice_style, preset_stock_folder, preset_hybrid_fresh_minutes FROM runs WHERE id = ?"
);
const getRunRowStmt = db.prepare("SELECT id, script FROM runs WHERE id = ?");
const getRunConfigStmt = db.prepare("SELECT config_json FROM runs WHERE id = ?");
const getPresetDescriptionByNameStmt = db.prepare("SELECT description FROM prompt_presets WHERE name = ?");

const updateRun = db.prepare(
  "UPDATE runs SET status = ?, output_path = ?, updated_at = datetime('now') WHERE id = ?"
);
const getRunStatusStmt = db.prepare("SELECT status FROM runs WHERE id = ?");

const activeRunWorkers = new Map<string, string>();
const WORKER_STALE_MS = 2 * 60 * 1000;

function workerHeartbeatPath(runId: string): string {
  return path.join(getRunDir(runId), ".worker-active.json");
}

function touchWorkerHeartbeat(runId: string, token: string) {
  try {
    const runDir = getRunDir(runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(workerHeartbeatPath(runId), JSON.stringify({ runId, token, ts: Date.now() }), "utf-8");
  } catch {
    /* heartbeat is best-effort; the worker still owns the actual run */
  }
}

function removeWorkerHeartbeat(runId: string, token: string) {
  try {
    const parsed = JSON.parse(fs.readFileSync(workerHeartbeatPath(runId), "utf-8")) as { token?: string };
    if (parsed.token && parsed.token !== token) return;
    fs.rmSync(workerHeartbeatPath(runId), { force: true });
  } catch {
    /* ignore */
  }
}

function hasFreshWorkerHeartbeat(runId: string): boolean {
  try {
    return Date.now() - fs.statSync(workerHeartbeatPath(runId)).mtimeMs < WORKER_STALE_MS;
  } catch {
    return false;
  }
}

function hasRecentRunFiles(runId: string): boolean {
  const runDir = getRunDir(runId);
  const cutoff = Date.now() - WORKER_STALE_MS;
  const dirs = [runDir, path.join(runDir, "audio"), path.join(runDir, "clips"), path.join(runDir, "tail-clips")];
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
      if (fs.statSync(dir).mtimeMs >= cutoff) return true;
    } catch {
      continue;
    }
    for (const entry of entries) {
      try {
        if (fs.statSync(path.join(dir, entry)).mtimeMs >= cutoff) return true;
      } catch {
        /* file may disappear between readdir/stat */
      }
    }
  }
  return false;
}

export function isRunWorkerActive(runId: string): boolean {
  return activeRunWorkers.has(runId) || hasFreshWorkerHeartbeat(runId);
}

function checkWorkerOwnership(runId: string, token?: string): void {
  if (!token) return;
  const current = activeRunWorkers.get(runId);
  if (current && current !== token) throw new CancelledError(`Run ${runId} worker was superseded`);
  try {
    const parsed = JSON.parse(fs.readFileSync(workerHeartbeatPath(runId), "utf-8")) as { token?: string };
    if (parsed.token && parsed.token !== token) throw new CancelledError(`Run ${runId} worker was superseded`);
  } catch (e) {
    if (e instanceof CancelledError) throw e;
  }
}

type VideoWorkerAction = "run" | "resume";

async function runWorkerWithHeartbeat(
  runId: string,
  token: string,
  work: (token: string) => Promise<void>
): Promise<void> {
  activeRunWorkers.set(runId, token);
  touchWorkerHeartbeat(runId, token);
  const heartbeat = setInterval(() => touchWorkerHeartbeat(runId, token), 5000);
  try {
    await work(token);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(runId, "error", `Background worker crashed: ${msg}`, { stage: "pipeline" });
    updateRun.run("error", null, runId);
    void mirrorVideoRun(runId, { error: msg }).catch(() => {});
  } finally {
    clearInterval(heartbeat);
    if (activeRunWorkers.get(runId) === token) activeRunWorkers.delete(runId);
    removeWorkerHeartbeat(runId, token);
  }
}

function videoWorkerScriptPath(): string {
  return path.join(process.cwd(), "scripts", "video-worker.cjs");
}

async function hydrateWorkerRuntimeConfig(runId: string): Promise<void> {
  const results = await Promise.allSettled([
    loadProviderSecretsIntoCache(),
    loadAppSettingsIntoCache(),
  ]);
  const failed = results.find((result) => result.status === "rejected") as PromiseRejectedResult | undefined;
  if (failed) {
    const msg = failed.reason instanceof Error ? failed.reason.message : String(failed.reason);
    log(runId, "warn", `Video worker could not refresh remote settings before generation: ${msg.slice(0, 240)}`, {
      stage: "settings",
    });
  }
}

function startRunWorker(runId: string, action: VideoWorkerAction): { started: boolean; active: boolean } {
  const statusRow = getRunStatusStmt.get(runId) as { status?: string } | undefined;
  const status = statusRow?.status;
  const statusAllowsDiskActivity = status === "running" || status === "pending";
  if (
    activeRunWorkers.has(runId) ||
    hasFreshWorkerHeartbeat(runId) ||
    (statusAllowsDiskActivity && hasRecentRunFiles(runId))
  ) {
    return { started: false, active: true };
  }
  const token = randomUUID();
  touchWorkerHeartbeat(runId, token);
  const runDir = getRunDir(runId);
  const workerLogPath = path.join(runDir, "worker.log");
  let workerLogFd: number | null = null;
  try {
    fs.appendFileSync(
      workerLogPath,
      `\n[${new Date().toISOString()}] starting ${action} worker for ${runId}\n`,
      "utf-8"
    );
    workerLogFd = fs.openSync(workerLogPath, "a");
    const child = spawn(process.execPath, [videoWorkerScriptPath(), action, runId, token], {
      cwd: process.cwd(),
      detached: true,
      env: { ...process.env },
      stdio: ["ignore", workerLogFd, workerLogFd],
    });
    child.unref();
    if (workerLogFd != null) {
      fs.closeSync(workerLogFd);
      workerLogFd = null;
    }
    log(runId, "info", `Started video worker process ${child.pid ?? "unknown"} (${action})`, {
      stage: "pipeline",
    });
    return { started: true, active: true };
  } catch (e) {
    if (workerLogFd != null) {
      try {
        fs.closeSync(workerLogFd);
      } catch {}
    }
    removeWorkerHeartbeat(runId, token);
    const msg = e instanceof Error ? e.message : String(e);
    log(runId, "error", `Could not start video worker process: ${msg}`, { stage: "pipeline" });
    updateRun.run("error", null, runId);
    void mirrorVideoRun(runId, { error: msg }).catch(() => {});
    return { started: false, active: false };
  }
}

export function startRunPipeline(runId: string, script: string): { started: boolean; active: boolean } {
  void script;
  return startRunWorker(runId, "run");
}

export function startResumeRun(runId: string): { started: boolean; active: boolean } {
  return startRunWorker(runId, "resume");
}

export async function runVideoWorkerProcess(action: VideoWorkerAction, runId: string, token: string): Promise<void> {
  if (action === "run") {
    const row = getRunRowStmt.get(runId) as { script: string } | undefined;
    if (!row) throw new Error("Run not found");
    await runWorkerWithHeartbeat(runId, token, async (workerToken) => {
      await hydrateWorkerRuntimeConfig(runId);
      await runPipeline(runId, row.script, workerToken);
    });
    return;
  }
  if (action === "resume") {
    await runWorkerWithHeartbeat(runId, token, async (workerToken) => {
      await hydrateWorkerRuntimeConfig(runId);
      await resumeRun(runId, workerToken);
    });
    return;
  }
  throw new Error(`Unsupported video worker action: ${action}`);
}

/** scene index → padded video file path on disk. */
function videoPathFor(animDir: string, index: number): string {
  return path.join(animDir, `scene_${String(index).padStart(3, "0")}.mp4`);
}

function videoManifestPath(videoPath: string): string {
  return videoPath.replace(/\.mp4$/i, ".manifest.json");
}

/** True only if the file exists AND is non-empty (guards against broken/0-byte files). */
function fileReady(p: string): boolean {
  try {
    return fs.statSync(p).size > 0;
  } catch {
    return false;
  }
}

function generatedVideoReady(videoPath: string): boolean {
  if (!fileReady(videoPath)) return false;
  try {
    const manifest = JSON.parse(fs.readFileSync(videoManifestPath(videoPath), "utf-8")) as Record<string, unknown>;
    const cleanup = manifest.cleanup as Record<string, unknown> | undefined;
    const cleanupStatus = typeof cleanup?.status === "string" ? cleanup.status : "";
    const sourceMode = typeof manifest.sourceMode === "string" ? manifest.sourceMode : "";
    return (
      (sourceMode === "image-to-video" ||
        sourceMode === "text-to-video" ||
        sourceMode === "still-motion-fallback" ||
        sourceMode === "stock-fallback") &&
      manifest.target === path.basename(videoPath) &&
      cleanupStatus !== "failed" &&
      cleanupStatus !== "missing"
    );
  } catch {
    return false;
  }
}

function completeRunThenSyncDrive(
  runId: string,
  finalPath: string,
  sceneAssets: AssembleInput[],
  runDir: string,
  completeMessage: string
): void {
  checkCancelled(runId);
  updateRun.run("done", finalPath, runId);
  void mirrorVideoRun(runId).catch(() => {});
  log(runId, "success", completeMessage, { stage: "pipeline", data: { finalPath } });

  void syncRunToDrive(runId, sceneAssets, runDir, finalPath).catch((e) => {
    const msg = e instanceof Error ? e.message : String(e);
    log(runId, "warn", `Drive sync failed after local completion (local files preserved): ${msg}`, {
      stage: "gdrive",
    });
  });
}

/**
 * Resolve everything a run needs from its snapshot + the style preset (Prompt 9).
 *
 *  - The scene-split prompt ALWAYS comes from the style preset (channel's
 *    `preset_style_preset_id`, else the global `STYLE_PRESET_ID`).
 *  - For a CHANNEL run, voice/video overrides = channel column ?? preset default
 *    (the channel "owns" its creative settings; the preset fills any blanks).
 *  - For a NO-CHANNEL run, overrides are null → the per-scene services read the
 *    global settings (which the inline card manages from the chosen preset).
 */
function readPresetSnapshot(runId: string): {
  scenePrompt: string;
  presetName: string | null;
  styleOverride: string | null;
  voiceOverride: string | null;
  voiceProviderOverride: string | null;
  speedOverride: number | null;
  stabilityOverride: number | null;
  similarityOverride: number | null;
  voiceStyleOverride: number | null;
  modelOverride: string | null;
  aspectOverride: string | null;
  stockFolderOverride: string | null;
  freshMinutesOverride: number | null;
} {
  const row = getPresetSnapshotStmt.get(runId) as
    | {
        preset_animation_motion: string | null;
        preset_voice_id: string | null;
        preset_name: string | null;
        preset_video_style: string | null;
        preset_voice_speed: number | null;
        preset_voice_provider: string | null;
        preset_style_preset_id: string | null;
        preset_video_model: string | null;
        preset_aspect_ratio: string | null;
        preset_voice_stability: number | null;
        preset_voice_similarity_boost: number | null;
        preset_voice_style: number | null;
        preset_stock_folder: string | null;
        preset_hybrid_fresh_minutes: number | null;
      }
    | undefined;

  const stylePresetId = (row?.preset_style_preset_id ?? getSetting("STYLE_PRESET_ID")) || undefined;
  const preset = loadStylePreset(stylePresetId);
  const isChannelRun = row?.preset_name != null || row?.preset_style_preset_id != null;

  if (!isChannelRun) {
    // No channel — the run uses global settings; only the scene-split prompt is
    // driven by the (global) style preset.
    return {
      scenePrompt: preset.sceneSplitPrompt,
      presetName: null,
      styleOverride: null,
      voiceOverride: null,
      voiceProviderOverride: null,
      speedOverride: null,
      stabilityOverride: null,
      similarityOverride: null,
      voiceStyleOverride: null,
      modelOverride: null,
      aspectOverride: null,
      stockFolderOverride: null,
      freshMinutesOverride: null,
    };
  }

  return {
    scenePrompt: preset.sceneSplitPrompt,
    presetName: row?.preset_name ?? null,
    stockFolderOverride: row?.preset_stock_folder ?? null,
    freshMinutesOverride: row?.preset_hybrid_fresh_minutes ?? null,
    // video_style supersedes the legacy animation_motion snapshot; preset fills blanks.
    styleOverride: row?.preset_video_style ?? row?.preset_animation_motion ?? preset.defaults.videoStyle,
    voiceOverride: row?.preset_voice_id ?? null,
    voiceProviderOverride: row?.preset_voice_provider ?? null,
    speedOverride: row?.preset_voice_speed ?? preset.defaults.ttsSpeed,
    stabilityOverride: row?.preset_voice_stability ?? preset.defaults.ttsStability,
    similarityOverride: row?.preset_voice_similarity_boost ?? preset.defaults.ttsSimilarityBoost,
    voiceStyleOverride: row?.preset_voice_style ?? preset.defaults.ttsStyle,
    modelOverride: row?.preset_video_model ?? null,
    aspectOverride: row?.preset_aspect_ratio ?? null,
  };
}

function readChannelDescription(name: string | null): string | null {
  if (!name) return null;
  try {
    const row = getPresetDescriptionByNameStmt.get(name) as { description: string | null } | undefined;
    return row?.description ?? null;
  } catch {
    return null;
  }
}

/** Provider-aware concurrency limiters for TTS, images, and video. */
async function makeLimiters(runId: string) {
  const caps = await discoverLabs69Runtime();
  const liveLimits = await discoverLabs69AccountLimits();
  const keyCount = Math.max(1, caps.keyCount);
  const imagePerKey = effectiveProviderSlots(getSetting("IMAGE_CONCURRENCY"), caps.imagePerKey, 7);
  const ttsPerKey = effectiveProviderSlots(getSetting("TTS_CONCURRENCY"), caps.ttsPerKey, 3);
  const animPerKey = effectiveProviderSlots(getSetting("ANIMATION_CONCURRENCY"), caps.videoPerKey, 5);
  const imageSlots = effectiveLiveSlots(
    getSetting("IMAGE_CONCURRENCY"),
    caps.imagePerKey,
    keyCount,
    7,
    liveLimits.images?.remainingJobs
  );
  const ttsSlots = ttsPerKey * keyCount;
  const animSlots = effectiveLiveSlots(
    getSetting("ANIMATION_CONCURRENCY"),
    caps.videoPerKey,
    keyCount,
    5,
    liveLimits.videos?.remainingJobs
  );
  log(
    runId,
    "info",
    `69labs capacity: ${keyCount} key${keyCount === 1 ? "" : "s"} · image ${imageSlots} slots · video ${animSlots} slots · TTS ${ttsSlots} slots (${liveLimits.source === "live" ? "live limits" : caps.source})`,
    {
      stage: "pipeline",
      data: {
        keyCount,
        imageSlots,
        videoSlots: animSlots,
        ttsSlots,
        imageRemainingMonthly: caps.imageRemainingMonthly,
        videoRemainingMonthly: caps.videoRemainingMonthly,
        imageActiveJobs: liveLimits.images?.activeJobs,
        imageRemainingJobs: liveLimits.images?.remainingJobs,
        videoActiveJobs: liveLimits.videos?.activeJobs,
        videoRemainingJobs: liveLimits.videos?.remainingJobs,
      },
    }
  );
  return {
    keyCount,
    imagePerKey,
    ttsPerKey,
    animPerKey,
    imageSlots,
    ttsSlots,
    animSlots,
    limitImage: pLimit(imageSlots),
    limitTts: pLimit(ttsSlots),
    limitAnim: pLimit(animSlots),
  };
}

/**
 * Logs the failure tally and throws if the failure rate is over the
 * user-configured threshold. Shared by runPipeline and resumeRun.
 */
function enforceFailureThreshold(runId: string, totalScenes: number, succeeded: number): void {
  const failedCount = totalScenes - succeeded;
  if (failedCount <= 0) return;
  const failedPct = (failedCount / totalScenes) * 100;
  const threshold = Math.max(
    0,
    Math.min(100, Number(getSetting("FAILURE_THRESHOLD_PERCENT") || "25"))
  );
  const over = failedPct > threshold;
  log(
    runId,
    over ? "error" : "warn",
    `${failedCount}/${totalScenes} scenes failed (${failedPct.toFixed(0)}%) · abort threshold ${threshold}%`,
    { stage: "pipeline" }
  );
  if (over) {
    throw new Error(
      `Too many scenes failed: ${failedCount}/${totalScenes} (${failedPct.toFixed(0)}% over the ${threshold}% threshold). The partial assets are kept — use Resume on the run page to regenerate only the missing scenes.`
    );
  }
}

interface VideoOpts {
  styleOverride: string | null;
  modelOverride: string | null;
  aspectOverride: string | null;
}

interface MediaLimiters {
  limitImage: ReturnType<typeof pLimit>;
  limitTts?: ReturnType<typeof pLimit>;
  limitAnim: ReturnType<typeof pLimit>;
}

const imageLatencySamplesMs: number[] = [];

interface FreshFallbackRecord {
  sceneIndex: number;
  kind: "still-motion" | "stock";
  reason: string;
  createdAt: string;
  path: string;
}

function recordImageLatency(ms: number): void {
  if (!Number.isFinite(ms) || ms <= 0) return;
  imageLatencySamplesMs.push(ms);
  if (imageLatencySamplesMs.length > 100) imageLatencySamplesMs.splice(0, imageLatencySamplesMs.length - 100);
}

function fallbackReportPath(runDir: string): string {
  return path.join(runDir, "fresh-fallbacks.json");
}

function writeFreshFallback(runDir: string, record: FreshFallbackRecord): void {
  try {
    let rows: FreshFallbackRecord[] = [];
    const reportPath = fallbackReportPath(runDir);
    if (fileReady(reportPath)) {
      const parsed = JSON.parse(fs.readFileSync(reportPath, "utf-8")) as FreshFallbackRecord[];
      if (Array.isArray(parsed)) rows = parsed;
    }
    rows = rows.filter((row) => row.sceneIndex !== record.sceneIndex);
    rows.push(record);
    rows.sort((a, b) => a.sceneIndex - b.sceneIndex);
    fs.writeFileSync(reportPath, JSON.stringify(rows, null, 2), "utf-8");
  } catch {
    /* fallback evidence is best-effort */
  }
}

function writeGeneratedVideoManifest(
  videoPath: string,
  manifest: Record<string, unknown>
): void {
  try {
    fs.writeFileSync(
      videoManifestPath(videoPath),
      JSON.stringify(
        {
          createdAt: new Date().toISOString(),
          target: path.basename(videoPath),
          fileSize: fs.statSync(videoPath).size,
          fileMtimeMs: fs.statSync(videoPath).mtimeMs,
          ...manifest,
        },
        null,
        2
      ),
      "utf-8"
    );
  } catch {
    /* manifest is best-effort */
  }
}

async function generateHedgedImageForScene(
  runId: string,
  scene: Scene,
  imageDir: string,
  imageOpts: {
    styleOverride: string | null;
    aspectOverride: string | null;
    continuitySuffix?: string | null;
    modelOverride?: string | null;
  },
  limitImage: ReturnType<typeof pLimit>
): Promise<ImageResult> {
  const promptedScene = withFreshPromptGuards(scene);
  const maxCandidates = Math.max(1, Math.min(3, positiveSettingInt(getSetting("IMAGE_HEDGE_MAX_PER_SCENE"), 2)));
  const canonicalPath = path.join(imageDir, `scene_${String(scene.index).padStart(3, "0")}.png`);
  if (maxCandidates <= 1) {
    const started = Date.now();
    const result = await limitImage(() =>
      generateImage(runId, promptedScene, imageDir, {
        ...imageOpts,
        maxAttempts: 2,
      })
    );
    recordImageLatency(Date.now() - started);
    return result;
  }

  const activeJobIds = new Set<string>();
  const candidateJobIds = new Map<number, string>();
  const failures: string[] = [];
  let launched = 0;
  let completed = 0;
  let settled = false;
  let hedgeTimer: ReturnType<typeof setTimeout> | null = null;
  let nextSlotWaitLogAt = 0;

  const clearTimers = () => {
    if (hedgeTimer) clearTimeout(hedgeTimer);
  };

  const cancelLosers = async (winnerJobId?: string) => {
    const losers = [...activeJobIds].filter((id) => id !== winnerJobId);
    if (losers.length === 0) return;
    log(runId, "debug", `Cancelling ${losers.length} slower image candidate(s) for scene #${scene.index}`, {
      stage: "image",
    });
    await Promise.all(
      losers.map(async (jobId) => {
        try {
          await cancelJob("images", jobId);
        } catch {
          /* best-effort */
        }
      })
    );
  };

  const hasLiveImageSlot = async () => {
    try {
      const limits = await discoverLabs69AccountLimits();
      const remaining = limits.images?.remainingJobs;
      if (remaining == null || remaining > 0) return true;
      if (Date.now() >= nextSlotWaitLogAt) {
        const active =
          typeof limits.images?.activeJobs === "number" && typeof limits.images?.maxConcurrentJobs === "number"
            ? ` (${limits.images.activeJobs}/${limits.images.maxConcurrentJobs} active)`
            : "";
        log(runId, "debug", `Image scene #${scene.index} hedge waiting for live 69labs image slot${active}`, {
          stage: "image",
        });
        nextSlotWaitLogAt = Date.now() + 30_000;
      }
      return false;
    } catch {
      return true;
    }
  };

  const hasSpareImageSlot = async () => limitHasSpareSlot(limitImage) && (await hasLiveImageSlot());

  return await new Promise<ImageResult>((resolve, reject) => {
    const launch = (isHedge: boolean) => {
      if (settled || launched >= maxCandidates) return;
      launched++;
      const candidateNo = launched;
      const suffix = `_h${candidateNo}`;
      const started = Date.now();
      const fallbackModel =
        isHedge && !imageOpts.modelOverride ? imageFallbackModels()[candidateNo - 2] ?? null : null;
      const candidateScene = fallbackModel
        ? simplifiedFreshSceneForRetry(promptedScene, imageOpts.styleOverride ?? null)
        : promptedScene;
      const candidateOpts = fallbackModel
        ? {
            ...imageOpts,
            styleOverride: null,
            modelOverride: fallbackModel,
          }
        : imageOpts;
      const label = fallbackModel ? `fallback ${fallbackModel}` : isHedge ? "hedge" : "primary";
      if (isHedge) {
        const detail = fallbackModel ? ` with ${fallbackModel}` : "";
        log(
          runId,
          "warn",
          `Image scene #${scene.index} is slow — launching hedge candidate ${candidateNo}/${maxCandidates}${detail}`,
          {
            stage: "image",
          }
        );
      }
      limitImage(() =>
        generateImage(runId, candidateScene, imageDir, {
          ...candidateOpts,
          fileSuffix: suffix,
          maxAttempts: 1,
          isHedge,
          onJobId: (jobId) => {
            activeJobIds.add(jobId);
            candidateJobIds.set(candidateNo, jobId);
          },
        })
      )
        .then(async (result) => {
          completed++;
          recordImageLatency(Date.now() - started);
          if (settled) {
            try {
              if (result.providerJobId) await cancelJob("images", result.providerJobId);
            } catch {}
            return;
          }
          settled = true;
          clearTimers();
          if (result.filePath !== canonicalPath) fs.copyFileSync(result.filePath, canonicalPath);
          log(runId, "success", `Image scene #${scene.index} using ${label} candidate (${Math.round((Date.now() - started) / 1000)}s)`, {
            stage: "image",
          });
          await cancelLosers(result.providerJobId);
          resolve({ ...result, filePath: canonicalPath });
        })
        .catch((e) => {
          completed++;
          const jobId = candidateJobIds.get(candidateNo);
          if (jobId) activeJobIds.delete(jobId);
          const msg = e instanceof Error ? e.message : String(e);
          if (isCancelled(runId) || e instanceof CancelledError) {
            settled = true;
            clearTimers();
            void cancelLosers().finally(() => reject(e instanceof CancelledError ? e : new CancelledError(msg)));
            return;
          }
          failures.push(`${label}: ${msg}`);
          if (isNonRetriableMediaConfigError(msg)) {
            settled = true;
            clearTimers();
            void cancelLosers().finally(() => reject(new Error(failures.join(" | "))));
            return;
          }
          if (!settled && launched < maxCandidates) {
            launch(true);
            return;
          }
          if (!settled && completed >= launched) {
            settled = true;
            clearTimers();
            void cancelLosers().finally(() => reject(new Error(failures.join(" | "))));
          }
        });
    };

    const hedgeDelay = imageHedgeDelayMs(getSetting("IMAGE_HEDGE_AFTER_SECONDS"), imageLatencySamplesMs);
    const scheduleHedge = (delayMs: number) => {
      hedgeTimer = setTimeout(() => {
        void (async () => {
          if (settled || launched >= maxCandidates) return;
          if (await hasSpareImageSlot()) {
            launch(true);
          } else {
            scheduleHedge(5_000);
          }
        })();
      }, delayMs);
      hedgeTimer.unref?.();
    };

    launch(false);
    scheduleHedge(hedgeDelay);
  });
}

async function generateFreshImageWithSimplifiedRetry(
  runId: string,
  scene: Scene,
  imageDir: string,
  imageOpts: {
    styleOverride: string | null;
    aspectOverride: string | null;
    continuitySuffix?: string | null;
    modelOverride?: string | null;
  },
  limitImage: ReturnType<typeof pLimit>
): Promise<ImageResult> {
  try {
    return await generateHedgedImageForScene(runId, scene, imageDir, imageOpts, limitImage);
  } catch (e) {
    if (e instanceof CancelledError || isCancelled(runId)) {
      throw e instanceof CancelledError ? e : new CancelledError(`Run ${runId} cancelled`);
    }
    const msg = e instanceof Error ? e.message : String(e);
    if (isNonRetriableMediaConfigError(msg)) {
      throw new Error(msg);
    }
    log(runId, "warn", `Scene #${scene.index} image failed — retrying with simplified provider-safe maritime prompt: ${msg.slice(0, 240)}`, {
      stage: "pipeline",
    });

    const retryScene = simplifiedFreshSceneForRetry(withFreshPromptGuards(scene), imageOpts.styleOverride ?? null);
    const configuredFallbackModels = imageFallbackModels();
    const fallbackModels = filterAlreadyAttemptedImageModels(configuredFallbackModels, msg);
    const retryModelCandidates: Array<string | null> = configuredFallbackModels.length > 0 ? fallbackModels : [null];
    const retryErrors: string[] = [];
    if (retryModelCandidates.length === 0) {
      log(runId, "warn", `Scene #${scene.index} image retry has no unused fallback models left after hedged attempts`, {
        stage: "image",
      });
    }

    for (const fallbackModel of retryModelCandidates) {
      try {
        checkCancelled(runId);
        if (fallbackModel) {
          log(runId, "warn", `Scene #${scene.index} image retry will use fallback model ${fallbackModel}`, {
            stage: "image",
          });
        }
        return await generateHedgedImageForScene(
          runId,
          retryScene,
          imageDir,
          {
            ...imageOpts,
            styleOverride: null,
            modelOverride: fallbackModel,
          },
          limitImage
        );
      } catch (retryError) {
        if (retryError instanceof CancelledError || isCancelled(runId)) {
          throw retryError instanceof CancelledError ? retryError : new CancelledError(`Run ${runId} cancelled`);
        }
        const retryMsg = retryError instanceof Error ? retryError.message : String(retryError);
        retryErrors.push(`${fallbackModel ?? "primary model"}: ${retryMsg.slice(0, 300)}`);
        log(runId, "warn", `Scene #${scene.index} image retry failed with ${fallbackModel ?? "primary model"}: ${retryMsg.slice(0, 220)}`, {
          stage: "image",
        });
      }
    }
    throw new Error(`fresh image failed after simplified retry: ${msg.slice(0, 300)} | retry: ${retryErrors.join(" | ")}`);
  }
}

async function generateFreshSceneClip(
  runId: string,
  scene: Scene,
  dirs: { runDir: string; imageDir: string; animDir: string; audioDir: string },
  videoOpts: VideoOpts,
  ttsOpts: TtsOptions,
  limiters: Required<MediaLimiters>,
  opts: {
    reuseSavedAssets: boolean;
    pickStockPath?: (() => Promise<string | null>) | null;
    videoTimeoutMs: number;
    videoMaxAttempts: number;
    videoHedgeAfterMs: number;
    videoMaxParallel: number;
  }
): Promise<SceneAVItem | null> {
  const audioPath = path.join(dirs.audioDir, `scene_${String(scene.index).padStart(3, "0")}.mp3`);
  const vPath = videoPathFor(dirs.animDir, scene.index);
  const promptedScene = withFreshPromptGuards(scene);
  const audioSourcePromise: Promise<TtsResult> = opts.reuseSavedAssets && fileReady(audioPath)
    ? probeDurationSafe(audioPath).then((durationSec) => ({ filePath: audioPath, durationSec }))
    : limiters.limitTts(() => synthesizeScene(runId, scene, dirs.audioDir, ttsOpts));
  let audioErrorLogged = false;
  const audioPromise = audioSourcePromise.catch((error) => {
    throw error;
  });
  // Audio and video run in parallel; attach a handler immediately so a fast
  // TTS rejection cannot become an unhandled promise while video is still polling.
  void audioPromise.catch(() => {});

  try {
    checkCancelled(runId);
    if (opts.reuseSavedAssets && generatedVideoReady(vPath)) {
      let audio: TtsResult;
      try {
        audio = await audioPromise;
      } catch (e) {
        if (e instanceof CancelledError) throw e;
        const msg = e instanceof Error ? e.message : String(e);
        audioErrorLogged = true;
        log(runId, "error", `Scene #${scene.index} audio failed while reusing fresh video: ${msg.slice(0, 600)}`, {
          stage: "tts",
        });
        throw new Error(`fresh audio failed: ${msg}`);
      }
      return { index: scene.index, videoPath: vPath, audioPath: audio.filePath, kind: "fresh" };
    }

    let image: ImageResult | null = null;
    try {
      image = await generateFreshImageWithSimplifiedRetry(
        runId,
        promptedScene,
        dirs.imageDir,
        {
          styleOverride: videoOpts.styleOverride,
          aspectOverride: videoOpts.aspectOverride,
        },
        limiters.limitImage
      );
    } catch (e) {
      if (e instanceof CancelledError || isCancelled(runId)) {
        throw e instanceof CancelledError ? e : new CancelledError(`Run ${runId} cancelled`);
      }
      const msg = e instanceof Error ? e.message : String(e);
      const stockSrc = opts.pickStockPath ? await opts.pickStockPath() : null;
      if (!stockSrc) throw new Error(`fresh image failed: ${msg}`);

      let audio: TtsResult;
      try {
        audio = await audioPromise;
      } catch (audioError) {
        if (audioError instanceof CancelledError) throw audioError;
        const audioMsg = audioError instanceof Error ? audioError.message : String(audioError);
        audioErrorLogged = true;
        log(runId, "error", `Scene #${scene.index} audio failed after stock fallback was selected: ${audioMsg.slice(0, 600)}`, {
          stage: "tts",
        });
        throw new Error(`fresh audio failed: ${audioMsg}`);
      }

      fs.copyFileSync(stockSrc, vPath);
      writeGeneratedVideoManifest(vPath, {
        sourceMode: "stock-fallback",
        provider: "local-stock",
        sourcePath: stockSrc,
        reason: msg.slice(0, 600),
      });
      writeFreshFallback(dirs.runDir, {
        sceneIndex: scene.index,
        kind: "stock",
        reason: msg.slice(0, 600),
        createdAt: new Date().toISOString(),
        path: vPath,
      });
      log(runId, "warn", `Scene #${scene.index} image failed — using stock fallback for this fresh beat`, {
        stage: "image",
      });
      return { index: scene.index, videoPath: vPath, audioPath: audio.filePath, kind: "stock-fallback" };
    }

    try {
      const videoPath = await animateScene(runId, promptedScene, image.filePath, dirs.animDir, {
        providerJobId: image.providerJobId,
        imageProvider: image.provider,
        ...videoOpts,
        maxAttempts: opts.videoMaxAttempts,
        timeoutMs: opts.videoTimeoutMs,
        hedgeAfterMs: opts.videoHedgeAfterMs,
        maxParallel: opts.videoMaxParallel,
        attemptLimiter: limiters.limitAnim,
      });
      if (!videoPath) throw new Error(`Scene #${scene.index} produced no fresh clip`);
      let audio: TtsResult;
      try {
        audio = await audioPromise;
      } catch (audioError) {
        if (audioError instanceof CancelledError) throw audioError;
        const audioMsg = audioError instanceof Error ? audioError.message : String(audioError);
        audioErrorLogged = true;
        log(runId, "error", `Scene #${scene.index} audio failed after fresh video succeeded: ${audioMsg.slice(0, 600)}`, {
          stage: "tts",
        });
        throw new Error(`fresh audio failed: ${audioMsg}`);
      }
      return { index: scene.index, videoPath, audioPath: audio.filePath, kind: "fresh" };
    } catch (e) {
      if (e instanceof CancelledError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.startsWith("fresh audio failed:")) throw e;
      let audio: TtsResult;
      try {
        audio = await audioPromise;
      } catch (audioError) {
        if (audioError instanceof CancelledError) throw audioError;
        const audioMsg = audioError instanceof Error ? audioError.message : String(audioError);
        audioErrorLogged = true;
        log(runId, "error", `Scene #${scene.index} audio failed after fresh video failed: ${audioMsg.slice(0, 600)}`, {
          stage: "tts",
        });
        throw new Error(`fresh audio failed: ${audioMsg}`);
      }

      log(runId, "warn", `Scene #${scene.index} video failed — using still-motion fallback: ${msg.slice(0, 240)}`, {
        stage: "animate",
      });
      await renderStillMotionClip(
        runId,
        image.filePath,
        vPath,
        Math.max(2, audio.durationSec),
        `fresh scene #${scene.index + 1} still-motion fallback`
      );
      writeGeneratedVideoManifest(vPath, {
        sourceMode: "still-motion-fallback",
        provider: "local-still",
        imagePath: image.filePath,
        imageJobId: image.providerJobId ?? null,
        reason: msg.slice(0, 600),
      });
      writeFreshFallback(dirs.runDir, {
        sceneIndex: scene.index,
        kind: "still-motion",
        reason: msg.slice(0, 600),
        createdAt: new Date().toISOString(),
        path: vPath,
      });
      return { index: scene.index, videoPath: vPath, audioPath: audio.filePath, kind: "still-motion-fallback" };
    }
  } catch (e) {
    if (e instanceof CancelledError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    if (!audioErrorLogged) void audioPromise.catch((audioError) => {
      const audioMsg = audioError instanceof Error ? audioError.message : String(audioError);
      log(runId, "warn", `Scene #${scene.index} audio also failed after fresh media failure: ${audioMsg.slice(0, 300)}`, {
        stage: "tts",
      });
    });
    log(runId, "error", `Scene #${scene.index} failed: ${msg.slice(0, 600)}`, { stage: "pipeline" });
    return null;
  }
}

function imageFallbackModels(): string[] {
  return parseImageFallbackModels(getSetting("IMAGE_FALLBACK_MODEL"), getSetting("IMAGE_MODEL"));
}

function filterAlreadyAttemptedImageModels(models: string[], failureMessage: string): string[] {
  const lower = failureMessage.toLowerCase();
  return models.filter((model) => !lower.includes(model.toLowerCase()));
}

function providerSafeNarrationHint(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .slice(0, 300)
    .replace(/\bgun ports?\b/gi, "square openings along the hull")
    .replace(/\bguns?\b/gi, "naval deck fittings")
    .replace(/\bcannons?\b/gi, "naval deck fittings")
    .replace(/\bweapons?\b/gi, "historic naval vessel")
    .replace(/\bfight(?:ing)?\b/gi, "serve at sea")
    .replace(/\bbattleships?\b/gi, "large naval ships")
    .replace(/\bbattles?\b/gi, "naval history")
    .replace(/\bbroadsides?\b/gi, "rows of open decks")
    .replace(/\bwarships?\b/gi, "wooden sailing ships")
    .trim();
}

function historicalMaritimeAnchor(text: string): string | null {
  const lower = text.toLowerCase();
  const describesPreservedVictory =
    /\bdry dock\b/.test(lower) &&
    /\bsouthern england\b/.test(lower) &&
    (/\bsingle wooden (?:war)?ship\b/.test(lower) || /\bthree rows?\b/.test(lower) || /\bgun ports?\b/.test(lower));
  if (describesPreservedVictory) {
    return [
      "Specific subject anchor: preserved eighteenth-century HMS Victory at Portsmouth Historic Dockyard in dry dock.",
      "Show a museum-realistic weathered oak hull with three tiers of square hull openings, rigging, dock supports, and Portsmouth dockyard context; not a generic pirate galleon.",
    ].join(" ");
  }

  const likelySameShipOfLineOpening =
    /\b(six thousand trees|shipwrights|oak|hull|two feet thick|tens of millions|years to complete|nine hundred men|exact class|ship of the line)\b/.test(lower);
  if (likelySameShipOfLineOpening) {
    return [
      "Keep this in the same historical ship-of-the-line dockyard world as HMS Victory:",
      "oak timbers, shipwright tools, rigging, ledgers, preserved wooden hull details, and calm museum-documentary realism; avoid generic pirate fantasy.",
    ].join(" ");
  }

  return null;
}

function withFreshPromptGuards(scene: Scene): Scene {
  const anchor = historicalMaritimeAnchor(scene.text);
  if (!anchor) return scene;
  const current = scene.visual_prompt || "";
  if (current.toLowerCase().includes("hms victory") || current.toLowerCase().includes("ship-of-the-line dockyard")) {
    return scene;
  }
  return {
    ...scene,
    visual_prompt: `${anchor} ${current}`.trim(),
  };
}

function simplifiedFreshSceneForRetry(scene: Scene, styleOverride: string | null): Scene {
  const style = styleOverride?.trim();
  const safeHint = providerSafeNarrationHint(scene.text);
  const anchor = historicalMaritimeAnchor(scene.text);
  return {
    ...scene,
    visual_prompt: [
      anchor,
      `Provider-safe museum-style historical maritime documentary keyframe for this narration beat: "${safeHint}".`,
      "Show one coherent 17th-18th century wooden sailing ship, harbour, dry dock, deck timber, chart table, rigging, sails, sea, or period sailor detail that directly matches the narration.",
      "Use calm non-combat composition, realistic lighting, no weapons, no violence, no modern objects, no text, no captions, no logos, no UI overlays.",
      style ? `Channel style: ${style}` : "",
    ]
      .filter(Boolean)
      .join(" "),
  };
}

/** Translate a thrown error into the right run status + log. Shared catch. */
function handlePipelineError(runId: string, e: unknown): void {
  if (e instanceof CancelledError) {
    log(runId, "warn", "Pipeline cancelled by user", { stage: "pipeline" });
    // status 'cancelled' was already set by the cancel endpoint
  } else {
    const msg = e instanceof Error ? e.message : String(e);
    log(runId, "error", `Pipeline crashed: ${msg}`, { stage: "pipeline" });
    updateRun.run("error", null, runId);
    void mirrorVideoRun(runId, { error: msg }).catch(() => {});
  }
}

function parseRunModeConfig(configJson: string | null | undefined): string | null {
  if (!configJson) return null;
  try {
    const parsed = JSON.parse(configJson) as { mode?: unknown };
    return typeof parsed.mode === "string" ? parsed.mode : null;
  } catch {
    return null;
  }
}

export function retiredVideoModeError(mode?: string | null): string {
  const label = mode?.trim() ? mode.trim() : "legacy";
  return `The ${label} video mode has been retired. Start a new Hybrid or Image cut run instead.`;
}

// ───────────────────────────────────────────────────────────────────────────
// Run dispatch — only Hybrid and Image cut are executable modes.
// ───────────────────────────────────────────────────────────────────────────

export async function runPipeline(runId: string, script: string, workerToken?: string) {
  const cfgRow = getRunConfigStmt.get(runId) as { config_json: string | null } | undefined;
  const runMode = parseRunModeConfig(cfgRow?.config_json);
  if (runMode === "image") {
    return runImagePipeline(runId, script);
  }
  if (runMode === "hybrid") {
    return runHybridPipeline(runId, script, { workerToken });
  }
  handlePipelineError(runId, new Error(retiredVideoModeError(runMode)));
}

// ───────────────────────────────────────────────────────────────────────────
// Resume — regenerate only the missing scenes of a failed/partial run
// ───────────────────────────────────────────────────────────────────────────

/**
 * Resumes a run that failed or was cancelled partway through. Reads the saved
 * scenes.json, keeps every scene whose audio + video are already on disk, and
 * regenerates ONLY the missing ones — then re-assembles and re-uploads.
 *
 * This is what makes runs failure-proof: a provider glitch / rate-cap night
 * no longer throws away clips already paid for.
 */
export async function resumeRun(runId: string, workerToken?: string) {
  const row = getRunRowStmt.get(runId) as { id: string; script: string } | undefined;
  if (!row) throw new Error("Run not found");
  const cfgRow = getRunConfigStmt.get(runId) as { config_json: string | null } | undefined;
  const mode = parseRunModeConfig(cfgRow?.config_json);
  // Image Cut resumes by re-running (v1: no partial-reuse for image runs yet).
  if (mode === "image") {
    return runImagePipeline(runId, row.script);
  }
  // Hybrid resumes without re-splitting scenes.
  if (mode === "hybrid") {
    return runHybridPipeline(runId, row.script, { reuseScenes: true, workerToken });
  }
  handlePipelineError(runId, new Error(retiredVideoModeError(mode)));
  return;
}

// ───────────────────────────────────────────────────────────────────────────
// Hybrid run — fresh AI opening + narration-aware stock-library tail, per-scene audio
// ───────────────────────────────────────────────────────────────────────────

/**
 * Hybrid pipeline for long sleep videos:
 *  - Every scene gets its OWN narration mp3 (per-scene audio = perfect sync).
 *  - The first HYBRID_FRESH_MINUTES of narration get freshly generated AI clips
 *    (image → video), the topical, synced opening.
 *  - Every later scene is filled from the Drive stock library
 *    (STOCK_LIBRARY_FOLDER, e.g. "Pirates"), ordered against the narration when
 *    local clip names contain useful hints — no generation, no extra tokens.
 *  - Assembly fits each clip to its scene's narration → zero audio/video drift.
 */
export async function runHybridPipeline(runId: string, script: string, opts?: { reuseScenes?: boolean; workerToken?: string }) {
  const runDir = getRunDir(runId);
  const imageDir = path.join(runDir, "images");
  const animDir = path.join(runDir, "animations");
  const audioDir = path.join(runDir, "audio");
  for (const d of [runDir, imageDir, animDir, audioDir]) fs.mkdirSync(d, { recursive: true });

  try {
    checkWorkerOwnership(runId, opts?.workerToken);
    clearCancelled(runId);
    updateRun.run("running", null, runId);

    const {
      scenePrompt,
      styleOverride,
      voiceOverride,
      speedOverride,
      voiceProviderOverride,
      stabilityOverride,
      similarityOverride,
      voiceStyleOverride,
      modelOverride,
      aspectOverride,
      stockFolderOverride,
      freshMinutesOverride,
      presetName,
    } = readPresetSnapshot(runId);

    const mode = "hybrid";
    const stockFolder = (stockFolderOverride || defaultStockFolder(presetName ?? "Channel")).trim() || "Channel";
    const freshMinutes = Math.max(1, freshMinutesOverride ?? resolveHybridFreshMinutes(null, getSetting("HYBRID_FRESH_MINUTES")));
    log(
      runId,
      "info",
      `Hybrid run · ${freshMinutes} min fresh + stock "${stockFolder}" · folder: ${path.basename(runDir)}`,
      { stage: "pipeline" }
    );
    const ttsOpts = {
      voiceOverride,
      speedOverride,
      voiceProviderOverride,
      stabilityOverride,
      similarityOverride,
      voiceStyleOverride,
    };
    const videoOpts: VideoOpts = { styleOverride, modelOverride, aspectOverride };

    // 1. Split the script — or reuse scenes.json on resume (skip expensive re-split).
    const scenesPath = path.join(runDir, "scenes.json");
    let scenes: Scene[];
    let reuseSavedAssets = !!opts?.reuseScenes;
    if (opts?.reuseScenes && fileReady(scenesPath)) {
      const savedScenes = JSON.parse(fs.readFileSync(scenesPath, "utf-8")) as Scene[];
      if (!Array.isArray(savedScenes) || savedScenes.length === 0) {
        throw new Error("scenes.json is empty — start a fresh run instead.");
      }
      const health = analyzeScenePlan(savedScenes);
      if (health.ok) {
        scenes = savedScenes;
        log(runId, "info", `Resume: reusing saved scene plan (${scenes.length} scenes)`, { stage: "scene_split" });
      } else {
        reuseSavedAssets = false;
        scenes = (await splitHybridScript(runId, script, freshMinutes * 60, scenePrompt, styleOverride)).scenes;
        try {
          fs.copyFileSync(scenesPath, path.join(runDir, `scenes.microchunks.${Date.now()}.json`));
        } catch {}
        fs.writeFileSync(scenesPath, JSON.stringify(scenes, null, 2), "utf-8");
        archiveMediaForScenePlanChange(runDir);
        log(
          runId,
          "warn",
          `${health.issue} Rebuilt it into ${scenes.length} sentence-safe beats. Old media was archived so this resume cannot reuse broken scene files.`,
          { stage: "scene_split", data: { before: health, after: analyzeScenePlan(scenes) } }
        );
      }
    } else {
      reuseSavedAssets = false;
      scenes = (await splitHybridScript(runId, script, freshMinutes * 60, scenePrompt, styleOverride)).scenes;
      checkCancelled(runId);
      fs.writeFileSync(scenesPath, JSON.stringify(scenes, null, 2), "utf-8");
    }
    checkCancelled(runId);

    // 2. Decide the fresh/stock cut-over by cumulative estimated narration.
    const hasSourceMarkers = scenes.some((s) => s.source_kind === "fresh" || s.source_kind === "stock");
    const freshCutoffSec = freshMinutes * 60;
    let cum = 0;
    let freshCount = hasSourceMarkers ? scenes.filter((s) => s.source_kind === "fresh").length : 0;
    if (!hasSourceMarkers) {
      for (const s of scenes) {
        if (cum >= freshCutoffSec) break;
        cum += Math.max(1, s.duration_hint_sec || 5);
        freshCount++;
      }
    }
    // If the whole script fits in the fresh window, there's no stock tail.
    const stockCount = scenes.length - freshCount;
    log(runId, "info", `${scenes.length} scenes · first ${freshCount} fresh (≈${freshMinutes} min), ${stockCount} from stock library`, { stage: "pipeline" });

    const freshScenes = scenes.filter((s) => s.index < freshCount);
    const tailScenes = scenes.filter((s) => s.index >= freshCount);

    // 3. Cache the stock library locally (only if we need a tail).
    let pickStockPath: (() => string) | null = null;
    if (stockCount > 0) {
      const cached = await cacheStockLibrary(runId, stockFolder);
      checkCancelled(runId);
      if (cached.length === 0) {
        throw new Error(`Stock library "${stockFolder}" produced no usable clips — add clips to Drive or lower HYBRID_FRESH_MINUTES.`);
      }
      const plan = createShuffledStockDeckPicker(cached, runId);
      pickStockPath = plan.pick;
      log(
        runId,
        "info",
        `Stock deck shuffled: ${plan.deckSize ?? cached.length} clips · one full pass before repeats · seed ${runId.slice(0, 8)}`,
        { stage: "reuse", data: { mode: plan.mode, deckSize: plan.deckSize, stockBeatCount: tailScenes.length } }
      );
    }

    let fallbackStockPickerPromise: Promise<(() => string) | null> | null = null;
    const pickFreshFallbackStockPath = async (): Promise<string | null> => {
      if (pickStockPath) return pickStockPath();
      if (!fallbackStockPickerPromise) {
        fallbackStockPickerPromise = (async () => {
          try {
            const cached = await cacheStockLibrary(runId, stockFolder);
            if (cached.length === 0) return null;
            const plan = createShuffledStockDeckPicker(cached, `${runId}:fresh-fallback`);
            log(runId, "info", `Stock fallback deck ready: ${plan.deckSize ?? cached.length} clips`, {
              stage: "reuse",
            });
            return plan.pick;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            log(runId, "warn", `Stock fallback deck unavailable: ${msg.slice(0, 240)}`, { stage: "reuse" });
            return null;
          }
        })();
      }
      const picker = await fallbackStockPickerPromise;
      return picker ? picker() : null;
    };

    const { keyCount, imagePerKey, ttsPerKey, animPerKey, imageSlots, ttsSlots, animSlots, limitImage, limitTts, limitAnim } = await makeLimiters(runId);
    log(
      runId,
      "info",
      `${freshScenes.length} fresh synced scenes + continuous-voice tail over ${tailScenes.length} scenes. Keys: ${keyCount} · image=${imageSlots} (${imagePerKey}/key), TTS=${ttsSlots} (${ttsPerKey}/key), video=${animSlots} (${animPerKey}/key)`,
      { stage: "pipeline" }
    );
    log(runId, "info", "Fresh opening starts voice and visuals together.", { stage: "pipeline" });

    const tailPromise: Promise<{ path: string } | null> = (async () => {
      if (tailScenes.length === 0 || !pickStockPath) return null;
      checkWorkerOwnership(runId, opts?.workerToken);
      checkCancelled(runId);
      const tailPath = path.join(runDir, "tail.mp4");
      const tailText = tailScenes.map((s) => s.text).join(" ");
      const tailAudioPath = path.join(audioDir, "tail_voiceover.mp3");
      const tailAudio = await synthesizeContinuous(runId, tailText, tailAudioPath, ttsOpts, { limitTts });
      checkWorkerOwnership(runId, opts?.workerToken);
      checkCancelled(runId);
      if (reuseSavedAssets && fileReady(tailPath)) {
        const tailDuration = await probeDurationSafe(tailPath);
        if (tailDuration >= Math.max(1, tailAudio.durationSec - 1)) {
          log(runId, "info", "Tail segment already exists — reusing it", { stage: "assemble" });
          return { path: tailPath };
        }
        log(runId, "warn", "Tail segment was incomplete — rebuilding from saved B-roll clips", { stage: "assemble" });
      }
      checkWorkerOwnership(runId, opts?.workerToken);
      checkCancelled(runId);
      return assembleTail(runId, tailAudio.filePath, pickStockPath, runDir);
    })().catch((e) => {
      if (e instanceof CancelledError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      log(runId, "error", `Tail failed: ${msg.slice(0, 600)}`, { stage: "pipeline" });
      throw e;
    });

    const hybridVideoTimeoutMs = positiveSettingMs(getSetting("HYBRID_VIDEO_TIMEOUT_SECONDS"), 480);
    const hybridVideoHedgeAfterMs = positiveSettingMs(getSetting("HYBRID_VIDEO_HEDGE_AFTER_SECONDS"), 180);
    const videoHedgeConfig = normalizeVideoHedgeConfig(
      getSetting("HYBRID_VIDEO_MAX_ATTEMPTS"),
      getSetting("HYBRID_VIDEO_MAX_PARALLEL_PER_SCENE"),
      3
    );
    const hybridVideoMaxAttempts = videoHedgeConfig.maxAttempts;
    const hybridVideoMaxParallel = videoHedgeConfig.maxParallel;

    // 4a. Fresh opening scheduler. Images occupy image slots, and as
    // soon as one scene's winning image lands, its video enters the video
    // queue. Slow images can get one spare-slot hedge; slow videos get
    // spare-slot provider hedges and fail recoverably if no real video lands.
    const settledFresh = await Promise.all(
      freshScenes.map((scene): Promise<SceneAVItem | null> =>
        generateFreshSceneClip(
          runId,
          scene,
          { runDir, imageDir, animDir, audioDir },
          videoOpts,
          ttsOpts,
          { limitImage, limitTts, limitAnim },
          {
            reuseSavedAssets,
            pickStockPath: pickFreshFallbackStockPath,
            videoTimeoutMs: hybridVideoTimeoutMs,
            videoMaxAttempts: hybridVideoMaxAttempts,
            videoHedgeAfterMs: hybridVideoHedgeAfterMs,
            videoMaxParallel: hybridVideoMaxParallel,
          }
        )
      )
    );
    const freshItems = settledFresh.filter((x): x is SceneAVItem => x !== null);

    // 4b. Tail — ONE continuous voiceover over selected stock clips.
    const tail = await tailPromise;
    checkWorkerOwnership(runId, opts?.workerToken);

    // Fail only if the fresh opening mostly failed (the tail is best-effort B-roll).
    enforceFailureThreshold(runId, freshScenes.length, freshItems.length);
    if (freshItems.length === 0 && !tail) throw new Error("No scenes succeeded");

    // 5. Assemble: fresh per-scene (synced) + continuous tail.
    checkCancelled(runId);
    const { finalPath, totalSec, maxDriftSec } = await assembleHybrid(runId, freshItems, tail, runDir);
    await applyAtmosphere(runId, finalPath, { durationSec: totalSec, mode });
    checkCancelled(runId);
    await normalizeFinalFraming(runId, finalPath);
    checkCancelled(runId);
    const items = freshItems;

    // Persist a sync report so the UI can prove alignment.
    try {
      fs.writeFileSync(
        path.join(runDir, "sync-report.json"),
        JSON.stringify(
          {
            mode,
            freshScenes: freshItems.length,
            continuousTail: !!tail,
            tailScenes: tail ? tailScenes.length : 0,
            totalSec,
            freshMaxDriftSec: maxDriftSec,
          },
          null,
          2
        ),
        "utf-8"
      );
    } catch {}

    log(
      runId,
      "success",
      `Sync report: ${freshItems.length} fresh synced scenes${tail ? " + continuous tail" : ""} · ${(totalSec / 60).toFixed(1)} min · fresh max drift ${maxDriftSec.toFixed(3)}s`,
      { stage: "assemble" }
    );

    // 6. Poster + Drive sync (best-effort) + mark done.
    try {
      await ensureVideoPoster(finalPath, path.join(runDir, "final-poster.jpg"));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(runId, "warn", `Poster preview failed (video is still usable): ${msg.slice(0, 160)}`, { stage: "assemble" });
    }
    const assets: AssembleInput[] = items
      .filter((it) => !!it.videoPath)
      .map((it) => {
        const scene = scenes.find((s) => s.index === it.index)!;
        const fallbackKind =
          it.kind === "still-motion-fallback"
            ? "still-motion"
            : it.kind === "stock-fallback"
              ? "stock"
              : null;
        return {
          scene,
          imagePath: it.videoPath,
          videoPath: it.videoPath,
          audio: { filePath: it.audioPath, durationSec: 0 },
          sourceMode:
            fallbackKind === "still-motion"
              ? "still-motion-fallback"
              : fallbackKind === "stock"
                ? "stock-fallback"
                : "image-to-video",
          fallbackKind,
        };
      });

    completeRunThenSyncDrive(runId, finalPath, assets, runDir, "Hybrid pipeline complete");
  } catch (e) {
    handlePipelineError(runId, e);
  }
}

const IMAGE_CUT_CARD_SECONDS = 20;
const IMAGE_CUT_CARD_TARGET_WORDS = Math.round((IMAGE_CUT_CARD_SECONDS / 60) * WORDS_PER_MINUTE);
const IMAGE_CUT_CARD_CHUNK_TARGET_WORDS = Math.round(((IMAGE_CUT_CARD_SECONDS + 4) / 60) * WORDS_PER_MINUTE);
const IMAGE_CUT_CARD_MAX_WORDS = Math.round(((IMAGE_CUT_CARD_SECONDS + 10) / 60) * WORDS_PER_MINUTE);
const IMAGE_CUT_VISUAL_DIRECTOR_MAX_SCENES = 120;

type ImageCutScenePlan = {
  scenes: Scene[];
  freshCount: number;
  imageCardCount: number;
  reusedScenePlan: boolean;
};

function fallbackImageCutPrompt(scene: Scene, channelName: string | null, styleOverride: string | null): string {
  const channel = channelName?.trim() ? ` for the "${channelName.trim()}" channel` : "";
  const style = styleOverride?.trim() ? ` Channel style: ${styleOverride.trim()}` : "";
  return sanitizeImageCutPrompt([
    `One coherent cinematic documentary image card${channel} that illustrates this narration section: "${scene.text.slice(0, 420)}".`,
    "Keep the main subject world present through abstract ideas and topic changes; use era-appropriate, non-modern visual logic unless the script explicitly requires modern technology.",
    style,
  ].filter(Boolean).join(" "));
}

async function planImageCutScenes(
  runId: string,
  script: string,
  freshSeconds: number,
  scenePrompt: string,
  styleOverride: string | null | undefined,
  presetName: string | null | undefined
): Promise<ImageCutScenePlan> {
  const runDir = getRunDir(runId);
  const scenesPath = path.join(runDir, "scenes.json");
  let savedForArchive: Scene[] | null = null;

  if (fileReady(scenesPath)) {
    try {
      const saved = JSON.parse(fs.readFileSync(scenesPath, "utf-8")) as Scene[];
      if (Array.isArray(saved) && saved.length > 0) {
        savedForArchive = saved;
        if (reusableImageCutPlan(saved)) {
          const scenes = saved.map((s, i) => ({ ...s, index: i }));
          const freshCount = scenes.filter((s) => s.source_kind === "fresh").length;
          const imageCardCount = scenes.filter((s) => s.source_kind === "image_card").length;
          log(runId, "info", `Image Cut: reusing saved scene plan (${freshCount} fresh + ${imageCardCount} image cards)`, {
            stage: "scene_split",
          });
          return { scenes, freshCount, imageCardCount, reusedScenePlan: true };
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(runId, "warn", `Image Cut saved scene plan could not be read; replanning: ${msg.slice(0, 220)}`, {
        stage: "scene_split",
      });
    }
  }

  const opening = await splitFreshOpeningScript(
    runId,
    script,
    freshSeconds,
    scenePrompt,
    styleOverride,
    "Image Cut fresh intro"
  );
  const freshScenes = opening.scenes.map((s, i) => ({
    ...s,
    index: i,
    source_kind: "fresh" as const,
    continuity_break: i === 0 ? true : !!s.continuity_break,
  }));
  const imageCardScenes = buildImageCutCardScenes(
    opening.tailText,
    freshScenes.length,
    presetName ?? null,
    styleOverride ?? null
  );
  const scenes = [...freshScenes, ...imageCardScenes];

  if (savedForArchive) {
    try {
      fs.copyFileSync(scenesPath, path.join(runDir, `scenes.imagecut-replanned.${Date.now()}.json`));
    } catch {}
    archiveMediaForScenePlanChange(runDir);
    log(
      runId,
      "warn",
      `Image Cut scene plan was not the fresh-intro + ${IMAGE_CUT_CARD_SECONDS}s-card shape; replanned ${scenes.length} scenes and archived old media.`,
      { stage: "scene_split", data: { before: analyzeScenePlan(savedForArchive), after: analyzeScenePlan(scenes) } }
    );
  }

  log(
    runId,
    "success",
    `Image Cut plan ready: ${freshScenes.length} fresh video intro scene${freshScenes.length === 1 ? "" : "s"} + ${imageCardScenes.length} generated image card${imageCardScenes.length === 1 ? "" : "s"} (${IMAGE_CUT_CARD_SECONDS}s target).`,
    {
      stage: "scene_split",
      data: {
        freshSceneCount: freshScenes.length,
        imageCardCount: imageCardScenes.length,
        imageCardSeconds: IMAGE_CUT_CARD_SECONDS,
        imageCardTargetWords: IMAGE_CUT_CARD_TARGET_WORDS,
        imageCardChunkTargetWords: IMAGE_CUT_CARD_CHUNK_TARGET_WORDS,
        imageCardMaxWords: IMAGE_CUT_CARD_MAX_WORDS,
      },
    }
  );

  return {
    scenes,
    freshCount: freshScenes.length,
    imageCardCount: imageCardScenes.length,
    reusedScenePlan: false,
  };
}

function buildImageCutCardScenes(
  tailText: string,
  startIndex: number,
  channelName: string | null,
  styleOverride: string | null
): Scene[] {
  if (!tailText.trim()) return [];
  const chunks = chunkTextByNarrationUnits(tailText, {
    targetWords: IMAGE_CUT_CARD_CHUNK_TARGET_WORDS,
    maxWords: IMAGE_CUT_CARD_MAX_WORDS,
  });

  return chunks.map((text, i) => {
    const scene: Scene = {
      index: startIndex + i,
      text,
      visual_prompt: "",
      duration_hint_sec: IMAGE_CUT_CARD_SECONDS,
      source_kind: "image_card",
      continuity_break: i === 0,
      continuity_group_id: null,
      continuity_hint: null,
    };
    scene.visual_prompt = fallbackImageCutPrompt(scene, channelName, styleOverride);
    return scene;
  });
}

function reusableImageCutPlan(scenes: Scene[]): boolean {
  if (!Array.isArray(scenes) || scenes.length === 0) return false;
  let tailStarted = false;
  let sawFresh = false;
  let sawImageCard = false;
  const valid = scenes.every((s) => {
    if (!s.text?.trim()) return false;
    const durationHint = Number(s.duration_hint_sec);
    if (s.source_kind === "fresh") {
      if (tailStarted) return false;
      sawFresh = true;
      return Number.isFinite(durationHint) && durationHint > 0 && durationHint <= 12;
    }
    if (s.source_kind === "image_card") {
      tailStarted = true;
      sawImageCard = true;
      return Number.isFinite(durationHint) && durationHint >= 14 && durationHint <= 30;
    }
    return false;
  });
  return valid && (sawFresh || sawImageCard);
}

/**
 * Image Cut — fresh AI video intro, then generated topic-matched 20-second
 * image cards under one continuous voiceover. The long tail is deterministic
 * so long scripts can plan immediately without a full-script scene-split call.
 */
export async function runImagePipeline(runId: string, script: string) {
  const runDir = getRunDir(runId);
  const imageDir = path.join(runDir, "images");
  const animDir = path.join(runDir, "animations");
  const audioDir = path.join(runDir, "audio");
  for (const d of [runDir, imageDir, animDir, audioDir]) fs.mkdirSync(d, { recursive: true });

  try {
    clearCancelled(runId);
    updateRun.run("running", null, runId);

    const {
      scenePrompt,
      styleOverride,
      voiceOverride,
      speedOverride,
      voiceProviderOverride,
      stabilityOverride,
      similarityOverride,
      voiceStyleOverride,
      modelOverride,
      aspectOverride,
      freshMinutesOverride,
      presetName,
    } = readPresetSnapshot(runId);

    const freshMinutes = Math.max(
      0,
      freshMinutesOverride ?? resolveHybridFreshMinutes(null, getSetting("HYBRID_FRESH_MINUTES"))
    );
    log(
      runId,
      "info",
      `Image Cut · ${freshMinutes} min fresh video intro + ${IMAGE_CUT_CARD_SECONDS}s generated image-card tail · folder: ${path.basename(runDir)}`,
      { stage: "pipeline" }
    );

    const ttsOpts = {
      voiceOverride,
      speedOverride,
      voiceProviderOverride,
      stabilityOverride,
      similarityOverride,
      voiceStyleOverride,
    };
    const videoOpts: VideoOpts = { styleOverride, modelOverride, aspectOverride };

    // 1. Plan: only the selected intro is AI-split into fresh video scenes;
    // the remainder becomes deterministic 20-second generated image cards.
    const scenesPath = path.join(runDir, "scenes.json");
    const plannedScenes = await planImageCutScenes(
      runId,
      script,
      freshMinutes * 60,
      scenePrompt,
      styleOverride,
      presetName
    );
    const { scenes, freshCount, imageCardCount, reusedScenePlan } = plannedScenes;
    if (scenes.length === 0) throw new Error("Image Cut planner produced no scenes");
    checkCancelled(runId);

    if (!reusedScenePlan && scenes.filter((s) => s.source_kind === "fresh").length !== freshCount) {
      log(
        runId,
        "debug",
        `Image Cut fresh chunk count: ${freshCount}`,
        { stage: "scene_split" }
      );
    }

    // 2. Visual Director — one coherent visual world + per-scene prompts that
    //    bridge topic jumps instead of cutting to unrelated pictures.
    const hasSavedVisualPlan = reusedScenePlan && scenes.every((s) => s.visual_prompt?.trim());
    if (hasSavedVisualPlan) {
      log(runId, "info", `Image Cut: reusing saved visual plan (${scenes.length} prompts)`, { stage: "image" });
    } else if (scenes.length > IMAGE_CUT_VISUAL_DIRECTOR_MAX_SCENES) {
      log(
        runId,
        "info",
        `Image Cut: skipping Visual Director for ${scenes.length} scenes; using deterministic per-card prompts for speed.`,
        { stage: "image", data: { visualDirectorMaxScenes: IMAGE_CUT_VISUAL_DIRECTOR_MAX_SCENES } }
      );
    } else if (scenes.length > 0) {
      const directed = await planVisualThroughline(runId, {
        fullScript: script,
        chunks: scenes.map((s) => ({ index: s.index, text: s.text })),
        channelStyle: styleOverride,
        channelName: presetName,
        channelDescription: readChannelDescription(presetName),
        title: presetName,
      });
      for (const s of scenes) {
        const directedPrompt = directed.prompts[s.index];
        if (directedPrompt) {
          s.visual_prompt = sanitizeImageCutPrompt(directedPrompt);
        } else if (!s.visual_prompt.trim() || /stock b-roll|Cinematic documentary-style opening/i.test(s.visual_prompt)) {
          s.visual_prompt = fallbackImageCutPrompt(s, presetName, styleOverride);
        } else {
          s.visual_prompt = sanitizeImageCutPrompt(s.visual_prompt);
        }
      }
    }
    for (const s of scenes) {
      s.visual_prompt = sanitizeImageCutPrompt(s.visual_prompt || fallbackImageCutPrompt(s, presetName, styleOverride));
    }
    fs.writeFileSync(scenesPath, JSON.stringify(scenes, null, 2), "utf-8");
    checkCancelled(runId);

    const { keyCount, imageSlots, ttsSlots, animSlots, limitImage, limitTts, limitAnim } = await makeLimiters(runId);
    log(
      runId,
      "info",
      `Image Cut: ${freshCount} fresh AI video intro scene${freshCount === 1 ? "" : "s"} + ${imageCardCount} generated image card${imageCardCount === 1 ? "" : "s"} (${IMAGE_CUT_CARD_SECONDS}s target) over one continuous voiceover. Keys ${keyCount} · image=${imageSlots}, TTS=${ttsSlots}, video=${animSlots}`,
      { stage: "pipeline" }
    );
    const imageCutVideoTimeoutMs = positiveSettingMs(getSetting("HYBRID_VIDEO_TIMEOUT_SECONDS"), 480);
    const imageCutVideoHedgeAfterMs = positiveSettingMs(getSetting("HYBRID_VIDEO_HEDGE_AFTER_SECONDS"), 180);
    const imageCutVideoHedgeConfig = normalizeVideoHedgeConfig(
      getSetting("HYBRID_VIDEO_MAX_ATTEMPTS"),
      getSetting("HYBRID_VIDEO_MAX_PARALLEL_PER_SCENE"),
      3
    );

    // 3. One continuous voiceover + fresh videos for the intro + still images for the tail.
    const fullScript = scenes.map((s) => s.text).join(" ");
    const audioPath = path.join(runDir, "voiceover_full.mp3");
    const audioPromise = fileReady(audioPath)
      ? probeDurationSafe(audioPath).then((durationSec) => {
          log(runId, "info", "Image Cut: reusing continuous voiceover", { stage: "tts" });
          return { filePath: audioPath, durationSec };
        })
      : limitTts(() => synthesizeFullScript(runId, fullScript, audioPath, ttsOpts)).catch(async (e) => {
          const msg = e instanceof Error ? e.message : String(e);
          log(runId, "warn", `Voiceover failed, retrying once: ${msg.slice(0, 300)}`, { stage: "tts" });
          return limitTts(() => synthesizeFullScript(runId, fullScript, audioPath, ttsOpts));
        });

    const settled = await Promise.all(
      scenes.map(async (scene): Promise<ImageCutVisualInput | null> => {
        try {
          checkCancelled(runId);
          const existingImagePath = path.join(imageDir, `scene_${String(scene.index).padStart(3, "0")}.png`);
          if (scene.index < freshCount) {
            const promptedScene = withFreshPromptGuards(scene);
            const vPath = videoPathFor(animDir, scene.index);
            let videoPath = generatedVideoReady(vPath) ? vPath : null;
            let imagePath = fileReady(existingImagePath) ? existingImagePath : null;
            if (!videoPath) {
              const image = await generateFreshImageWithSimplifiedRetry(
                runId,
                promptedScene,
                imageDir,
                { styleOverride, aspectOverride },
                limitImage
              );
              imagePath = image.filePath;
              videoPath = await animateScene(runId, promptedScene, image.filePath, animDir, {
                providerJobId: image.providerJobId,
                imageProvider: image.provider,
                ...videoOpts,
                maxAttempts: imageCutVideoHedgeConfig.maxAttempts,
                timeoutMs: imageCutVideoTimeoutMs,
                hedgeAfterMs: imageCutVideoHedgeAfterMs,
                maxParallel: imageCutVideoHedgeConfig.maxParallel,
                attemptLimiter: limitAnim,
              });
            }
            if (!videoPath) throw new Error(`Scene #${scene.index} produced no fresh intro clip`);
            return {
              scene,
              imagePath: imagePath ?? videoPath,
              videoPath,
              kind: "fresh",
            };
          }
          const image = fileReady(existingImagePath)
            ? { filePath: existingImagePath }
            : await generateFreshImageWithSimplifiedRetry(
                runId,
                scene,
                imageDir,
                { styleOverride, aspectOverride },
                limitImage
              );
          return {
            scene,
            imagePath: image.filePath,
            videoPath: null,
            kind: "still",
          };
        } catch (e) {
          if (e instanceof CancelledError) throw e;
          const msg = e instanceof Error ? e.message : String(e);
          log(runId, "error", `Scene #${scene.index} failed: ${msg.slice(0, 600)}`, { stage: "pipeline" });
          return null;
        }
      })
    );
    const audio = await audioPromise;
    const items = settled.filter((x): x is ImageCutVisualInput => x !== null);
    enforceFailureThreshold(runId, scenes.length, items.length);
    if (items.length === 0) throw new Error("No visuals succeeded");

    // 4. Assemble: continuous voiceover, patterned visual cuts, mostly-static Ken Burns.
    checkCancelled(runId);
    const finalPath = await assembleImageCut(runId, items, audio.filePath, runDir);
    const assembledSec = await probeDurationSafe(finalPath);
    await applyAtmosphere(runId, finalPath, { durationSec: assembledSec, mode: "image" });
    checkCancelled(runId);
    await normalizeFinalFraming(runId, finalPath);
    checkCancelled(runId);

    try {
      const finalSec = await probeDurationSafe(finalPath);
      fs.writeFileSync(
        path.join(runDir, "sync-report.json"),
        JSON.stringify(
          {
            mode: "image",
            sceneCount: scenes.length,
            visualCount: items.length,
            freshVideoIntroScenes: freshCount,
            freshScenes: freshCount,
            stillScenes: imageCardCount,
            imageCardScenes: imageCardCount,
            imageCardTargetSec: IMAGE_CUT_CARD_SECONDS,
            imageCardTargetWords: IMAGE_CUT_CARD_TARGET_WORDS,
            imageCardChunkTargetWords: IMAGE_CUT_CARD_CHUNK_TARGET_WORDS,
            imageCardMaxWords: IMAGE_CUT_CARD_MAX_WORDS,
            planningMode: "fresh_intro_plus_20s_image_cards",
            totalSec: finalSec,
            voiceoverSec: audio.durationSec,
            visualPrerollSec: 0.35,
            totalDriftSec: Math.abs(finalSec - (audio.durationSec + 0.35)),
            continuousVoiceover: true,
            imageCutTransitions: "hard,0.16s,hard,0.24s; fresh-to-still=0.28s",
          },
          null,
          2
        ),
        "utf-8"
      );
    } catch {}

    // 5. Poster + Drive sync (best-effort) + done.
    try {
      await ensureVideoPoster(finalPath, path.join(runDir, "final-poster.jpg"));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(runId, "warn", `Poster preview failed (video is still usable): ${msg.slice(0, 160)}`, { stage: "assemble" });
    }
    const visualWeights = items.map((it) => {
      const hint = Number(it.scene.duration_hint_sec);
      return Number.isFinite(hint) && hint > 0 ? hint : 1;
    });
    const totalVisualWeight = visualWeights.reduce((sum, weight) => sum + weight, 0) || items.length || 1;
    const assets: AssembleInput[] = items.map((it, i) => ({
      scene: it.scene,
      imagePath: it.imagePath,
      videoPath: it.videoPath,
      audio: { filePath: audio.filePath, durationSec: (audio.durationSec * visualWeights[i]) / totalVisualWeight },
    }));
    completeRunThenSyncDrive(runId, finalPath, assets, runDir, "Image Cut pipeline complete");
  } catch (e) {
    handlePipelineError(runId, e);
  }
}

/** Whether a run can be resumed — needs a row + a saved scenes.json on disk. */
export function canResumeRun(runId: string): boolean {
  const row = getRunRowStmt.get(runId) as { id: string } | undefined;
  if (!row) return false;
  return fileReady(path.join(getRunDir(runId), "scenes.json"));
}
