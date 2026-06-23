import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getSetting } from "../settings";
import { log } from "../logger";
import { checkCancelled, isCancelled, registerLocalProcess } from "../cancellation";

/**
 * Always-on atmosphere pass — bakes a subtle, "more original" texture into the
 * final video for every mode:
 *   • film grain (temporal noise)
 *   • a gentle vignette
 *   • a calm filmic grade (slightly lower saturation, a touch of contrast)
 *   • a drifting smoke/haze overlay when assets/overlays/smoke.mp4 exists
 *
 * Best-effort by design: on ANY failure the original final video is kept
 * untouched, so a bad filter or missing ffmpeg can never break a run.
 */
const OVERLAY_DIR = path.join(process.cwd(), "assets", "overlays");
const SMOKE_PATH = path.join(OVERLAY_DIR, "smoke.mp4");

const BASE_CHAIN =
  "format=yuv420p,noise=alls=7:allf=t+u,eq=saturation=0.93:contrast=1.04:brightness=-0.01,vignette=PI/5";
const SHORT_VIDEO_ATMOSPHERE_LIMIT_SEC = 3 * 60;

export async function applyAtmosphere(
  runId: string,
  finalPath: string,
  opts: { durationSec?: number | null; mode?: string | null } = {}
): Promise<void> {
  if (!finalPath || !fs.existsSync(finalPath)) return;
  checkCancelled(runId);

  const decision = atmosphereDecision(opts.durationSec);
  if (!decision.apply) {
    log(runId, "info", decision.reason, { stage: "assemble" });
    return;
  }

  const ffmpeg = getSetting("FFMPEG_PATH").trim() || "ffmpeg";
  const tmpPath = finalPath.replace(/\.mp4$/i, "") + ".atmos.mp4";
  const hasSmoke = fs.existsSync(SMOKE_PATH);

  const args: string[] = ["-y", "-i", finalPath];
  if (hasSmoke) args.push("-stream_loop", "-1", "-i", SMOKE_PATH);

  const filterComplex = hasSmoke
    ? `[0:v]${BASE_CHAIN}[base];` +
      `[1:v]format=yuv420p,setsar=1[smk0];` +
      `[smk0][base]scale2ref[smk1][base2];` +
      `[base2][smk1]blend=all_mode=screen:all_opacity=0.22,format=yuv420p[v]`
    : `[0:v]${BASE_CHAIN}[v]`;

  args.push(
    "-filter_complex", filterComplex,
    "-map", "[v]", "-map", "0:a?",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
    "-c:a", "copy"
  );
  const threads = positiveInt(getSetting("FINAL_POSTPROCESS_THREADS"));
  if (threads) args.push("-threads", String(threads));
  if (hasSmoke) args.push("-shortest");
  args.push(tmpPath);

  try {
    await runFfmpeg(runId, ffmpeg, args, "final atmosphere pass");
    if (fs.existsSync(tmpPath) && fs.statSync(tmpPath).size > 1024) {
      fs.renameSync(tmpPath, finalPath);
      log(runId, "success", `Atmosphere baked in (${hasSmoke ? "grain + vignette + smoke" : "grain + vignette + grade"})`, {
        stage: "assemble",
      });
    }
  } catch (e) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {}
    const msg = e instanceof Error ? e.message : String(e);
    log(runId, "warn", `Atmosphere pass skipped — kept the original video: ${msg.slice(0, 200)}`, { stage: "assemble" });
  }
}

function atmosphereDecision(durationSec?: number | null): { apply: boolean; reason: string } {
  const mode = (getSetting("FINAL_ATMOSPHERE_MODE") || "short_only").trim().toLowerCase();
  if (mode === "off") return { apply: false, reason: "Atmosphere pass skipped (FINAL_ATMOSPHERE_MODE=off)." };
  if (mode === "always") return { apply: true, reason: "Atmosphere pass enabled for all videos." };
  if (typeof durationSec === "number" && Number.isFinite(durationSec) && durationSec >= SHORT_VIDEO_ATMOSPHERE_LIMIT_SEC) {
    return {
      apply: false,
      reason: `Atmosphere pass skipped for video >= 3 min (${(durationSec / 60).toFixed(1)} min).`,
    };
  }
  return { apply: true, reason: "Atmosphere pass enabled for short video." };
}

function positiveInt(value: string): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function runFfmpeg(runId: string, bin: string, args: string[], label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args);
    const unregister = registerLocalProcess(runId, label, proc);
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("error", (err) => {
      unregister();
      reject(err);
    });
    proc.on("close", (code) => {
      unregister();
      if (isCancelled(runId)) return reject(new Error("cancelled"));
      return code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-600)}`));
    });
  });
}
