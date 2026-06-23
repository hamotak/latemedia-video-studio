import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { getSetting } from "../settings";

/**
 * Extract the last frame of a video to a JPG file.
 *
 * Uses `-sseof -1.0 -i ... -update 1 -q:v 2` — ffmpeg seeks to roughly 1 second
 * before the end and writes the final decoded frame as a single JPG. This is
 * the standard last-frame trick; it avoids decoding the whole file.
 *
 * Local-only: the output stays on disk for keyframe-mode continuity (TODO) and
 * is useful as a per-scene preview. Best-effort — failures must not break the
 * pipeline (the caller logs and moves on).
 */
export async function extractLastFrame(videoPath: string, outPath: string): Promise<void> {
  if (!fs.existsSync(videoPath)) {
    throw new Error(`extractLastFrame: input not found: ${videoPath}`);
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const cmd = getSetting("FFMPEG_PATH").trim() || "ffmpeg";
  // -y overwrites the JPG if a prior attempt left a stale one.
  const args = [
    "-y",
    "-sseof", "-1.0",
    "-i", videoPath,
    "-update", "1",
    "-frames:v", "1",
    "-q:v", "2",
    outPath,
  ];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0 && fs.existsSync(outPath)) resolve();
      else reject(new Error(`ffmpeg last-frame failed (exit ${code}): ${stderr.slice(-400)}`));
    });
  });
}
