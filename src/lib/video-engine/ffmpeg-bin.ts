import "server-only";
import fs from "node:fs";
import { createRequire } from "node:module";

/**
 * Resolves the ffmpeg / ffprobe executables that ship with the app via the
 * `ffmpeg-static` and `ffprobe-static` packages. This lets a non-technical
 * user run video rendering on Windows/macOS without installing FFmpeg by hand.
 *
 * An explicit `FFMPEG_PATH` set in Settings always takes precedence (resolved
 * by the callers); these helpers are the zero-config fallback.
 */
const requireCjs = createRequire(import.meta.url);

function existing(value: unknown): string | null {
  const resolved =
    typeof value === "string" ? value : (value as { path?: string } | null)?.path;
  return typeof resolved === "string" && resolved.length > 0 && fs.existsSync(resolved)
    ? resolved
    : null;
}

/** Absolute path to the bundled ffmpeg binary, or null if unavailable. */
export function bundledFfmpeg(): string | null {
  try {
    return existing(requireCjs("ffmpeg-static"));
  } catch {
    return null;
  }
}

/** Absolute path to the bundled ffprobe binary, or null if unavailable. */
export function bundledFfprobe(): string | null {
  try {
    return existing(requireCjs("ffprobe-static"));
  } catch {
    return null;
  }
}
