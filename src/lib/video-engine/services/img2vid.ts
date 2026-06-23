import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { getSetting } from "../settings";
import { log } from "../logger";
import type { Scene } from "./scene-split";
import { createVideoJob, pollJob, downloadJob, cancelJob, releaseJob } from "./labs69";
import { pollTimeoutMs } from "./labs69-capacity";
import { CancelledError, checkCancelled, isCancelled, registerJob, unregisterJob } from "../cancellation";
import type { LimitFunction } from "../plimit";
import { limitHasSpareSlot, shouldLaunchVideoHedge } from "../generation-scheduler";
import { DEFAULT_ANIMATION_MODEL } from "../provider-models";

/**
 * Generates a short video clip for a scene.
 *
 * Normal scenes now run image-to-video: the pipeline first creates a still
 * keyframe, then passes that image's provider job id into the video model so
 * the first frame anchors style and subject consistency. Text-only generation
 * is still used for synthetic buffer clips and legacy/manual calls with no
 * imagePath.
 */
export async function animateScene(
  runId: string,
  scene: Scene,
  imagePath: string | null,
  outDir: string,
  options: {
    providerJobId?: string;
    imageProvider?: string;
    /** Optional per-channel video style override appended to the visual_prompt.
     *  Empty/null → fall back to the global VIDEO_STYLE setting. */
    styleOverride?: string | null;
    /** Per-channel video model — NULL → global ANIMATION_MODEL. */
    modelOverride?: string | null;
    /** Per-channel aspect ratio — NULL → global IMAGE_RATIO. */
    aspectOverride?: string | null;
    /** Optional max provider attempts. Defaults to the legacy provider policy. */
    maxAttempts?: number;
    /** Optional polling timeout for each provider attempt. */
    timeoutMs?: number;
    /** Optional limiter used per paid provider attempt. Hybrid uses this so hedges still respect global slots. */
    attemptLimiter?: LimitFunction;
    /** Delay before launching a spare-slot hedge attempt for the same scene. */
    hedgeAfterMs?: number;
    /** Maximum simultaneous attempts for this one scene. */
    maxParallel?: number;
  } = {}
): Promise<string | null> {
  const provider = (getSetting("ANIMATION_PROVIDER") || "off").toLowerCase();
  if (provider === "off") return null;

  const fileName = `scene_${String(scene.index).padStart(3, "0")}.mp4`;
  const filePath = path.join(outDir, fileName);
  const mode = imagePath ? "img2vid" : "text-to-video";

  log(runId, "info", `${mode} scene #${scene.index} (${provider})`, {
    stage: "animate",
    data: { provider, mode, prompt: scene.visual_prompt.slice(0, 120) },
  });

  if (provider === "69labs") {
    if (imagePath && options.imageProvider !== "69labs") {
      throw new Error(
        "69labs image-to-video needs a 69labs image keyframe. Set IMAGE_PROVIDER=69labs, or use a video provider that accepts local image files."
      );
    }
    if (imagePath && !options.providerJobId) {
      throw new Error("69labs image-to-video needs the source image job id; refusing to fall back to prompt-only video.");
    }
    await labs69Img2Vid(
      runId,
      scene,
      options.providerJobId,
      options.imageProvider,
      filePath,
      options.styleOverride,
      options.modelOverride,
      options.aspectOverride,
      options.maxAttempts,
      options.timeoutMs,
      options.hedgeAfterMs,
      options.maxParallel,
      options.attemptLimiter
    );
  } else {
    throw new Error(`Unsupported animation provider: ${provider}. Use 69labs.`);
  }

  log(runId, "success", `Animation done: ${fileName}`, { stage: "animate" });
  return filePath;
}

