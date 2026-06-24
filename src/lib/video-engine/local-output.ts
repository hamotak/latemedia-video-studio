import "server-only";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import db from "./db";
import { log } from "./logger";
import type { StockClip } from "./services/stock-library";

/**
 * Local output library. The standalone build saves finished videos to a plain
 * folder on the user's Desktop instead of Google Drive, so everything is
 * offline and easy to find. Override the root with the LOCAL_LIBRARY_DIR env var.
 *
 *   ~/Desktop/Late Media Videos/<Channel>/Final Videos/<title>.mp4
 */
export function localLibraryRoot(): string {
  const configured = process.env.LOCAL_LIBRARY_DIR?.trim();
  return configured && configured.length > 0
    ? configured
    : path.join(os.homedir(), "Desktop", "Late Media Videos");
}

function sanitize(name: string): string {
  return (name || "").replace(/[\\/:*?"<>|\n\r]+/g, " ").trim() || "Channel";
}

/** Folder for a channel's finished videos; created if missing. */
export function channelFinalVideosDir(channelName: string): string {
  const dir = path.join(localLibraryRoot(), sanitize(channelName), "Final Videos");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Folder for a channel's B-Rolls; created if missing. */
export function channelBRollsDir(channelName: string): string {
  const dir = path.join(localLibraryRoot(), sanitize(channelName), "B-Rolls");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const getRunRow = db.prepare(
  "SELECT preset_name, title, folder_name, output_path FROM runs WHERE id = ?"
);

/** Copy a finished run's final video (+ a poster, if any) to the Desktop library. Best-effort. */
export function copyRunToDesktop(runId: string, finalPath: string, runDir: string): void {
  try {
    const row = getRunRow.get(runId) as
      | {
          preset_name: string | null;
          title: string | null;
          folder_name: string | null;
          output_path: string | null;
        }
      | undefined;
    const src = finalPath && fs.existsSync(finalPath) ? finalPath : row?.output_path ?? null;
    if (!src || !fs.existsSync(src)) return;

    const destDir = channelFinalVideosDir(row?.preset_name || "General");
    const base = sanitize(row?.title || row?.folder_name || runId);
    const ext = path.extname(src) || ".mp4";
    const dest = path.join(destDir, `${base}${ext}`);
    fs.copyFileSync(src, dest);

    // Best-effort poster thumbnail (a top-level image in the run folder).
    try {
      const img = fs
        .readdirSync(runDir)
        .find((f) => /\.(jpe?g|png)$/i.test(f) && /poster|thumb|final/i.test(f));
      if (img) fs.copyFileSync(path.join(runDir, img), path.join(destDir, `${base}${path.extname(img)}`));
    } catch {
      /* poster is optional */
    }

    log(runId, "success", `Saved final video to ${dest}`, { stage: "pipeline" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(runId, "warn", `Could not save final video locally: ${msg}`, { stage: "pipeline" });
  }
}

/* ════════════════════════════════════════════════
   LOCAL B-ROLL LIBRARY  (replaces Google Drive)
   Clips live as plain .mp4 files under
   ~/Desktop/Late Media Videos/<Channel>/B-Rolls/.
   A clip id is `local:<base64url of absolute path>`, validated to be
   inside the library root so it can be served/deleted safely.
════════════════════════════════════════════════ */
const BROLL_ID_PREFIX = "local:";
const VIDEO_EXT = /\.(mp4|mov|webm|m4v)$/i;

export function bRollClipId(absPath: string): string {
  return BROLL_ID_PREFIX + Buffer.from(path.resolve(absPath), "utf-8").toString("base64url");
}

export function isBRollClipId(id: string): boolean {
  return typeof id === "string" && id.startsWith(BROLL_ID_PREFIX);
}

/** Decode a B-Roll clip id to an absolute path, or null if invalid / outside the library. */
export function resolveBRollClipPath(id: string): string | null {
  if (!isBRollClipId(id)) return null;
  let abs: string;
  try {
    abs = Buffer.from(id.slice(BROLL_ID_PREFIX.length), "base64url").toString("utf-8");
  } catch {
    return null;
  }
  const root = path.resolve(localLibraryRoot());
  const full = path.resolve(abs);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return fs.existsSync(full) ? full : null;
}

/** List a channel's B-Roll clips from disk as `StockClip`s (source "local"). */
export function listBRollClips(channelName: string): StockClip[] {
  const dir = channelBRollsDir(channelName);
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return files
    .filter((f) => VIDEO_EXT.test(f))
    .map((f) => {
      const full = path.join(dir, f);
      let mtime: string | null = null;
      try {
        mtime = fs.statSync(full).mtime.toISOString();
      } catch {
        /* ignore */
      }
      return {
        driveFileId: bRollClipId(full),
        name: f,
        displayName: f.replace(VIDEO_EXT, ""),
        source: "local" as const,
        createdTime: mtime,
        modifiedTime: mtime,
        driveFileLink: null,
      } satisfies StockClip;
    })
    .sort((a, b) => (b.modifiedTime ?? "").localeCompare(a.modifiedTime ?? ""));
}

/** Copy a clip into a channel's B-Roll folder; returns its clip id. */
export function saveBRollClip(channelName: string, srcPath: string, name?: string): string {
  const dir = channelBRollsDir(channelName);
  const base = sanitize(name || path.basename(srcPath) || "broll").replace(VIDEO_EXT, "");
  let dest = path.join(dir, `${base}.mp4`);
  let n = 2;
  while (fs.existsSync(dest)) dest = path.join(dir, `${base} (${n++}).mp4`);
  fs.copyFileSync(srcPath, dest);
  return bRollClipId(dest);
}

/** Delete a B-Roll clip by id. Returns true if a file was removed. */
export function deleteBRollClip(id: string): boolean {
  const full = resolveBRollClipPath(id);
  if (!full) return false;
  try {
    fs.rmSync(full, { force: true });
    return true;
  } catch {
    return false;
  }
}
