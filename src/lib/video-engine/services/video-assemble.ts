import path from "node:path";
import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import ffmpeg from "fluent-ffmpeg";
import { bundledFfprobe } from "../ffmpeg-bin";
import { getSetting } from "../settings";
import { log } from "../logger";
import { pLimit } from "../plimit";
import { DATA_DIR } from "../run-paths";
import { CancelledError, checkCancelled, isCancelled, registerLocalProcess } from "../cancellation";
import {
  frameNormalizeFilter,
  frameNormalizeFilterHiRes,
  hybridSceneAVVideoFilter,
  imageCutTransitionForBoundary,
  tailClipVideoFilter,
} from "../video-quality";
import type { FrameCrop, ImageCutTransition } from "../video-quality";
import type { Scene } from "./scene-split";
import type { TtsResult } from "./tts";

export { imageCutTransitionForBoundary } from "../video-quality";
export type { FrameCrop, ImageCutTransition, ImageCutTransitionKind } from "../video-quality";
type FfmpegCommand = ReturnType<typeof ffmpeg>;

const ASSEMBLY_AUDIO_SAMPLE_RATE = 44100;

export interface AssembleInput {
  scene: Scene;
  imagePath: string;
  videoPath?: string | null;
  audio: TtsResult;
  sourceMode?: string | null;
  fallbackKind?: "still-motion" | "stock" | null;
}

export interface ImageCutVisualInput {
  scene: Scene;
  imagePath: string;
  videoPath?: string | null;
  kind: "fresh" | "still";
}

interface FramingReportEntry {
  input: string;
  output?: string;
  crop: FrameCrop | null;
  width?: number | null;
  height?: number | null;
  sar?: string | null;
  dar?: string | null;
}

interface FramingReport {
  createdAt: string;
  targetWidth: number;
  targetHeight: number;
  entries: FramingReportEntry[];
  final?: FramingReportEntry;
}

/**
 * Builds the final video using random Ken-Burns clips + xfade transitions.
 *
 * Steps:
 *  1. For each scene render a clip whose duration matches its audio (measured via ffprobe).
 *     - Ken-Burns: random zoom-in (1.0→1.18) or zoom-out (1.18→1.0)
 *     - If videoPath (img2vid) is provided, that clip is used as the base instead
 *  2. Concat all clips with xfade on the boundaries (smooth crossfade).
 *     - If TRANSITION_DURATION = 0 → simple concat without transitions.
 */
export async function assembleVideo(
  runId: string,
  scenes: AssembleInput[],
  outDir: string,
  /** Per-channel scene-end pause (seconds). null/undefined → global SCENE_TAIL_SILENCE. */
  pauseOverride?: number | null
): Promise<string> {
  ensureFfmpegPaths();

  const resolution = getSetting("VIDEO_RESOLUTION") || "1920x1080";
  const fps = Number(getSetting("VIDEO_FPS") || "30");
  const transitionSec = Number(getSetting("TRANSITION_DURATION") || "0.5");
  const tailSilence = Math.max(
    0,
    pauseOverride != null ? pauseOverride : Number(getSetting("SCENE_TAIL_SILENCE") || "0.4")
  );
  const assembleConcurrency = Math.max(1, Number(getSetting("ASSEMBLE_CONCURRENCY") || "4"));
  const [w, h] = resolution.split("x").map(Number);

  const clipsDir = path.join(outDir, "clips");
  if (!fs.existsSync(clipsDir)) fs.mkdirSync(clipsDir, { recursive: true });

  log(runId, "info", `Assembling ${scenes.length} clips (${resolution} @${fps}fps, ${assembleConcurrency} in parallel)`, {
    stage: "assemble",
  });

  // 1. Render individual clips in PARALLEL (was sequential before).
  //    Preserve ordering by index — Promise.all does not guarantee completion order.
  const limitClip = pLimit(assembleConcurrency);
  const indexed: ({ path: string; durationSec: number; index: number })[] = await Promise.all(
    scenes.map((item) =>
      limitClip(async () => {
        const clipPath = path.join(
          clipsDir,
          `clip_${String(item.scene.index).padStart(3, "0")}.mp4`
        );
        const audioDuration = await probeDuration(item.audio.filePath);
        // Total clip duration = audio + silence padding at the end so consecutive
        // scenes get a natural breath between them after concat.
        const clipDuration = audioDuration + tailSilence;
        if (item.videoPath) {
          await renderAnimatedClip(item.videoPath, item.audio.filePath, clipPath, w, h, fps, clipDuration, tailSilence);
        } else {
          const zoomDirection: "in" | "out" = Math.random() < 0.5 ? "in" : "out";
          await renderKenBurnsClip(item.imagePath, item.audio.filePath, clipPath, w, h, fps, clipDuration, zoomDirection, tailSilence);
        }
        log(
          runId,
          "info",
          `Clip #${item.scene.index} (${audioDuration.toFixed(1)}s audio + ${tailSilence}s silence = ${clipDuration.toFixed(1)}s, ${item.videoPath ? "img2vid" : "ken-burns"}) done`,
          { stage: "assemble" }
        );
        return { path: clipPath, durationSec: clipDuration, index: item.scene.index };
      })
    )
  );
  indexed.sort((a, b) => a.index - b.index);
  const clipInfos = indexed.map((c) => ({ path: c.path, durationSec: c.durationSec }));

  // 2. Concat
  const finalPath = path.join(outDir, "final.mp4");
  if (transitionSec > 0 && clipInfos.length >= 2) {
    // For large clip counts, split into N chunks and crossfade each chunk
    // in parallel before doing one final crossfade across the chunks.
    // FFmpeg's chained xfade graph is serial (each xfade depends on the
    // previous output), so a single 100-clip xfade can't use multiple cores.
    // Running 4 chunk xfades in parallel saturates a modern CPU.
    const xfadeChunks = Math.max(1, Number(getSetting("ASSEMBLE_XFADE_CHUNKS") || "4"));
    if (xfadeChunks > 1 && clipInfos.length >= xfadeChunks * 3) {
      await concatWithCrossfadeChunked(runId, clipInfos, clipsDir, finalPath, transitionSec, fps, xfadeChunks);
    } else {
      await concatWithCrossfade(clipInfos, finalPath, transitionSec, fps);
      log(runId, "info", `Crossfade ${transitionSec}s across ${clipInfos.length} scenes`, { stage: "assemble" });
    }
  } else {
      await concatSimple(clipInfos.map((c) => c.path), clipsDir, finalPath, runId, "final stream-copy concat");
  }

  await cleanFinalCornerMark(runId, finalPath, w, h, scenes.map((s) => s.videoPath).filter(Boolean) as string[]);
  log(runId, "success", `Final video: ${finalPath}`, { stage: "assemble" });
  return finalPath;
}

/** Points fluent-ffmpeg at the ffmpeg/ffprobe binaries from the FFMPEG_PATH setting. */
function ensureFfmpegPaths(): void {
  const ffmpegPath = getSetting("FFMPEG_PATH");
  if (!ffmpegPath) return;
  ffmpeg.setFfmpegPath(ffmpegPath);
  // ffprobe lives next to ffmpeg in the same bin/ folder, or comes bundled.
  const ffprobePath = ffmpegPath.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
  const probe = fs.existsSync(ffprobePath) ? ffprobePath : bundledFfprobe();
  if (probe) ffmpeg.setFfprobePath(probe);
}

/** Reads the exact audio duration via ffprobe. */
function probeDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(err);
      const d = data.format?.duration;
      if (typeof d !== "number" || !isFinite(d)) {
        // Fallback: estimate from file size
        const stat = fs.statSync(filePath);
        return resolve(Math.max(1, stat.size / 16000));
      }
      resolve(d);
    });
  });
}

/**
 * Best-effort media duration in seconds — safe to call from any pipeline stage.
 *
 * Unlike probeDuration(), this sets the ffmpeg/ffprobe paths first, so it works
 * standalone (e.g. from tts.ts right after a file is written, long before
 * assembleVideo runs). On ANY ffprobe failure it falls back to a rough
 * file-size estimate and never throws.
 */
export async function probeDurationSafe(filePath: string): Promise<number> {
  try {
    ensureFfmpegPaths();
    return await probeDuration(filePath);
  } catch {
    try {
      return Math.max(1, fs.statSync(filePath).size / 16000);
    } catch {
      return 1;
    }
  }
}

function ffmpegBin(): string {
  return getSetting("FFMPEG_PATH").trim() || "ffmpeg";
}

function probeVideoFrame(filePath: string): Promise<FramingReportEntry> {
  return new Promise((resolve) => {
    ensureFfmpegPaths();
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return resolve({ input: filePath, crop: null });
      const stream = data.streams?.find((s) => s.codec_type === "video");
      resolve({
        input: filePath,
        crop: null,
        width: typeof stream?.width === "number" ? stream.width : null,
        height: typeof stream?.height === "number" ? stream.height : null,
        sar: typeof stream?.sample_aspect_ratio === "string" ? stream.sample_aspect_ratio : null,
        dar: typeof stream?.display_aspect_ratio === "string" ? stream.display_aspect_ratio : null,
      });
    });
  });
}

function probeAudioSampleRate(filePath: string): Promise<number | null> {
  return new Promise((resolve) => {
    ensureFfmpegPaths();
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return resolve(null);
      const stream = data.streams?.find((s) => s.codec_type === "audio");
      const sampleRate = Number(stream?.sample_rate);
      resolve(Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : null);
    });
  });
}