async function labs69Img2Vid(
  runId: string,
  scene: Scene,
  providerJobId: string | undefined,
  imageProvider: string | undefined,
  outPath: string,
  styleOverride?: string | null,
  modelOverride?: string | null,
  aspectOverride?: string | null,
  maxAttemptsOverride?: number,
  timeoutMsOverride?: number,
  hedgeAfterMsOverride?: number,
  maxParallelOverride?: number,
  attemptLimiter?: LimitFunction
) {
  const model = (modelOverride && modelOverride.trim()) || getSetting("ANIMATION_MODEL") || DEFAULT_ANIMATION_MODEL;
  const aspectRatio = (aspectOverride && aspectOverride.trim()) || getSetting("IMAGE_RATIO") || undefined;
  const durationSetting = getSetting("ANIMATION_DURATION") || undefined;
  // ANIMATION_KEEP_VEO_AUDIO=1 — keep generated ambient audio (default: off, mute it).
  const keepAudio = getSetting("ANIMATION_KEEP_VEO_AUDIO") === "1";

  // Video style: per-channel override wins over the global VIDEO_STYLE setting.
  // Empty/null override means "inherit global".
  const videoStyle =
    styleOverride && styleOverride.trim().length > 0
      ? styleOverride
      : getSetting("VIDEO_STYLE");
  const prompt = buildVideoPrompt(scene, videoStyle, 1);

  // If the image was generated through 69labs, pass its jobId so the API
  // reuses the cached image instead of making us re-upload bytes.
  const usableJobId = imageProvider === "69labs" ? providerJobId : undefined;

  // Duration parameter rules per model:
  //  - Veo 3.1 Fast: ignores duration entirely. Skip.
  //  - Grok Imagine Video via 69labs: gateway hard-rejects duration with
  //    HTTP 400 "Grok Video does not support duration selection" no matter
  //    what format we send ("6", "6s", "10s" — all fail). The 69labs
  //    OpenAPI spec lists duration on the endpoint but the runtime check
  //    blocks it specifically for Grok. So we skip it and 69labs returns
  //    its fixed ~6-second clip.
  //  - Other 69labs models: pass duration through with "<N>s" format.
  const isGrok = model && /^grok/i.test(model);
  const isVeo = model && /^veo/i.test(model);
  let duration: string | undefined;

  if (!isVeo && !isGrok) {
    if (durationSetting) {
      const n = parseInt(String(durationSetting).replace(/[^0-9]/g, ""), 10);
      if (Number.isFinite(n) && n > 0) duration = `${n}s`;
    } else {
      const sceneDur = Math.max(4, Math.min(8, Math.ceil(scene.duration_hint_sec || 5)));
      duration = `${sceneDur}s`;
    }
  }

  const maxParallel = Math.max(1, Math.floor(maxParallelOverride ?? 1));
  const MAX_ATTEMPTS = Math.max(maxParallel, Math.max(1, Math.floor(maxAttemptsOverride ?? 3)));
  const HEDGE_AFTER_MS = Math.max(1_000, Math.floor(hedgeAfterMsOverride ?? 180_000));
  const attemptTimeoutMs = timeoutMsOverride ?? pollTimeoutMs("videos", model);
  const scheduleAttempt = <T>(fn: () => Promise<T>) => (attemptLimiter ? attemptLimiter(fn) : fn());
  const activeJobIds = new Set<string>();
  const hedgedJobIds: string[] = [];
  const cancelledSiblingIds: string[] = [];
  const failures: string[] = [];
  const startedAt = Date.now();

  let launched = 0;
  let activeAttempts = 0;
  let completedAttempts = 0;
  let settled = false;
  let hedgeTimer: ReturnType<typeof setTimeout> | null = null;

  const clearHedgeTimer = () => {
    if (hedgeTimer) clearTimeout(hedgeTimer);
    hedgeTimer = null;
  };

  const cancelSiblings = async (winnerJobId: string) => {
    const siblings = [...activeJobIds].filter((jobId) => jobId !== winnerJobId);
    if (siblings.length === 0) return;
    log(runId, "debug", `Cancelling ${siblings.length} slower video attempt(s) for scene #${scene.index}`, {
      stage: "animate",
    });
    await Promise.all(
      siblings.map(async (jobId) => {
        unregisterJob(runId, jobId);
        activeJobIds.delete(jobId);
        const cancelled = await cancelJob("videos", jobId).catch(() => false);
        if (cancelled) cancelledSiblingIds.push(jobId);
      })
    );
  };

  const runAttempt = async (attempt: number, isHedge: boolean): Promise<{
    jobId: string;
    filePath: string;
    cleanup: CornerCleanupStatus;
    attempt: number;
    isHedge: boolean;
    elapsedMs: number;
  }> => {
    let jobId: string | null = null;
    const attemptStartedAt = Date.now();
    const candidatePath =
      maxParallel > 1 || MAX_ATTEMPTS > 1
        ? outPath.replace(/\.mp4$/i, `.attempt${String(attempt).padStart(2, "0")}.mp4`)
        : outPath;
    try {
      if (settled) throw new VideoAttemptSkipped();
      checkCancelled(runId); // before creating a paid job
      jobId = await createVideoJob({
        prompt: attempt === 1 ? prompt : buildVideoPrompt(scene, videoStyle, attempt),
        model,
        aspectRatio,
        duration,
        imageJobId: usableJobId,
        mute: !keepAudio,
        runId,
      });
      activeJobIds.add(jobId);
      if (isHedge) hedgedJobIds.push(jobId);
      // Track the job so Stop can actively cancel it (not just flip DB status).
      registerJob(runId, "videos", jobId, {
        sceneIndex: scene.index,
        model,
        attempt,
        isHedge,
        stage: "animate",
        timeoutAt: Date.now() + attemptTimeoutMs,
      });
      log(
        runId,
        "debug",
        `69labs video job ${jobId.slice(0, 8)}… (${usableJobId ? "image-to-video keyframe" : "text-only"}, model=${model ?? "default"}, timeout=${Math.round(attemptTimeoutMs / 60_000)}m, attempt=${attempt}${isHedge ? ", hedge" : ""})`,
        { stage: "animate" }
      );
      checkCancelled(runId); // before polling
      await pollJob("videos", jobId, runId, "animate", "debug", { model, timeoutMs: attemptTimeoutMs });
      checkCancelled(runId); // after polling, before download
      await downloadJob("videos", jobId, candidatePath);
      const cleanup = await cleanProviderCornerMark(runId, candidatePath, model);
      unregisterJob(runId, jobId);
      activeJobIds.delete(jobId);
      return {
        jobId,
        filePath: candidatePath,
        cleanup,
        attempt,
        isHedge,
        elapsedMs: Date.now() - attemptStartedAt,
      };
    } catch (e) {
      if (jobId) unregisterJob(runId, jobId);
      if (jobId) activeJobIds.delete(jobId);
      if (e instanceof VideoAttemptSkipped) throw e;

      // User pressed Stop: cancel the paid job and bail immediately — do NOT
      // retry (that would spend more credits on a run the user is killing).
      if (isCancelled(runId) || e instanceof CancelledError) {
        if (jobId) {
          const cancelled = await cancelJob("videos", jobId).catch(() => false);
          log(runId, "debug", `Cancelled video ${jobId.slice(0, 8)} → ${cancelled ? "ok" : "skipped"}`, {
            stage: "animate",
          });
        }
        throw e instanceof CancelledError ? e : new CancelledError(`Run ${runId} cancelled`);
      }

      const msg = e instanceof Error ? e.message : String(e);
      if (jobId) {
        if (/polling timeout/i.test(msg)) {
          const cancelled = await cancelJob("videos", jobId);
          log(runId, "debug", `Cancelled video ${jobId.slice(0, 8)} → ${cancelled ? "ok" : "skipped"}`, {
            stage: "animate",
          });
        } else {
          releaseJob(jobId);
        }
      }
      throw e;
    }
  };

  return await new Promise<void>((resolve, reject) => {
    let rejected = false;

    const failIfDone = () => {
      if (settled || rejected || activeAttempts > 0 || launched < MAX_ATTEMPTS) return;
      rejected = true;
      clearHedgeTimer();
      reject(new Error(failures.join(" | ") || "all video attempts failed"));
    };

    const launch = (isHedge: boolean) => {
      if (settled || rejected || launched >= MAX_ATTEMPTS || activeAttempts >= maxParallel) return false;
      launched++;
      activeAttempts++;
      const attempt = launched;
      if (isHedge) {
        log(runId, "warn", `Video scene #${scene.index} is slow — launching hedge attempt ${attempt}/${MAX_ATTEMPTS}`, {
          stage: "animate",
        });
      }

      scheduleAttempt(() => runAttempt(attempt, isHedge))
        .then(async (result) => {
          activeAttempts--;
          completedAttempts++;
          if (settled || rejected) {
            try {
              fs.rmSync(result.filePath, { force: true });
            } catch {}
            return;
          }
          settled = true;
          clearHedgeTimer();
          if (result.filePath !== outPath) {
            fs.renameSync(result.filePath, outPath);
          }
          await cancelSiblings(result.jobId);
          writeSceneVideoManifest(outPath, {
            sourceMode: usableJobId ? "image-to-video" : "text-to-video",
            provider: "69labs",
            imageProvider,
            imageJobId: usableJobId ?? null,
            videoJobId: result.jobId,
            winningJobId: result.jobId,
            winningAttempt: result.attempt,
            attemptCount: launched,
            completedAttemptCount: completedAttempts,
            hedgedJobIds,
            cancelledSiblingIds,
            elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(3)),
            winningAttemptElapsedSeconds: Number((result.elapsedMs / 1000).toFixed(3)),
            model: model ?? null,
            aspectRatio: aspectRatio ?? null,
            cleanup: result.cleanup,
          });
          resolve();
        })
        .catch((e) => {
          activeAttempts--;
          completedAttempts++;
          if (e instanceof VideoAttemptSkipped || settled || rejected) return;
          if (isCancelled(runId) || e instanceof CancelledError) {
            rejected = true;
            clearHedgeTimer();
            reject(e instanceof CancelledError ? e : new CancelledError(`Run ${runId} cancelled`));
            return;
          }
          const msg = e instanceof Error ? e.message : String(e);
          failures.push(`attempt ${attempt}/${MAX_ATTEMPTS}: ${msg.slice(0, 300)}`);
          if (launched < MAX_ATTEMPTS && activeAttempts < maxParallel) {
            const delay = Math.min(15_000, 5_000 * attempt);
            setTimeout(() => {
              if (!settled && !rejected) launch(true);
              failIfDone();
            }, delay).unref?.();
          } else {
            failIfDone();
          }
        });
      return true;
    };

    const scheduleHedgeCheck = (delayMs: number) => {
      if (maxParallel <= 1 || MAX_ATTEMPTS <= 1) return;
      clearHedgeTimer();
      hedgeTimer = setTimeout(() => {
        const spareSlotAvailable = attemptLimiter ? limitHasSpareSlot(attemptLimiter) : true;
        if (
          shouldLaunchVideoHedge({
            elapsedMs: Date.now() - startedAt,
            hedgeAfterMs: HEDGE_AFTER_MS,
            launchedAttempts: launched,
            activeAttempts,
            maxAttempts: MAX_ATTEMPTS,
            maxParallel,
            spareSlotAvailable,
            settled,
          })
        ) {
          launch(true);
        }
        if (!settled && !rejected && launched < MAX_ATTEMPTS && activeAttempts > 0) {
          scheduleHedgeCheck(5_000);
        }
      }, delayMs);
      hedgeTimer.unref?.();
    };

    launch(false);
    scheduleHedgeCheck(HEDGE_AFTER_MS);
  });
}

