import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { getSetting } from "../settings";
import { bundledFfprobe } from "../ffmpeg-bin";

function ffmpegPaths(): { ffmpeg: string; ffprobe: string } {
  const fallbackProbe = bundledFfprobe() ?? "ffprobe";
  const ffmpegPath = getSetting("FFMPEG_PATH");
  if (!ffmpegPath) return { ffmpeg: "ffmpeg", ffprobe: fallbackProbe };
  const ffprobePath = ffmpegPath.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
  return {
    ffmpeg: ffmpegPath,
    ffprobe: fs.existsSync(ffprobePath) ? ffprobePath : fallbackProbe,
  };
}

function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr.trim() || err.message));
      resolve(stdout);
    });
  });
}

async function probeDuration(filePath: string): Promise<number> {
  try {
    const { ffprobe } = ffmpegPaths();
    const out = await run(ffprobe, [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      filePath,
    ]);
    const duration = Number(out.trim());
    return Number.isFinite(duration) && duration > 0 ? duration : 1;
  } catch {
    return 1;
  }
}

/** Create a lightweight JPG preview for the run page's HTML5 video player. */
export async function ensureVideoPoster(videoPath: string, posterPath: string): Promise<string> {
  try {
    if (fs.statSync(posterPath).size > 0) return posterPath;
  } catch {}

  fs.mkdirSync(path.dirname(posterPath), { recursive: true });
  const duration = await probeDuration(videoPath);
  const seek = Math.max(0, Math.min(1, duration / 2));
  const { ffmpeg } = ffmpegPaths();

  await run(ffmpeg, [
    "-y",
    "-ss", seek.toFixed(3),
    "-i", videoPath,
    "-frames:v", "1",
    "-q:v", "3",
    posterPath,
  ]);
  return posterPath;
}