async function detectLetterboxCrop(filePath: string): Promise<FrameCrop | null> {
  const frame = await probeVideoFrame(filePath);
  const sourceW = frame.width ?? 0;
  const sourceH = frame.height ?? 0;
  if (sourceW <= 0 || sourceH <= 0) return null;

  const args = [
    "-hide_banner",
    "-ss",
    "0.25",
    "-i",
    filePath,
    "-t",
    "1.25",
    "-vf",
    "cropdetect=limit=24:round=2:reset=0",
    "-f",
    "null",
    "-",
  ];
  const stderr = await runFfmpegCapture(args).catch(() => "");
  const matches = [...stderr.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
  if (matches.length === 0) return null;

  let best: FrameCrop | null = null;
  for (const match of matches) {
    const crop: FrameCrop = {
      w: Number(match[1]),
      h: Number(match[2]),
      x: Number(match[3]),
      y: Number(match[4]),
      sourceW,
      sourceH,
    };
    if (!isSafeLetterboxCrop(crop)) continue;
    if (!best || crop.w * crop.h > best.w * best.h) best = crop;
  }
  return best;
}

function isSafeLetterboxCrop(crop: FrameCrop): boolean {
  const widthRatio = crop.w / crop.sourceW;
  const heightRatio = crop.h / crop.sourceH;
  const horizontalBars = widthRatio >= 0.96 && heightRatio >= 0.65 && heightRatio <= 0.98 && crop.y > 0;
  const verticalBars = heightRatio >= 0.96 && widthRatio >= 0.65 && widthRatio <= 0.98 && crop.x > 0;
  return horizontalBars || verticalBars;
}

function runFfmpegCapture(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegBin(), args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += String(d);
      if (stderr.length > 12000) stderr = stderr.slice(-12000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stderr);
      else reject(new Error(stderr.slice(-1000)));
    });
  });
}

function readFramingReport(outDir: string, w: number, h: number): FramingReport {
  const reportPath = path.join(outDir, "framing-report.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(reportPath, "utf-8")) as FramingReport;
    if (Array.isArray(parsed.entries)) return parsed;
  } catch {}
  return { createdAt: new Date().toISOString(), targetWidth: w, targetHeight: h, entries: [] };
}

function writeFramingReport(outDir: string, report: FramingReport): void {
  try {
    fs.writeFileSync(path.join(outDir, "framing-report.json"), JSON.stringify(report, null, 2), "utf-8");
  } catch {
    /* best-effort quality evidence */
  }
}

async function appendFramingEntry(outDir: string, w: number, h: number, entry: FramingReportEntry): Promise<void> {
  const report = readFramingReport(outDir, w, h);
  report.entries.push(entry);
  writeFramingReport(outDir, report);
}

export async function normalizeFinalFraming(runId: string, finalPath: string): Promise<void> {
  if (!fs.existsSync(finalPath)) return;
  checkCancelled(runId);
  ensureFfmpegPaths();
  const [w, h] = (getSetting("VIDEO_RESOLUTION") || "1920x1080").split("x").map(Number);
  const outDir = path.dirname(finalPath);
  const tmp = finalPath.replace(/\.mp4$/i, ".framed.mp4");
  const initial = await probeVideoFrame(finalPath);
  const crop = await detectLetterboxCrop(finalPath);
  if (!crop && isTargetFrame(initial, w, h)) {
    const report = readFramingReport(outDir, w, h);
    report.final = { ...initial, crop: null };
    writeFramingReport(outDir, report);
    log(runId, "info", `Framing already normalized (${w}x${h}) — skipped full-video re-encode`, {
      stage: "assemble",
    });
    return;
  }

  const filter = frameNormalizeFilter(w, h, crop);
  const cmd = ffmpeg(finalPath)
    .videoFilters(filter)
    .outputOptions([
      "-map 0:v:0",
      "-map 0:a?",
      "-c:v libx264",
      "-preset veryfast",
      "-crf 18",
      "-pix_fmt yuv420p",
      "-c:a copy",
      "-movflags +faststart",
      ...finalPostprocessThreadOptions(),
    ]);
  await saveRegisteredFfmpeg(runId, "final framing normalization", cmd, tmp);
  checkCancelled(runId);
  fs.renameSync(tmp, finalPath);
  try {
    fs.rmSync(path.join(outDir, "final-poster.jpg"), { force: true });
  } catch {}
  const final = await probeVideoFrame(finalPath);
  const report = readFramingReport(outDir, w, h);
  report.final = { ...final, crop };
  writeFramingReport(outDir, report);
  log(runId, "success", `Framing normalized (${w}x${h}, square pixels${crop ? ", bars cropped" : ""})`, {
    stage: "assemble",
  });
}

function isTargetFrame(frame: FramingReportEntry, w: number, h: number): boolean {
  const sar = frame.sar ?? "1:1";
  return frame.width === w && frame.height === h && (sar === "1:1" || sar === "0:1" || sar === "N/A");
}

function finalPostprocessThreadOptions(): string[] {
  const configured = Number(getSetting("FINAL_POSTPROCESS_THREADS") || "");
  if (!Number.isFinite(configured) || configured <= 0) return [];
  return [`-threads ${Math.floor(configured)}`];
}

function saveRegisteredFfmpeg(runId: string, label: string, cmd: FfmpegCommand, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const unregister = registerLocalProcess(runId, label, { kill: (signal) => cmd.kill(signal ?? "SIGTERM") });
    cmd
      .on("error", (err) => {
        unregister();
        reject(isCancelled(runId) ? new CancelledError(`Run ${runId} cancelled by user`) : err);
      })
      .on("end", () => {
        unregister();
        resolve();
      })
      .save(outPath);
  });
}

function saveFfmpeg(cmd: FfmpegCommand, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    cmd
      .on("error", reject)
      .on("end", () => resolve())
      .save(outPath);
  });
}

/**
 * Ken-Burns clip: still image with a slow zoom plus optional gentle pan.
 * direction = 'in' → 1.0 → 1.18, 'out' → 1.18 → 1.0.
 */
function renderKenBurnsClip(
  imagePath: string,
  audioPath: string,
  outPath: string,
  w: number,
  h: number,
  fps: number,
  durationSec: number,
  direction: "in" | "out",
  tailSilenceSec: number = 0
): Promise<void> {
  const totalFrames = Math.max(2, Math.ceil(durationSec * fps));
  const minZoom = 1.0;
  const maxZoom = 1.18;

  // zoom expression — linear interpolation through `on` (output frame index)
  const zoomExpr =
    direction === "in"
      ? `min(${minZoom}+(${maxZoom}-${minZoom})*on/${totalFrames - 1},${maxZoom})`
      : `max(${maxZoom}-(${maxZoom}-${minZoom})*on/${totalFrames - 1},${minZoom})`;

  // Slight random pan: choose one of 5 trajectories
  const panChoice = Math.floor(Math.random() * 5);
  let xExpr = `iw/2-(iw/zoom/2)`; // center
  let yExpr = `ih/2-(ih/zoom/2)`;
  switch (panChoice) {
    case 1: // top-left → bottom-right drift
      xExpr = `(iw-iw/zoom)*on/${totalFrames - 1}`;
      yExpr = `(ih-ih/zoom)*on/${totalFrames - 1}`;
      break;
    case 2: // top-right → bottom-left
      xExpr = `(iw-iw/zoom)*(1-on/${totalFrames - 1})`;
      yExpr = `(ih-ih/zoom)*on/${totalFrames - 1}`;
      break;
    case 3: // bottom-left → top-right
      xExpr = `(iw-iw/zoom)*on/${totalFrames - 1}`;
      yExpr = `(ih-ih/zoom)*(1-on/${totalFrames - 1})`;
      break;
    case 4: // bottom-right → top-left
      xExpr = `(iw-iw/zoom)*(1-on/${totalFrames - 1})`;
      yExpr = `(ih-ih/zoom)*(1-on/${totalFrames - 1})`;
      break;
    // case 0 — center, no pan
  }

  // Upscale the input ×2 so the zoom doesn't blur; force square pixels so
  // slightly-off provider image sizes (e.g. 1376x768) never widen in players.
  const filter = `${frameNormalizeFilterHiRes(w, h)},zoompan=z='${zoomExpr}':x='${xExpr}':y='${yExpr}':d=${totalFrames}:s=${w}x${h}:fps=${fps},setsar=1,format=yuv420p,setparams=range=tv`;

  return new Promise((resolve, reject) => {
    const cmd = ffmpeg()
      .input(imagePath)
      .inputOptions(["-loop 1"])
      .input(audioPath)
      .videoFilters(filter);
    // Pad audio with silence at the end so consecutive scenes get a breath.
    if (tailSilenceSec > 0) {
      cmd.audioFilters(`apad=pad_dur=${tailSilenceSec.toFixed(3)}`);
    }
    cmd
      .outputOptions([
        `-r ${fps}`,
        `-t ${durationSec.toFixed(3)}`,
        "-c:v libx264",
        "-preset veryfast",
        "-crf 23",
        "-pix_fmt yuv420p",
        "-c:a aac",
        "-ar", String(ASSEMBLY_AUDIO_SAMPLE_RATE),
        "-b:a 192k",
        "-movflags +faststart",
      ])
      .on("error", reject)
      .on("end", () => resolve())
      .save(outPath);
  });
}

/** img2vid clip: render the Veo clip with its length matched to the TTS audio.
 *
 *  Veo always produces a fixed-length clip (4/6/8 s — capped at 8 s). When the
 *  TTS narration for a scene runs LONGER than the Veo clip we used to loop the
 *  Veo input with `-stream_loop -1` and rely on `-t` to cut. That made the clip
 *  visibly restart from frame 1 around the 7-8 s mark — the "scene replays"
 *  glitch users noticed on long sentences.
 *
 *  New strategy (no more abrupt loop):
 *    1. If audio ≤ video: just cut with `-t` (no transform).
 *    2. If audio overruns up to 1.5×: time-stretch the Veo clip with `setpts`
 *       (subtle slow-motion that documentary viewers won't notice).
 *    3. If audio overruns more: stretch to 1.5× then freeze the LAST frame
 *       via `tpad=stop_mode=clone` for the remaining time. Better than a
 *       jarring restart, and feels like the camera "settling".
 *
 *  Audio comes ONLY from the TTS mp3 (input 1) — Veo's own audio (input 0) is
 *  dropped via explicit -map.
 */