class VideoAttemptSkipped extends Error {}

const SOFT_VIDEO_MOTION_SUFFIX =
  "Video motion only: one continuous shot with no cuts, no angle switches, and no scene reset. Use visible but restrained cinematic motion: slow dolly or pan, gentle parallax, faint sail, rope, water, smoke, cloth, hand, and light movement already implied by the keyframe. Keep every main object, person, prop, and ship feature stable from the first frame to the last; no new lamps, people, papers, furniture, text, captions, logos, watermarks, modern objects, or disappearing objects. Avoid busy hand/page actions unless the hand and papers are already clearly visible in the keyframe; prefer steady environmental motion over near-still frames.";

function buildVideoPrompt(scene: Scene, videoStyle: string | null | undefined, attempt: number): string {
  const style = videoStyle?.trim();
  if (attempt <= 1) {
    return [scene.visual_prompt, style, SOFT_VIDEO_MOTION_SUFFIX].filter(Boolean).join(". ");
  }
  return [
    `Historical maritime documentary video for this narration beat: "${scene.text.slice(0, 260)}".`,
    "Use the supplied keyframe as the exact first frame and preserve its ship, harbour, chart, deck, people, props, lighting, and composition.",
    style,
    SOFT_VIDEO_MOTION_SUFFIX,
  ]
    .filter(Boolean)
    .join(" ");
}