async function renderAnimatedClip(
  videoPath: string,
  audioPath: string,
  outPath: string,
  w: number,
  h: number,
  fps: number,
  durationSec: number,
  tailSilenceSec: number = 0
): Promise<void> {
  const videoDur = await probeDuration(videoPath);
  const crop = await detectLetterboxCrop(videoPath);

  let videoFilter = frameNormalizeFilter(w, h, crop);
  if (durationSec > videoDur + 0.05) {
    // Drop MAX_STRETCH from 1.5 to 1.15. Past ~1.15 the effective motion FPS
    // drops below ~21 (24 / 1.15) and the image looks juddery — that's the
    // "low FPS / picture jumps" symptom users have complained about.
    // We'd rather freeze the last frame than stretch into ugly slow-mo.
    const MAX_STRETCH = 1.15;
    const stretchFactor = Math.min(durationSec / videoDur, MAX_STRETCH);
    if (stretchFactor > 1.01) {
      // CRITICAL: setpts alone makes ffmpeg space the SAME frames over a
      // longer timeline → effective motion FPS = source_fps / stretchFactor.
      // Pair it with `fps=N` so ffmpeg duplicates frames at the target rate
      // and the playback timing stays uniform. (Real motion interpolation
      // would need `minterpolate`, but that's too slow for batch.)
      videoFilter = `setpts=${stretchFactor.toFixed(3)}*PTS,fps=${fps},${videoFilter}`;
    }
    const stretchedDur = videoDur * stretchFactor;
    const freezeNeeded = Math.max(0, durationSec - stretchedDur);
    if (freezeNeeded > 0.05) {
      videoFilter = `${videoFilter},tpad=stop_mode=clone:stop_duration=${freezeNeeded.toFixed(3)}`;
    }
  }

  return new Promise((resolve, reject) => {
    const cmd = ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .videoFilters(videoFilter);
    if (tailSilenceSec > 0) {
      cmd.audioFilters(`apad=pad_dur=${tailSilenceSec.toFixed(3)}`);
    }
    cmd
      .outputOptions([
        // Explicit stream mapping — drops Veo's audio even if `mute` didn't work
        "-map", "0:v:0",
        "-map", "1:a:0",
        `-r ${fps}`,
        `-t ${durationSec.toFixed(3)}`,
        "-c:v libx264",
        "-preset veryfast",
        "-crf 23",
        "-pix_fmt yuv420p",
        "-c:a aac",
        "-ar", String(ASSEMBLY_AUDIO_SAMPLE_RATE),
        "-b:a 192k",
        "-movflags +faststart",
      ])
      .on("error", reject)
      .on("end", () => resolve())
      .save(outPath);
  });
}

/** Simple stream-copy concat (no transitions). */
function ffconcatLine(filePath: string): string {
  // FFmpeg concat files use single-quoted paths. Escape apostrophes so folders
  // like "Queen Anne's Revenge" do not break recovery assembly.
  return `file '${filePath.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`;
}

function fileReady(filePath: string): boolean {
  try {
    return fs.statSync(filePath).size > 0;
  } catch {
    return false;
  }
}

async function concatSimple(
  clipPaths: string[],
  clipsDir: string,
  finalPath: string,
  runId?: string,
  label = "stream-copy concat"
): Promise<void> {
  const listFile = path.join(clipsDir, `concat_${randomUUID().slice(0, 8)}.txt`);
  fs.writeFileSync(listFile, clipPaths.map(ffconcatLine).join("\n"), "utf-8");
  const cmd = ffmpeg()
    .input(listFile)
    .inputOptions(["-f concat", "-safe 0"])
    .outputOptions(["-c copy"]);
  try {
    if (runId) await saveRegisteredFfmpeg(runId, label, cmd, finalPath);
    else await saveFfmpeg(cmd, finalPath);
  } finally {
    try {
      fs.rmSync(listFile, { force: true });
    } catch {}
  }
}

async function normalizeConcatAudioSampleRate(
  runId: string,
  clipPath: string,
  outDir: string,
  index: number
): Promise<string> {
  const sampleRate = await probeAudioSampleRate(clipPath);
  if (sampleRate === ASSEMBLY_AUDIO_SAMPLE_RATE) return clipPath;

  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `part_${String(index).padStart(3, "0")}.mp4`);
  try {
    fs.rmSync(outPath, { force: true });
  } catch {}

  const label =
    sampleRate && Number.isFinite(sampleRate)
      ? `hybrid concat audio normalize ${sampleRate}Hz to ${ASSEMBLY_AUDIO_SAMPLE_RATE}Hz #${index + 1}`
      : `hybrid concat audio normalize #${index + 1}`;
  const cmd = ffmpeg()
    .input(clipPath)
    .outputOptions([
      "-map", "0:v:0",
      "-map", "0:a:0",
      "-c:v copy",
      "-c:a aac",
      "-ar", String(ASSEMBLY_AUDIO_SAMPLE_RATE),
      "-b:a 192k",
      "-movflags +faststart",
      "-avoid_negative_ts make_zero",
    ]);
  await saveRegisteredFfmpeg(runId, label, cmd, outPath);
  return outPath;
}

async function concatHybridParts(
  runId: string,
  clipPaths: string[],
  clipsDir: string,
  finalPath: string
): Promise<void> {
  const sampleRates = await Promise.all(clipPaths.map((p) => probeAudioSampleRate(p)));
  const needsAudioNormalize = sampleRates.some((rate) => rate !== ASSEMBLY_AUDIO_SAMPLE_RATE);
  if (!needsAudioNormalize) {
    await concatSimple(clipPaths, clipsDir, finalPath, runId, "hybrid final concat");
    return;
  }

  const normalizedDir = path.join(clipsDir, "hybrid-concat-audio-normalized");
  log(
    runId,
    "warn",
    `Hybrid concat found mixed/nonstandard audio sample rates (${sampleRates.map((r) => r ?? "unknown").join(", ")}); normalizing to ${ASSEMBLY_AUDIO_SAMPLE_RATE}Hz before final join.`,
    { stage: "assemble" }
  );
  try {
    const normalizedPaths = await Promise.all(
      clipPaths.map((clipPath, index) => normalizeConcatAudioSampleRate(runId, clipPath, normalizedDir, index))
    );
    await concatSimple(normalizedPaths, clipsDir, finalPath, runId, "hybrid final concat");
  } finally {
    try {
      fs.rmSync(normalizedDir, { recursive: true, force: true });
    } catch {}
  }
}

/**
 * Chunked parallel concat-with-crossfade.
 *
 * Splits clips into N groups, runs one FFmpeg per group in parallel to xfade
 * each group into an intermediate file, then xfades the intermediates into
 * the final output. This parallelizes what is otherwise a serial xfade chain
 * (FFmpeg's xfade filter is single-threaded per pair, and consecutive xfades
 * in one filter_complex are sequentially dependent).
 *
 * On an 8-core CPU, 4 chunks of ~25 clips each gives roughly a 3-4× speedup
 * on the assembly stage versus a monolithic 100-clip xfade chain.
 */
async function concatWithCrossfadeChunked(
  runId: string,
  clips: { path: string; durationSec: number }[],
  clipsDir: string,
  finalPath: string,
  fadeDur: number,
  fps: number,
  chunkCount: number
): Promise<void> {
  // Distribute clips evenly across chunks (no chunk smaller than ~floor(N/chunks))
  const total = clips.length;
  const chunks: { path: string; durationSec: number }[][] = [];
  const baseSize = Math.floor(total / chunkCount);
  const extra = total % chunkCount;
  let cursor = 0;
  for (let i = 0; i < chunkCount; i++) {
    const size = baseSize + (i < extra ? 1 : 0);
    if (size === 0) continue;
    chunks.push(clips.slice(cursor, cursor + size));
    cursor += size;
  }

  log(
    runId,
    "info",
    `Chunked xfade: ${chunks.length} chunks × ~${baseSize}+ clips, running in parallel`,
    { stage: "assemble" }
  );

  // Build each chunk in parallel
  const chunkOutputs: { path: string; durationSec: number }[] = await Promise.all(
    chunks.map(async (chunkClips, idx) => {
      const chunkPath = path.join(clipsDir, `chunk_${String(idx).padStart(2, "0")}.mp4`);
      await concatWithCrossfade(chunkClips, chunkPath, fadeDur, fps);
      // Total duration of a chunk = sum(clip durations) - (N-1) × fadeDur (each xfade overlaps)
      const chunkDuration =
        chunkClips.reduce((s, c) => s + c.durationSec, 0) - (chunkClips.length - 1) * fadeDur;
      log(
        runId,
        "info",
        `Chunk #${idx}: ${chunkClips.length} clips → ${chunkPath} (${chunkDuration.toFixed(1)}s)`,
        { stage: "assemble" }
      );
      return { path: chunkPath, durationSec: chunkDuration };
    })
  );

  log(runId, "info", `Final pass: xfade across ${chunkOutputs.length} chunks`, { stage: "assemble" });

  // Final xfade pass across chunk outputs
  await concatWithCrossfade(chunkOutputs, finalPath, fadeDur, fps);

  // Cleanup intermediate chunk files
  for (const c of chunkOutputs) {
    try {
      fs.unlinkSync(c.path);
    } catch {}
  }
}

/**
 * Concat with xfade transitions between clips.
 * fadeDur — transition length in seconds (e.g. 0.5).
 * On each boundary, the last fadeDur seconds of clip N overlap the first fadeDur of clip N+1.
 */
function concatWithCrossfade(
  clips: { path: string; durationSec: number }[],
  finalPath: string,
  fadeDur: number,
  fps: number
): Promise<void> {
  const cmd = ffmpeg();
  for (const c of clips) cmd.input(c.path);

  // Build filter_complex: chained xfade for video + acrossfade for audio.
  let videoChain = "";
  let audioChain = "";
  let lastV = "0:v";
  let lastA = "0:a";

  // Accumulated offset for xfade: sum of (prevDuration - fadeDur)
  let cumOffset = 0;
  for (let i = 1; i < clips.length; i++) {
    cumOffset += clips[i - 1].durationSec - fadeDur;
    const vOut = `v${i}`;
    const aOut = `a${i}`;
    videoChain += `[${lastV}][${i}:v]xfade=transition=fade:duration=${fadeDur}:offset=${cumOffset.toFixed(3)}[${vOut}];`;
    audioChain += `[${lastA}][${i}:a]acrossfade=d=${fadeDur}[${aOut}];`;
    lastV = vOut;
    lastA = aOut;
  }
  // Strip trailing ;
  const filterComplex = (videoChain + audioChain).replace(/;$/, "");

  return new Promise((resolve, reject) => {
    cmd
      .complexFilter(filterComplex)
      .outputOptions([
        `-map [${lastV}]`,
        `-map [${lastA}]`,
        `-r ${fps}`,
        "-c:v libx264",
        "-preset veryfast",
        "-crf 22",
        "-pix_fmt yuv420p",
        "-c:a aac",
        "-ar", String(ASSEMBLY_AUDIO_SAMPLE_RATE),
        "-b:a 192k",
        "-movflags +faststart",
      ])
      .on("error", reject)
      .on("end", () => resolve())
      .save(finalPath);
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Image Cut assembly
//
// One continuous voiceover, one silent visual track. No inter-scene audio
// fades, no tail silence. Visual joins follow a deterministic hard/tight/soft
// pattern so the pacing breathes without becoming a slow slideshow.
// ───────────────────────────────────────────────────────────────────────────

const IMAGE_CUT_AUDIO_LEAD_SEC = 0.35;

export async function assembleImageCut(
  runId: string,
  visuals: ImageCutVisualInput[],
  audioPath: string,
  outDir: string
): Promise<string> {
  ensureFfmpegPaths();
  const resolution = getSetting("VIDEO_RESOLUTION") || "1920x1080";
  const fps = Number(getSetting("VIDEO_FPS") || "30");
  const concurrency = Math.max(1, Number(getSetting("ASSEMBLE_CONCURRENCY") || "4"));
  const [w, h] = resolution.split("x").map(Number);

  const ordered = [...visuals].sort((a, b) => a.scene.index - b.scene.index);
  if (ordered.length === 0) throw new Error("Image Cut assembly received no visuals");

  const clipsDir = path.join(outDir, "clips");
  if (!fs.existsSync(clipsDir)) fs.mkdirSync(clipsDir, { recursive: true });

  const audioDur = await probeDuration(audioPath);
  const transitions = ordered.slice(0, -1).map((item, i) =>
    imageCutTransitionForBoundary(i, item.kind, ordered[i + 1].kind)
  );
  const overlapBudget = transitions.reduce((sum, t) => sum + t.durationSec, 0);
  const durationWeights = ordered.map((v) => {
    const hint = Number(v.scene.duration_hint_sec);
    return Number.isFinite(hint) && hint > 0 ? hint : Math.max(2, wordCount(v.scene.text));
  });
  const totalDurationWeight = durationWeights.reduce((sum, n) => sum + n, 0) || ordered.length;
  const timelineBudget = audioDur + overlapBudget;

  log(
    runId,
    "info",
    `Image Cut assembly: ${ordered.length} visuals over ${audioDur.toFixed(1)}s continuous voice · transitions ${transitions.map((t) => t.kind).join("/") || "none"}`,
    { stage: "assemble" }
  );

  const limit = pLimit(concurrency);
  const rendered = await Promise.all(
    ordered.map((visual, i) =>
      limit(async () => {
        const targetSec = Math.max(2, (durationWeights[i] / totalDurationWeight) * timelineBudget) + (i === 0 ? IMAGE_CUT_AUDIO_LEAD_SEC : 0);
        const outPath = path.join(clipsDir, `clip_${String(i).padStart(3, "0")}.mp4`);
        if (fileReady(outPath)) {
          const durationSec = await probeDuration(outPath).catch(() => targetSec);
          if (Math.abs(durationSec - targetSec) <= 0.12) {
            log(
              runId,
              "info",
              `Image Cut clip ${i + 1}/${ordered.length} reused (${durationSec.toFixed(1)}s, ${visual.kind})`,
              { stage: "assemble" }
            );
            return { path: outPath, durationSec, kind: visual.kind };
          }
        }
        const result = visual.videoPath
          ? await renderImageCutVideoClip(visual.videoPath, outPath, w, h, fps, targetSec)
          : await renderImageCutStillClip(visual.imagePath, outPath, w, h, fps, targetSec);
        const frame = await probeVideoFrame(outPath);
        await appendFramingEntry(outDir, w, h, {
          ...frame,
          input: visual.videoPath || visual.imagePath,
          output: outPath,
          crop: result.crop,
        });
        log(
          runId,
          "info",
          `Image Cut clip ${i + 1}/${ordered.length} rendered (${result.durationSec.toFixed(1)}s, ${visual.kind})`,
          { stage: "assemble" }
        );
        return { path: outPath, durationSec: result.durationSec, kind: visual.kind };
      })
    )
  );

  const silentPath = path.join(outDir, "silent-image-cut.mp4");
  log(runId, "info", `Image Cut visual concat: ${rendered.length} clips`, { stage: "assemble" });
  await concatImageCutPatterned(rendered, transitions, clipsDir, silentPath, fps);
  log(runId, "info", "Image Cut visual concat complete; muxing continuous voiceover", { stage: "assemble" });

  const finalPath = path.join(outDir, "final.mp4");
  await muxAudioNoFades(silentPath, audioPath, finalPath, audioDur, IMAGE_CUT_AUDIO_LEAD_SEC);
  try {
    fs.unlinkSync(silentPath);
  } catch {}

  log(runId, "success", `Final video: ${finalPath} (${audioDur.toFixed(1)}s, continuous audio)`, { stage: "assemble" });
  return finalPath;
}

async function renderImageCutVideoClip(
  src: string,
  outPath: string,
  w: number,
  h: number,
  fps: number,
  targetSec: number
): Promise<{ durationSec: number; crop: FrameCrop | null }> {
  const native = Math.max(0.5, await probeDuration(src).catch(() => targetSec));
  const crop = await detectLetterboxCrop(src);
  const stretchFactor = targetSec > native + 0.05 ? Math.min(targetSec / native, 1.08) : 1;
  const stretchedDur = native * stretchFactor;
  const padSec = Math.max(0, targetSec - stretchedDur);
  const filter = [
    stretchFactor > 1.01 ? `setpts=${stretchFactor.toFixed(3)}*(PTS-STARTPTS)` : "setpts=PTS-STARTPTS",
    `fps=${fps}`,
    frameNormalizeFilter(w, h, crop),
    padSec > 0.05 ? `tpad=stop_mode=clone:stop_duration=${padSec.toFixed(3)}` : null,
  ].filter(Boolean).join(",");

  await new Promise<void>((resolve, reject) => {
    ffmpeg(src)
      .videoFilters(filter)
      .outputOptions([
        "-an",
        `-r ${fps}`,
        `-t ${targetSec.toFixed(3)}`,
        "-c:v libx264",
        "-preset veryfast",
        "-crf 22",
        "-pix_fmt yuv420p",
        "-movflags +faststart",
      ])
      .on("error", reject)
      .on("end", () => resolve())
      .save(outPath);
  });
  return { durationSec: targetSec, crop };
}

async function renderImageCutStillClip(
  src: string,
  outPath: string,
  w: number,
  h: number,
  fps: number,
  targetSec: number
): Promise<{ durationSec: number; crop: FrameCrop | null }> {
  const totalFrames = Math.max(2, Math.ceil(targetSec * fps));
  const zoomExpr = `min(1.0+0.035*on/${totalFrames - 1},1.035)`;
  const filter = `${frameNormalizeFilter(w, h)},zoompan=z='${zoomExpr}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${w}x${h}:fps=${fps},setsar=1,format=yuv420p,setparams=range=tv`;

  await new Promise<void>((resolve, reject) => {
    ffmpeg()
      .input(src)
      .inputOptions(["-loop 1"])
      .videoFilters(filter)
      .outputOptions([
        "-an",
        `-r ${fps}`,
        `-t ${targetSec.toFixed(3)}`,
        "-c:v libx264",
        "-preset veryfast",
        "-crf 22",
        "-pix_fmt yuv420p",
        "-movflags +faststart",
      ])
      .on("error", reject)
      .on("end", () => resolve())
      .save(outPath);
  });
  return { durationSec: targetSec, crop: null };
}

export async function renderStillMotionClip(
  runId: string,
  imagePath: string,
  outPath: string,
  durationSec: number,
  label = "still-motion fallback"
): Promise<string> {
  ensureFfmpegPaths();
  const resolution = getSetting("VIDEO_RESOLUTION") || "1920x1080";
  const fps = Number(getSetting("VIDEO_FPS") || "30");
  const [w, h] = resolution.split("x").map(Number);
  const targetSec = Math.max(2, durationSec);
  const totalFrames = Math.max(2, Math.ceil(targetSec * fps));
  const zoomExpr = `min(1.0+0.045*on/${totalFrames - 1},1.045)`;
  const filter = `${frameNormalizeFilterHiRes(w, h)},zoompan=z='${zoomExpr}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${w}x${h}:fps=${fps},setsar=1,format=yuv420p,setparams=range=tv`;
  const cmd = ffmpeg()
    .input(imagePath)
    .inputOptions(["-loop 1"])
    .videoFilters(filter)
    .outputOptions([
      "-an",
      `-r ${fps}`,
      `-t ${targetSec.toFixed(3)}`,
      "-c:v libx264",
      "-preset veryfast",
      "-crf 22",
      "-pix_fmt yuv420p",
      "-movflags +faststart",
    ]);
  await saveRegisteredFfmpeg(runId, label, cmd, outPath);
  return outPath;
}

async function concatImageCutPatterned(
  clips: { path: string; durationSec: number; kind: ImageCutVisualInput["kind"] }[],
  transitions: ImageCutTransition[],
  clipsDir: string,
  outPath: string,
  fps: number
): Promise<void> {
  if (clips.length === 1) {
    fs.copyFileSync(clips[0].path, outPath);
    return;
  }

  const groups: { clips: { path: string; durationSec: number }[]; fades: number[] }[] = [
    { clips: [{ path: clips[0].path, durationSec: clips[0].durationSec }], fades: [] },
  ];
  for (let i = 0; i < transitions.length; i++) {
    const nextClip = { path: clips[i + 1].path, durationSec: clips[i + 1].durationSec };
    const transition = transitions[i];
    if (transition.durationSec <= 0) {
      groups.push({ clips: [nextClip], fades: [] });
    } else {
      const group = groups[groups.length - 1];
      group.fades.push(transition.durationSec);
      group.clips.push(nextClip);
    }
  }

  const groupPaths: string[] = [];
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    const groupPath = path.join(clipsDir, `image_cut_group_${String(i).padStart(2, "0")}.mp4`);
    if (group.clips.length === 1) {
      fs.copyFileSync(group.clips[0].path, groupPath);
    } else {
      await concatVideoCrossfadeVariable(group.clips, group.fades, groupPath, fps);
    }
    groupPaths.push(groupPath);
  }

  if (groupPaths.length === 1) {
    fs.copyFileSync(groupPaths[0], outPath);
  } else {
    await concatSimple(groupPaths, clipsDir, outPath);
  }

  for (const p of groupPaths) {
    try {
      fs.unlinkSync(p);
    } catch {}
  }
}

function concatVideoCrossfadeVariable(
  clips: { path: string; durationSec: number }[],
  fades: number[],
  outPath: string,
  fps: number
): Promise<void> {
  const cmd = ffmpeg();
  for (const c of clips) cmd.input(c.path);
  let videoChain = "";
  let lastV = "0:v";
  let cumOffset = 0;
  for (let i = 1; i < clips.length; i++) {
    const fade = fades[i - 1] ?? 0.16;
    cumOffset += clips[i - 1].durationSec - fade;
    const vOut = `v${i}`;
    videoChain += `[${lastV}][${i}:v]xfade=transition=fade:duration=${fade.toFixed(3)}:offset=${cumOffset.toFixed(3)}[${vOut}];`;
    lastV = vOut;
  }
  return new Promise((resolve, reject) => {
    cmd
      .complexFilter(videoChain.replace(/;$/, ""))
      .outputOptions([
        `-map [${lastV}]`,
        "-an",
        `-r ${fps}`,
        "-c:v libx264",
        "-preset veryfast",
        "-crf 22",
        "-pix_fmt yuv420p",
        "-movflags +faststart",
      ])
      .on("error", reject)
      .on("end", () => resolve())
      .save(outPath);
  });
}

function muxAudioNoFades(
  videoPath: string,
  audioPath: string,
  outPath: string,
  audioDur: number,
  audioLeadSec = 0
): Promise<void> {
  return new Promise((resolve, reject) => {
    const delayMs = Math.max(0, Math.round(audioLeadSec * 1000));
    const cmd = ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .outputOptions([
        "-map 0:v:0",
        "-map 1:a:0",
        `-t ${(audioDur + audioLeadSec).toFixed(3)}`,
        "-c:v copy",
        "-c:a aac",
        "-ar", String(ASSEMBLY_AUDIO_SAMPLE_RATE),
        "-b:a 192k",
        "-movflags +faststart",
        "-shortest",
      ])
      .on("error", reject)
      .on("end", () => resolve());
    if (delayMs > 0) {
      cmd.audioFilters(`adelay=${delayMs}:all=1`);
    }
    cmd.save(outPath);
  });
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length || 1;
}

// ───────────────────────────────────────────────────────────────────────────
// Continuous voiceover assembly (Prompt 7 + 8)
//
// One TTS call produces the entire narration (no inter-scene seams). Each scene
// clip plays at its NATIVE Veo length — no slot-fitting, no freeze frames. The
// pipeline guarantees the clips together cover the audio (it generates a buffer
// clip when they're short), so after crossfade-concat + audio overlay we simply
// trim the output to the audio length. Any video overhang is cut silently; the
// only frame manipulation is the 0.5s edge fades. NO `tpad=stop_mode=clone`.
// ───────────────────────────────────────────────────────────────────────────

const CONTINUOUS_CROSSFADE = 0.3;
const EDGE_FADE = 0.5;
const MIN_CLIP_SEC = 2.0;

/** One clip to assemble. `targetSec` = the scene's narrated window to TRIM the
 *  clip to (Prompt 10); null = keep native length (used for the buffer clip). */
export interface AssemblyClip {
  path: string;
  targetSec: number | null;
}

export async function assembleContinuous(
  runId: string,
  clips: AssemblyClip[],
  audioPath: string,
  outDir: string
): Promise<string> {
  ensureFfmpegPaths();
  const resolution = getSetting("VIDEO_RESOLUTION") || "1920x1080";
  const fps = Number(getSetting("VIDEO_FPS") || "30");
  const assembleConcurrency = Math.max(1, Number(getSetting("ASSEMBLE_CONCURRENCY") || "4"));
  const [w, h] = resolution.split("x").map(Number);

  const clipsDir = path.join(outDir, "clips");
  if (!fs.existsSync(clipsDir)) fs.mkdirSync(clipsDir, { recursive: true });

  const audioDur = await probeDuration(audioPath);
  log(runId, "info", `Continuous assembly: ${clips.length} clips over ${audioDur.toFixed(1)}s of audio`, {
    stage: "assemble",
  });

  // 1. Render each clip to the output resolution, TRIMMED to its narrated window
  //    (so every scene's visual plays during its own narration — no discard).
  const limitClip = pLimit(assembleConcurrency);
  const clipInfos = await Promise.all(
    clips.map((clip, i) =>
      limitClip(async () => {
        const clipPath = path.join(clipsDir, `clip_${String(i).padStart(3, "0")}.mp4`);
        const durationSec = await renderClip(runId, i, clip, clipPath, w, h, fps);
        return { path: clipPath, durationSec };
      })
    )
  );

  // 2. Crossfade the silent clips into one video stream.
  const silentPath = path.join(outDir, "silent.mp4");
  if (clipInfos.length >= 2) {
    await concatVideoCrossfade(clipInfos, silentPath, CONTINUOUS_CROSSFADE, fps);
  } else {
    fs.copyFileSync(clipInfos[0].path, silentPath);
  }

  // 3. Lay the continuous audio over it, trim to the audio length, add edge fades.
  const finalPath = path.join(outDir, "final.mp4");
  await muxAudioWithFades(silentPath, audioPath, finalPath, audioDur, fps);
  await cleanFinalCornerMark(runId, finalPath, w, h, clips.map((clip) => clip.path));
  try {
    fs.unlinkSync(silentPath);
  } catch {}

  log(runId, "success", `Final video: ${finalPath} (${audioDur.toFixed(1)}s)`, { stage: "assemble" });
  return finalPath;
}

/**
 * Re-encode a clip to the output resolution (silent), TRIMMED to its scene's
 * narrated window when `targetSec` is set. Pure tail-cut via `-t` — no pad, no
 * freeze. `targetSec` null → keep native length (buffer clip). Returns the
 * rendered duration.
 */
async function renderClip(
  runId: string,
  index: number,
  clip: AssemblyClip,
  outPath: string,
  w: number,
  h: number,
  fps: number
): Promise<number> {
  const native = await probeDuration(clip.path);
  // Never request more than we have; floor at MIN_CLIP_SEC so a clip is watchable.
  const target =
    clip.targetSec != null ? Math.min(native, Math.max(MIN_CLIP_SEC, clip.targetSec)) : native;
  if (clip.targetSec != null) {
    log(
      runId,
      "debug",
      `trim scene_${index} from ${native.toFixed(1)}s to ${target.toFixed(1)}s`,
      { stage: "assemble" }
    );
  }
  const crop = await detectLetterboxCrop(clip.path);
  await new Promise<void>((resolve, reject) => {
    const cmd = ffmpeg()
      .input(clip.path)
      .videoFilters(frameNormalizeFilter(w, h, crop));
    const opts = ["-an", `-r ${fps}`, "-c:v libx264", "-preset veryfast", "-crf 23", "-pix_fmt yuv420p", "-movflags +faststart"];
    if (clip.targetSec != null) opts.unshift(`-t ${target.toFixed(3)}`);
    cmd
      .outputOptions(opts)
      .on("error", reject)
      .on("end", () => resolve())
      .save(outPath);
  });
  return target;
}

/**
 * Buffer-clip fallback (Prompt 8): when a fresh Veo buffer clip can't be made,
 * build a slow Ken-Burns clip from the LAST scene clip's final frame. Motion
 * (gentle zoom), never a frozen hold. Returns the path written.
 */
export async function kenBurnsBufferFromClip(
  clipPath: string,
  outPath: string,
  w: number,
  h: number,
  fps: number,
  durationSec: number
): Promise<string> {
  ensureFfmpegPaths();
  const framePath = outPath.replace(/\.mp4$/i, "_frame.png");
  // Grab a frame from very near the end of the source clip.
  await new Promise<void>((resolve, reject) => {
    ffmpeg(clipPath)
      .inputOptions(["-sseof", "-0.2"])
      .outputOptions(["-frames:v", "1", "-q:v", "2"])
      .on("error", reject)
      .on("end", () => resolve())
      .save(framePath);
  });
  const totalFrames = Math.max(2, Math.ceil(durationSec * fps));
  const zoomExpr = `min(1.0+0.12*on/${totalFrames - 1},1.12)`;
  const filter = `${frameNormalizeFilterHiRes(w, h)},zoompan=z='${zoomExpr}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${w}x${h}:fps=${fps},setsar=1,format=yuv420p,setparams=range=tv`;
  await new Promise<void>((resolve, reject) => {
    ffmpeg()
      .input(framePath)
      .inputOptions(["-loop 1"])
      .videoFilters(filter)
      .outputOptions([
        "-an",
        `-r ${fps}`,
        `-t ${durationSec.toFixed(3)}`,
        "-c:v libx264",
        "-preset veryfast",
        "-crf 23",
        "-pix_fmt yuv420p",
        "-movflags +faststart",
      ])
      .on("error", reject)
      .on("end", () => resolve())
      .save(outPath);
  });
  try {
    fs.unlinkSync(framePath);
  } catch {}
  return outPath;
}

// ───────────────────────────────────────────────────────────────────────────
// Per-scene hybrid assembly (Mission 1 + 3)
//
// Each scene has its OWN narration mp3. Each scene's video clip is rendered to
// EXACTLY that scene's audio length (padded with a held final frame if needed,
// trimmed if longer) with the narration muxed in. Then all per-scene clips are
// concatenated. Because every clip == its scene's audio, the picture can NEVER
// drift from the voice — final duration == sum of scene-audio durations.
//
// This is the sync-correct path: no word-count guessing, no continuous-audio
// re-allocation. Fresh AI clips and stock B-roll clips are treated identically.
// ───────────────────────────────────────────────────────────────────────────

export interface SceneAVItem {
  /** Ordered scene index (for clip filenames + logs). */
  index: number;
  /** The video clip (fresh AI or stock B-roll). */
  videoPath: string;
  /** This scene's narration mp3. */
  audioPath: string;
  /** Label for logs: "fresh" | "stock". */
  kind?: string;
}

/**
 * Render one scene clip to its narration length and mux the narration in.
 * Fresh AI scenes should already be split to fit the provider clip length.
 * If a scene still overruns slightly, slow the provider clip before falling
 * back to a held final frame. That keeps the end from freezing during normal
 * 8-9 second narration drift.
 */
async function renderSceneAV(
  runId: string,
  item: SceneAVItem,
  outPath: string,
  w: number,
  h: number,
  fps: number
): Promise<number> {
  const audioDur = await probeDuration(item.audioPath);
  const videoDur = await probeDuration(item.videoPath).catch(() => 0);
  const shouldExtend = videoDur > 0 && audioDur > videoDur + 0.05;
  const maxStretch = item.kind === "fresh" ? 1.15 : 1.08;
  const stretchFactor = shouldExtend ? Math.min(audioDur / videoDur, maxStretch) : 1;
  const stretchedDur = videoDur * stretchFactor;
  const padSec = shouldExtend ? Math.max(0, audioDur - stretchedDur) : 0;
  if (item.kind === "fresh" && stretchFactor > 1.01) {
    log(
      runId,
      "info",
      `Fresh clip #${item.index + 1} is ${(audioDur - videoDur).toFixed(1)}s shorter than narration; slowing ${stretchFactor.toFixed(2)}x instead of freezing.`,
      { stage: "assemble" }
    );
  }
  if (item.kind === "fresh" && padSec > 0.5) {
    log(runId, "warn", `Fresh clip #${item.index + 1} still needs ${padSec.toFixed(1)}s final-frame hold after safe stretch.`, {
      stage: "assemble",
    });
  }
  const crop = await detectLetterboxCrop(item.videoPath);
  const filters = [
    hybridSceneAVVideoFilter(w, h, crop, { padSec, stretchFactor, fps }),
  ].filter(Boolean).join(",");

  const cmd = ffmpeg();
  cmd.input(item.videoPath);
  cmd.input(item.audioPath);
  cmd
    .videoFilters(filters)
    .outputOptions([
      "-map", "0:v:0",
      "-map", "1:a:0",
      `-t ${audioDur.toFixed(3)}`,
      `-r ${fps}`,
      "-c:v libx264",
      "-preset veryfast",
      "-crf 23",
      "-pix_fmt yuv420p",
      "-c:a aac",
      "-ar", String(ASSEMBLY_AUDIO_SAMPLE_RATE),
      "-b:a 192k",
      "-movflags +faststart",
      "-shortest",
    ]);
  await saveRegisteredFfmpeg(
    runId,
    `${item.kind === "stock" ? "stock" : "fresh"} scene render #${item.index + 1}`,
    cmd,
    outPath
  );
  return audioDur;
}

export interface PerSceneAssemblyResult {
  finalPath: string;
  totalSec: number;
  /** Max |clipSec - audioSec| across scenes — should be ~0 (proof of sync). */
  maxDriftSec: number;
}

/** Concatenate multiple audio files into one mp3 (re-encode for clean joins). */
export async function concatAudioFiles(
  inputs: string[],
  outPath: string,
  runId?: string,
  label = "audio concat"
): Promise<void> {
  ensureFfmpegPaths();
  if (inputs.length === 1) {
    fs.copyFileSync(inputs[0], outPath);
    return;
  }
  const listFile = outPath.replace(/\.mp3$/i, `_alist_${randomUUID().slice(0, 8)}.txt`);
  fs.writeFileSync(listFile, inputs.map(ffconcatLine).join("\n"), "utf-8");
  const cmd = ffmpeg()
    .input(listFile)
    .inputOptions(["-f concat", "-safe 0"])
    .outputOptions(["-c:a libmp3lame", "-ar", String(ASSEMBLY_AUDIO_SAMPLE_RATE), "-b:a 192k"]);
  try {
    if (runId) await saveRegisteredFfmpeg(runId, label, cmd, outPath);
    else await saveFfmpeg(cmd, outPath);
  } finally {
    try { fs.unlinkSync(listFile); } catch {}
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Continuous-tail assembly (Mission 3, refined)
//
// The hybrid run's TAIL (everything after the fresh opening) is built here:
//   - ONE continuous voiceover (no per-scene editing) is laid over
//   - selected stock clips at their full native length, hard-cut together
//     without black seam fades, looped until the narration ends, then trimmed to the
//     exact audio length.
// Returns a single tail.mp4 (video + audio) the caller concatenates after the
// fresh per-scene section.
// ───────────────────────────────────────────────────────────────────────────

const TAIL_END_TRIM = 0.35; // avoid provider/library clips' static final frames
const NORMALIZED_STOCK_CACHE_VERSION = "tail-normalized-v1";

interface NormalizedStockManifest {
  version: string;
  sourcePath: string;
  sourceSize: number;
  sourceMtimeMs: number;
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  crop: FrameCrop | null;
  createdAt: string;
}

interface NormalizedStockResult {
  path: string;
  durationSec: number;
  cacheHit: boolean;
}

interface TailCacheProgress {
  updatedAt: string;
  normalizedCacheReadyCount: number;
  normalizedCacheMissCount: number;
  normalizedCacheBadCount: number;
  tailRenderedDurationSec: number;
  tailTargetDurationSec: number;
  tailPickedClipCount: number;
  buildingTail: boolean;
  joiningFinal: boolean;
  segmentReady: boolean;
}

interface RenderedTailStockClip {
  path: string;
  sourcePath: string;
  sourceName: string;
  index: number;
  dur: number;
  cacheHit: boolean;
}

function normalizedStockCacheDir(): string {
  return path.join(DATA_DIR, "normalized-stock-cache", NORMALIZED_STOCK_CACHE_VERSION);
}

function sourceFingerprint(src: string, w: number, h: number, fps: number): { key: string; size: number; mtimeMs: number } {
  const stat = fs.statSync(src);
  const payload = JSON.stringify({
    version: NORMALIZED_STOCK_CACHE_VERSION,
    sourcePath: path.resolve(src),
    size: stat.size,
    mtimeMs: Math.round(stat.mtimeMs),
    width: w,
    height: h,
    fps,
  });
  return {
    key: createHash("sha1").update(payload).digest("hex"),
    size: stat.size,
    mtimeMs: Math.round(stat.mtimeMs),
  };
}

function readNormalizedManifest(manifestPath: string): NormalizedStockManifest | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as NormalizedStockManifest;
    if (parsed.version !== NORMALIZED_STOCK_CACHE_VERSION) return null;
    if (!Number.isFinite(parsed.durationSec) || parsed.durationSec <= 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeTailCacheProgress(outDir: string, progress: TailCacheProgress): void {
  try {
    fs.writeFileSync(path.join(outDir, "tail-cache-progress.json"), JSON.stringify(progress, null, 2), "utf-8");
  } catch {
    /* progress is best-effort */
  }
}

function writeTailStockSequence(outDir: string, rendered: RenderedTailStockClip[]): void {
  try {
    let cursor = 0;
    const sequence = rendered.map((clip) => {
      const startSec = cursor;
      const endSec = cursor + clip.dur;
      cursor = endSec;
      return {
        index: clip.index,
        startSec: Number(startSec.toFixed(3)),
        endSec: Number(endSec.toFixed(3)),
        durationSec: Number(clip.dur.toFixed(3)),
        sourceName: clip.sourceName,
        sourcePath: clip.sourcePath,
        normalizedPath: clip.path,
        cacheHit: clip.cacheHit,
      };
    });
    fs.writeFileSync(
      path.join(outDir, "tail-stock-sequence.json"),
      JSON.stringify({ createdAt: new Date().toISOString(), clips: sequence }, null, 2),
      "utf-8"
    );
  } catch {
    /* sequence diagnostics are best-effort */
  }
}

function initialTailCacheProgress(targetSec: number): TailCacheProgress {
  return {
    updatedAt: new Date().toISOString(),
    normalizedCacheReadyCount: 0,
    normalizedCacheMissCount: 0,
    normalizedCacheBadCount: 0,
    tailRenderedDurationSec: 0,
    tailTargetDurationSec: targetSec,
    tailPickedClipCount: 0,
    buildingTail: true,
    joiningFinal: false,
    segmentReady: false,
  };
}

function markBadNormalizedStock(
  badPath: string,
  src: string,
  w: number,
  h: number,
  fps: number,
  fingerprint: { size: number; mtimeMs: number },
  reason: string
): void {
  try {
    fs.writeFileSync(
      badPath,
      JSON.stringify(
        {
          version: NORMALIZED_STOCK_CACHE_VERSION,
          sourcePath: path.resolve(src),
          sourceSize: fingerprint.size,
          sourceMtimeMs: fingerprint.mtimeMs,
          width: w,
          height: h,
          fps,
          reason: reason.slice(0, 600),
          updatedAt: new Date().toISOString(),
        },
        null,
        2
      ),
      "utf-8"
    );
  } catch {
    /* bad-clip markers are best-effort */
  }
}

async function ensureNormalizedStockClip(
  runId: string,
  src: string,
  w: number,
  h: number,
  fps: number
): Promise<NormalizedStockResult | null> {
  const cacheDir = normalizedStockCacheDir();
  fs.mkdirSync(cacheDir, { recursive: true });
  const fingerprint = sourceFingerprint(src, w, h, fps);
  const outPath = path.join(cacheDir, `${fingerprint.key}.mp4`);
  const manifestPath = path.join(cacheDir, `${fingerprint.key}.json`);
  const badPath = path.join(cacheDir, `${fingerprint.key}.bad.json`);

  const cached = readNormalizedManifest(manifestPath);
  if (cached && fileReady(outPath)) {
    return { path: outPath, durationSec: cached.durationSec, cacheHit: true };
  }
  if (fileReady(badPath)) return null;

  const tmpPath = path.join(cacheDir, `${fingerprint.key}.${process.pid}.${randomUUID().slice(0, 8)}.tmp.mp4`);
  try {
    const srcDur = await probeDuration(src).catch(() => 8);
    const usableSrcDur = srcDur > 1.25 ? Math.max(0.5, srcDur - Math.min(TAIL_END_TRIM, srcDur * 0.12)) : srcDur;
    const durationSec = Math.max(0.5, usableSrcDur);
    const crop = await detectLetterboxCrop(src);
    await new Promise<void>((resolve, reject) => {
      ffmpeg()
        .input(src)
        .videoFilters(tailClipVideoFilter(w, h, crop))
        .outputOptions([
          "-an",
          `-r ${fps}`,
          `-t ${durationSec.toFixed(3)}`,
          "-c:v libx264",
          "-preset veryfast",
          "-crf 23",
          "-pix_fmt yuv420p",
          "-movflags +faststart",
        ])
        .on("error", reject)
        .on("end", () => resolve())
        .save(tmpPath);
    });
    fs.renameSync(tmpPath, outPath);
    const actualDurationSec = await probeDuration(outPath).catch(() => durationSec);
    const manifest: NormalizedStockManifest = {
      version: NORMALIZED_STOCK_CACHE_VERSION,
      sourcePath: path.resolve(src),
      sourceSize: fingerprint.size,
      sourceMtimeMs: fingerprint.mtimeMs,
      width: w,
      height: h,
      fps,
      durationSec: actualDurationSec,
      crop,
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
    return { path: outPath, durationSec: actualDurationSec, cacheHit: false };
  } catch (e) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {}
    const msg = e instanceof Error ? e.message : String(e);
    markBadNormalizedStock(badPath, src, w, h, fps, fingerprint, msg);
    log(runId, "warn", `Marked bad stock clip ${path.basename(src)}: ${msg.slice(0, 220)}`, { stage: "assemble" });
    return null;
  }
}

/**
 * Build the tail segment: selected stock clips under a
 * continuous voiceover, trimmed to the audio length. `pickClip` yields local
 * clip paths in the caller's chosen order; Hybrid uses narration-matched stock.
 */
export async function assembleTail(
  runId: string,
  audioPath: string,
  pickClip: () => string,
  outDir: string,
  outName = "tail.mp4"
): Promise<{ path: string; durationSec: number }> {
  ensureFfmpegPaths();
  const resolution = getSetting("VIDEO_RESOLUTION") || "1920x1080";
  const fps = Number(getSetting("VIDEO_FPS") || "30");
  const concurrency = Math.max(1, Number(getSetting("ASSEMBLE_CONCURRENCY") || "4"));
  const [w, h] = resolution.split("x").map(Number);

  const tailDir = path.join(outDir, "tail-clips");
  if (!fs.existsSync(tailDir)) fs.mkdirSync(tailDir, { recursive: true });

  const audioDur = await probeDuration(audioPath);
  const targetCoverage = audioDur + 1;
  const progress = initialTailCacheProgress(targetCoverage);
  writeTailCacheProgress(outDir, progress);
  log(runId, "info", `Tail: continuous voice ${(audioDur / 60).toFixed(1)} min over selected stock clips`, {
    stage: "assemble",
  });

  // Normalize selected stock into a persistent cache, then stream-copy cached
  // clips into this run. A single corrupt or codec-weird source should not kill
  // a 2-hour run; mark it bad, skip it on future runs, and keep drawing picks
  // until the cached duration covers the narration.
  const limit = pLimit(concurrency);
  const rendered: RenderedTailStockClip[] = [];
  let renderedCoverage = 0;
  let renderIndex = 0;
  let failedCount = 0;
  let cacheHitCount = 0;
  let cacheMissCount = 0;
  let badCount = 0;
  const renderBatchSize = Math.max(1, Math.min(32, concurrency * 4));

  async function preparePickedClip(src: string, index: number) {
    const normalized = await ensureNormalizedStockClip(runId, src, w, h, fps);
    if (!normalized) {
      return { ok: false as const, index, src };
    }
    return {
      ok: true as const,
      path: normalized.path,
      sourcePath: src,
      sourceName: path.basename(src),
      index,
      dur: normalized.durationSec,
      cacheHit: normalized.cacheHit,
    };
  }

  while (renderedCoverage < targetCoverage) {
    const batch: { src: string; index: number }[] = [];
    while (batch.length < renderBatchSize && renderedCoverage < targetCoverage) {
      if (renderIndex > 10000) {
        throw new Error("Tail assembly rendered too many stock clips — check the source clip durations.");
      }
      batch.push({ src: pickClip(), index: renderIndex });
      renderIndex++;
    }

    const results = await Promise.all(batch.map(({ src, index }) => limit(() => preparePickedClip(src, index))));
    let batchAdded = 0;
    for (const result of results) {
      if (!result.ok) {
        failedCount++;
        badCount++;
        progress.normalizedCacheBadCount = badCount;
        continue;
      }
      rendered.push(result);
      renderedCoverage += result.dur;
      batchAdded += result.dur;
      if (result.cacheHit) cacheHitCount++;
      else cacheMissCount++;
    }

    progress.updatedAt = new Date().toISOString();
    progress.normalizedCacheReadyCount = cacheHitCount + cacheMissCount;
    progress.normalizedCacheMissCount = cacheMissCount;
    progress.normalizedCacheBadCount = badCount;
    progress.tailRenderedDurationSec = renderedCoverage;
    progress.tailPickedClipCount = rendered.length;
    writeTailCacheProgress(outDir, progress);

    if (batchAdded <= 0 && failedCount > 50) {
      throw new Error("Tail assembly cannot render usable stock clips — too many stock files failed.");
    }
  }
  rendered.sort((a, b) => a.index - b.index);
  writeTailStockSequence(outDir, rendered);
  log(
    runId,
    "info",
    `Tail cache ready: ${rendered.length} clips covering ${(renderedCoverage / 60).toFixed(1)} min · ${cacheHitCount} cached, ${cacheMissCount} normalized${failedCount ? ` · skipped ${failedCount} bad clip${failedCount === 1 ? "" : "s"}` : ""}`,
    { stage: "assemble" },
  );

  // Concat the silent clips, then mux the continuous audio + trim to audio.
  const silentPath = path.join(outDir, "tail-silent.mp4");
  if (fileReady(silentPath)) {
    const silentDuration = await probeDuration(silentPath).catch(() => 0);
    if (silentDuration >= Math.max(1, audioDur - 1)) {
      log(runId, "info", "Tail silent video already exists — reusing it", { stage: "assemble" });
    } else {
      log(runId, "warn", "Tail silent video was incomplete — rebuilding from normalized stock cache", { stage: "assemble" });
      try {
        fs.rmSync(silentPath, { force: true });
      } catch {}
      progress.updatedAt = new Date().toISOString();
      progress.buildingTail = false;
      progress.joiningFinal = true;
      writeTailCacheProgress(outDir, progress);
      await concatSimple(rendered.map((r) => r.path), tailDir, silentPath, runId, "tail silent concat");
    }
  } else {
    progress.updatedAt = new Date().toISOString();
    progress.buildingTail = false;
    progress.joiningFinal = true;
    writeTailCacheProgress(outDir, progress);
    await concatSimple(rendered.map((r) => r.path), tailDir, silentPath, runId, "tail silent concat");
  }

  progress.updatedAt = new Date().toISOString();
  progress.buildingTail = false;
  progress.joiningFinal = true;
  writeTailCacheProgress(outDir, progress);

  const outPath = path.join(outDir, outName);
  try {
    fs.rmSync(outPath, { force: true });
  } catch {
    /* remove partial output from interrupted mux */
  }
  const muxCmd = ffmpeg()
    .input(silentPath)
    .input(audioPath)
    .outputOptions([
      "-map", "0:v:0",
      "-map", "1:a:0",
      `-t ${audioDur.toFixed(3)}`,
      "-c:v copy",
      "-c:a aac",
      "-ar", String(ASSEMBLY_AUDIO_SAMPLE_RATE),
      "-b:a 192k",
      "-movflags +faststart",
      "-shortest",
    ]);
  await saveRegisteredFfmpeg(runId, "tail audio mux", muxCmd, outPath);
  try { fs.unlinkSync(silentPath); } catch {}
  try { fs.rmSync(tailDir, { recursive: true, force: true }); } catch {}

  const durationSec = await probeDuration(outPath).catch(() => audioDur);
  progress.updatedAt = new Date().toISOString();
  progress.buildingTail = false;
  progress.joiningFinal = false;
  progress.segmentReady = true;
  progress.tailRenderedDurationSec = durationSec;
  writeTailCacheProgress(outDir, progress);
  log(runId, "success", `Tail segment: ${(durationSec / 60).toFixed(1)} min (${rendered.length} stock clips)`, {
    stage: "assemble",
  });
  return { path: outPath, durationSec };
}

/**
 * Render the fresh per-scene clips AND (optionally) append a continuous tail
 * segment, concatenating everything into the final video. Fresh scenes stay
 * frame-synced (clip == its narration); the tail is one continuous-voice block.
 */
export async function assembleHybrid(
  runId: string,
  freshItems: SceneAVItem[],
  tail: { path: string } | null,
  outDir: string
): Promise<PerSceneAssemblyResult> {
  ensureFfmpegPaths();
  const resolution = getSetting("VIDEO_RESOLUTION") || "1920x1080";
  const fps = Number(getSetting("VIDEO_FPS") || "30");
  const concurrency = Math.max(1, Number(getSetting("ASSEMBLE_CONCURRENCY") || "4"));
  const [w, h] = resolution.split("x").map(Number);

  const clipsDir = path.join(outDir, "clips");
  if (!fs.existsSync(clipsDir)) fs.mkdirSync(clipsDir, { recursive: true });

  const ordered = [...freshItems].sort((a, b) => a.index - b.index);
  const limit = pLimit(concurrency);
  let maxDrift = 0;
  const rendered = await Promise.all(
    ordered.map((item) =>
      limit(async () => {
        const clipPath = path.join(clipsDir, `clip_${String(item.index).padStart(3, "0")}.mp4`);
        const audioDur = await renderSceneAV(runId, item, clipPath, w, h, fps);
        const clipDur = await probeDuration(clipPath).catch(() => audioDur);
        const drift = Math.abs(clipDur - audioDur);
        if (drift > maxDrift) maxDrift = drift;
        return { path: clipPath, index: item.index };
      })
    )
  );
  rendered.sort((a, b) => a.index - b.index);

  const parts = rendered.map((r) => r.path);
  if (tail) parts.push(tail.path);

  const finalPath = path.join(outDir, "final.mp4");
  await concatHybridParts(runId, parts, clipsDir, finalPath);
  await cleanFinalCornerMark(runId, finalPath, w, h, freshItems.map((item) => item.videoPath));
  const totalSec = await probeDuration(finalPath).catch(() => 0);
  log(
    runId,
    "success",
    `Final video: ${(totalSec / 60).toFixed(1)} min · fresh sync drift ≤ ${maxDrift.toFixed(3)}s${tail ? " · + continuous tail" : ""}`,
    { stage: "assemble" }
  );
  return { finalPath, totalSec, maxDriftSec: maxDrift };
}

async function cleanFinalCornerMark(
  runId: string,
  finalPath: string,
  w: number,
  h: number,
  sourceVideoPaths: string[] = []
): Promise<void> {
  if (!fs.existsSync(finalPath)) return;

  if (getSetting("CLEAN_PROVIDER_WATERMARK") === "0") {
    writeWatermarkCleanupReport(finalPath, { status: "disabled", message: "CLEAN_PROVIDER_WATERMARK=0" });
    return;
  }

  if (!shouldCleanFinalCornerMark(sourceVideoPaths)) {
    writeWatermarkCleanupReport(finalPath, {
      status: "not_applicable",
      message: "No uncleaned generated provider clips were detected in this final.",
    });
    return;
  }

  const tmp = finalPath.replace(/\.mp4$/i, ".corner-cleaned.mp4");
  try {
    const cmd = ffmpeg(finalPath)
      .videoFilters(`crop=trunc(iw*0.90/2)*2:trunc(ih*0.90/2)*2:0:0,scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`)
      .outputOptions([
        "-map 0:v:0",
        "-map 0:a?",
        "-c:v libx264",
        "-preset veryfast",
        "-crf 20",
        "-pix_fmt yuv420p",
        "-c:a copy",
        "-movflags +faststart",
        ...finalPostprocessThreadOptions(),
      ]);
    await saveRegisteredFfmpeg(runId, "final corner-mark cleanup", cmd, tmp);
    fs.renameSync(tmp, finalPath);
    try {
      fs.rmSync(path.join(path.dirname(finalPath), "final-poster.jpg"), { force: true });
    } catch {}
    writeWatermarkCleanupReport(finalPath, {
      status: "cleaned",
      method: "crop-top-left-90-percent-then-rescale",
      cropPercent: 90,
      outputWidth: w,
      outputHeight: h,
    });
    log(runId, "debug", "Cleaned final video corner mark", { stage: "assemble" });
  } catch (e) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {}
    const msg = e instanceof Error ? e.message : String(e);
    writeWatermarkCleanupReport(finalPath, { status: "failed", message: msg.slice(0, 500) });
    log(runId, "warn", `Final corner-mark cleanup skipped: ${msg.slice(0, 240)}`, { stage: "assemble" });
  }
}

function shouldCleanFinalCornerMark(sourceVideoPaths: string[]): boolean {
  for (const videoPath of sourceVideoPaths) {
    const manifestPath = videoPath.replace(/\.mp4$/i, ".manifest.json");
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as {
        sourceMode?: string;
        provider?: string;
        cleanup?: { status?: string };
      };
      if (manifest.provider !== "69labs" || manifest.sourceMode !== "image-to-video") continue;
      const cleanupStatus = manifest.cleanup?.status;
      if (cleanupStatus === "failed" || cleanupStatus === "missing") return true;
    } catch {
      continue;
    }
  }
  return false;
}

function writeWatermarkCleanupReport(finalPath: string, report: Record<string, unknown>): void {
  try {
    const stat = fs.existsSync(finalPath) ? fs.statSync(finalPath) : null;
    fs.writeFileSync(
      path.join(path.dirname(finalPath), "watermark-cleanup-report.json"),
      JSON.stringify(
        {
          enabled: getSetting("CLEAN_PROVIDER_WATERMARK") !== "0",
          createdAt: new Date().toISOString(),
          target: path.basename(finalPath),
          fileSize: stat?.size ?? null,
          fileMtimeMs: stat?.mtimeMs ?? null,
          ...report,
        },
        null,
        2
      ),
      "utf-8"
    );
  } catch {
    /* best-effort quality evidence */
  }
}

/** Video-only crossfade chain (silent clips). */
function concatVideoCrossfade(
  clips: { path: string; durationSec: number }[],
  outPath: string,
  fadeDur: number,
  fps: number
): Promise<void> {
  const cmd = ffmpeg();
  for (const c of clips) cmd.input(c.path);
  let videoChain = "";
  let lastV = "0:v";
  let cumOffset = 0;
  for (let i = 1; i < clips.length; i++) {
    cumOffset += clips[i - 1].durationSec - fadeDur;
    const vOut = `v${i}`;
    videoChain += `[${lastV}][${i}:v]xfade=transition=fade:duration=${fadeDur}:offset=${cumOffset.toFixed(3)}[${vOut}];`;
    lastV = vOut;
  }
  const filterComplex = videoChain.replace(/;$/, "");
  return new Promise((resolve, reject) => {
    cmd
      .complexFilter(filterComplex)
      .outputOptions([
        `-map [${lastV}]`,
        "-an",
        `-r ${fps}`,
        "-c:v libx264",
        "-preset veryfast",
        "-crf 22",
        "-pix_fmt yuv420p",
        "-movflags +faststart",
      ])
      .on("error", reject)
      .on("end", () => resolve())
      .save(outPath);
  });
}

/**
 * Overlay the continuous audio onto the silent video, TRIM to the audio length,
 * add 0.5s edge fades. The pipeline guarantees video ≥ audio, so trimming the
 * overhang leaves no black/freeze — no padding/clone here.
 */
async function muxAudioWithFades(
  videoPath: string,
  audioPath: string,
  outPath: string,
  audioDur: number,
  fps: number
): Promise<void> {
  const fade = Math.min(EDGE_FADE, audioDur / 2);
  const outStart = Math.max(0, audioDur - fade);

  const vchain = `fade=t=in:st=0:d=${fade.toFixed(3)},fade=t=out:st=${outStart.toFixed(3)}:d=${fade.toFixed(3)}`;
  const achain = `afade=t=in:st=0:d=${fade.toFixed(3)},afade=t=out:st=${outStart.toFixed(3)}:d=${fade.toFixed(3)}`;
  const filterComplex = `[0:v]${vchain}[v];[1:a]${achain}[a]`;

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .complexFilter(filterComplex)
      .outputOptions([
        "-map [v]",
        "-map [a]",
        `-r ${fps}`,
        `-t ${audioDur.toFixed(3)}`,
        "-c:v libx264",
        "-preset veryfast",
        "-crf 22",
        "-pix_fmt yuv420p",
        "-c:a aac",
        "-ar", String(ASSEMBLY_AUDIO_SAMPLE_RATE),
        "-b:a 192k",
        "-movflags +faststart",
      ])
      .on("error", reject)
      .on("end", () => resolve())
      .save(outPath);
  });
}