type CornerCleanupStatus =
  | { status: "cleaned"; method: string; cropPercent: number }
  | { status: "disabled"; message: string }
  | { status: "not_applicable"; message: string }
  | { status: "missing"; message: string }
  | { status: "failed"; message: string };

async function cleanProviderCornerMark(runId: string, filePath: string, model?: string | null): Promise<CornerCleanupStatus> {
  if (getSetting("CLEAN_PROVIDER_WATERMARK") === "0") {
    return { status: "disabled", message: "CLEAN_PROVIDER_WATERMARK=0" };
  }
  if (!/^veo/i.test(model ?? "")) {
    return { status: "not_applicable", message: "Current video model does not use the provider corner mark cleanup." };
  }
  if (!fs.existsSync(filePath)) return { status: "missing", message: "Downloaded video file was not found." };

  const tmp = filePath.replace(/\.mp4$/i, ".cleaned.mp4");
  try {
    await runFfmpeg([
      "-y",
      "-i",
      filePath,
      "-vf",
      "crop=trunc(iw*0.90/2)*2:trunc(ih*0.90/2)*2:0:0",
      "-map",
      "0:v:0",
      "-map",
      "0:a?",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "copy",
      "-movflags",
      "+faststart",
      tmp,
    ]);
    fs.renameSync(tmp, filePath);
    log(runId, "debug", `Cleaned provider corner mark: ${path.basename(filePath)}`, { stage: "animate" });
    return { status: "cleaned", method: "crop-top-left-90-percent", cropPercent: 90 };
  } catch (e) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {}
    const msg = e instanceof Error ? e.message : String(e);
    log(runId, "warn", `Corner-mark cleanup skipped for ${path.basename(filePath)}: ${msg.slice(0, 220)}`, {
      stage: "animate",
    });
    return { status: "failed", message: msg.slice(0, 500) };
  }
}

function writeSceneVideoManifest(outPath: string, manifest: Record<string, unknown>): void {
  try {
    const stat = fs.statSync(outPath);
    fs.writeFileSync(
      outPath.replace(/\.mp4$/i, ".manifest.json"),
      JSON.stringify(
        {
          createdAt: new Date().toISOString(),
          target: path.basename(outPath),
          fileSize: stat.size,
          fileMtimeMs: stat.mtimeMs,
          ...manifest,
        },
        null,
        2
      ),
      "utf-8"
    );
  } catch {
    /* best-effort generation evidence */
  }
}

function runFfmpeg(args: string[]): Promise<void> {
  const cmd = getSetting("FFMPEG_PATH").trim() || "ffmpeg";
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += String(d);
      if (stderr.length > 3000) stderr = stderr.slice(-3000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-800)}`));
    });
  });
}
