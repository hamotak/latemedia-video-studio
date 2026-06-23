import fs from "node:fs";
import path from "node:path";
import db from "../db";
import { log } from "../logger";
import { getSetting } from "../settings";
import {
  findOrCreateFolder,
  getDriveClient,
  uploadFile,
  uploadString,
} from "./gdrive";
import { ensureChannelWorkspace } from "./drive-workspace";
import { mirrorVideoRun } from "../supabase-video-mirror";
import {
  countRawClipsOnDisk,
  readSceneVideoMetadata,
  shouldCleanupRawClips,
} from "./scene-assets-disk";
import type { SceneAsset } from "./scene-assets-disk";

// Re-export so existing importers (the drive route) keep their import path.
export { rebuildSceneAssetsFromDisk } from "./scene-assets-disk";
export type { SceneAsset };

interface ClipsManifestEntry {
  index: number;
  file: string;
  drive_file_id: string;
  scene_text: string;
  visual_prompt: string;
  duration_hint_sec: number;
  audio_duration_sec: number | null;
  video_duration_sec: number | null;
  source_mode?: string | null;
  fallback_kind?: "still-motion" | "stock" | null;
}

interface ClipsManifest {
  schema_version: 1;
  run_id: string;
  run_title: string | null;
  folder_name: string;
  /** Channel profile name this run used, or "_No Channel". Drives per-channel library filtering. */
  channel: string;
  created_at: string;
  scene_count: number;
  settings_snapshot: {
    animation_provider: string;
    animation_model: string;
    image_resolution: string;
    video_resolution: string;
    video_fps: string;
  };
  clips: ClipsManifestEntry[];
}

interface DriveSyncReport {
  schema_version: 1;
  run_id: string;
  synced_at: string;
  requested_asset_count: number;
  uploaded_clip_count: number;
  raw_clip_count_before: number;
  fallback_count: number;
  still_motion_fallback_count: number;
  stock_fallback_count: number;
  cleanup: {
    cleaned: boolean;
    deleted_clip_count: number;
    reason: string;
  };
  clips_folder_id: string | null;
  final_video_id: string;
}

const getRunRow = db.prepare(
  "SELECT title, folder_name, preset_name FROM runs WHERE id = ?"
);

/** Channel folder name for a run — the channel profile name, or a shared bucket. */
export function channelFolderName(presetName: string | null | undefined): string {
  const n = (presetName ?? "").trim();
  return n.length > 0 ? n : "_No Channel";
}

const updateDriveRefs = db.prepare(
  "UPDATE runs SET drive_clips_folder_id = ?, drive_final_video_id = ?, drive_synced_at = datetime('now') WHERE id = ?"
);
const getDriveRefs = db.prepare(
  "SELECT drive_clips_folder_id, drive_final_video_id FROM runs WHERE id = ?"
);

/**
 * Upload a finished run to Google Drive, then delete local raw clip files.
 *
 * Layout in Drive:
 *   {clipsLibraryFolderId}/{runFolderName}/
 *     scene_001.mp4              ← raw Veo clip, no voiceover
 *     scene_002.mp4
 *     ...
 *     clips.json                 ← machine-readable manifest (AI search reads this)
 *     description.md             ← human-readable summary
 *   {finalVideosFolderId}/{runFolderName}.mp4
 *
 * After upload, local raw clips in {runDir}/animations/ are deleted. The final
 * video at {runDir}/final.mp4 is kept locally (single playable backup).
 *
 * Returns true when an upload actually happened; false when sync is disabled or
 * Drive isn't connected (in which case we leave everything locally untouched).
 *
 * Best-effort: if any individual upload fails, we abort the cleanup so the user
 * still has the raw clips on disk and can retry. Throws on critical errors so
 * the caller can log them.
 */
export async function syncRunToDrive(
  runId: string,
  sceneAssets: SceneAsset[],
  runDir: string,
  finalPath: string,
  options: { force?: boolean } = {}
): Promise<boolean> {
  // `force` lets the /api/runs/[id]/drive POST trigger a manual re-sync even
  // when the auto-sync toggle is off — manual action is always honored.
  const syncEnabled = options.force || getSetting("GDRIVE_SYNC_ENABLED") === "1";
  if (!syncEnabled) return false;

  const drive = getDriveClient();
  if (!drive) {
    log(
      runId,
      "warn",
      "Drive sync enabled but not connected — skipping upload. Reconnect in /settings.",
      { stage: "gdrive" }
    );
    return false;
  }

  const runRow = getRunRow.get(runId) as
    | { title: string | null; folder_name: string | null; preset_name: string | null }
    | undefined;
  const folderName = runRow?.folder_name ?? path.basename(runDir);
  const title = runRow?.title ?? null;
  const channel = channelFolderName(runRow?.preset_name);

  log(runId, "info", `Drive sync starting · channel: ${channel} · folder: ${folderName}`, {
    stage: "gdrive",
  });

  const rawClipCountBefore = countRawClipsOnDisk(runDir);
  const hasScenePlan = fs.existsSync(path.join(runDir, "scenes.json"));
  const finalOnlySync = sceneAssets.length === 0 && rawClipCountBefore === 0;
  const workspace = await ensureChannelWorkspace(channel);

  // Per-channel reusable clips are created only when there are raw scene clips
  // to preserve. Stock/tail-only runs sync the final deliverable without a
  // misleading empty reusable-clips folder.
  const runFolderId = finalOnlySync
    ? null
    : await findOrCreateFolder(folderName, workspace.reusableClipsFolderId);

  // 1. Upload raw clips (animations/scene_*.mp4 — Veo output before voiceover)
  const uploadedClips: ClipsManifestEntry[] = [];
  const uploadedLocalPaths: string[] = [];
  for (const asset of sceneAssets) {
    if (!asset.videoPath || !fs.existsSync(asset.videoPath)) {
      log(
        runId,
        "warn",
        `Scene #${asset.scene.index}: no raw video to upload, skipped`,
        { stage: "gdrive" }
      );
      continue;
    }
    const fileName = `scene_${String(asset.scene.index).padStart(3, "0")}.mp4`;
    const fileMetadata = readSceneVideoMetadata(asset.videoPath);
    const sourceMode = asset.sourceMode ?? fileMetadata.sourceMode;
    const fallbackKind = asset.fallbackKind ?? fileMetadata.fallbackKind;
    try {
      if (!runFolderId) throw new Error("Cannot upload reusable scene clips without a Drive run folder.");
      const fileId = await uploadFile(asset.videoPath, runFolderId, { name: fileName });
      uploadedClips.push({
        index: asset.scene.index,
        file: fileName,
        drive_file_id: fileId,
        scene_text: asset.scene.text,
        visual_prompt: asset.scene.visual_prompt,
        duration_hint_sec: asset.scene.duration_hint_sec,
        audio_duration_sec: asset.audio?.durationSec ?? null,
        video_duration_sec: null, // Veo clips are ~6s, exact value not measured here
        source_mode: sourceMode,
        fallback_kind: fallbackKind,
      });
      uploadedLocalPaths.push(asset.videoPath);
      log(runId, "info", `Uploaded ${fileName} → Drive`, { stage: "gdrive" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(runId, "error", `Failed to upload ${fileName}: ${msg}`, { stage: "gdrive" });
      throw e; // abort — don't delete locals if upload is broken
    }
  }

  // Guard: a run with a saved scene plan should always produce clips. If we'd
  // upload an EMPTY clips.json for such a run, refuse — overwriting Drive's
  // manifest with zero clips wipes the run from the Clip Library. Two ways this
  // happens, both handled here:
  //   • raw clips are still on disk but none reconstructed  → reconstruction bug
  //     (the original continuous-voiceover bug: per-scene audio was required).
  //   • no raw clips remain                                 → they were already
  //     uploaded + cleaned by an earlier sync; the Drive clips.json is good and
  //     a re-sync must not clobber it.
  // Either way we abort before touching Drive, leaving local files intact.
  if (uploadedClips.length === 0 && hasScenePlan && !finalOnlySync) {
    const rawClipCount = countRawClipsOnDisk(runDir);
    const detail =
      rawClipCount > 0
        ? `${rawClipCount} raw clip(s) are on disk but none were reconstructed into uploadable assets — asset reconstruction failed.`
        : `no raw clips remain on disk — they were likely already uploaded and cleaned up by an earlier sync, so the existing Drive clips.json is left intact.`;
    throw new Error(
      `Refusing to sync an empty clips.json for a run with a saved scene plan. ${detail} Local files were left untouched.`
    );
  }

  // 2. Build + upload manifest files. These are what the future AI search reads.
  // Stock/tail-only runs deliberately have no reusable raw scene clips, so they
  // sync the final deliverable without writing a misleading empty clips.json.
  if (finalOnlySync) {
    log(runId, "info", "No reusable raw scene clips for this run — syncing final video only", {
      stage: "gdrive",
    });
  } else {
    const manifest: ClipsManifest = {
      schema_version: 1,
      run_id: runId,
      run_title: title,
      folder_name: folderName,
      channel,
      created_at: new Date().toISOString(),
      scene_count: sceneAssets.length,
      settings_snapshot: {
        animation_provider: getSetting("ANIMATION_PROVIDER"),
        animation_model: getSetting("ANIMATION_MODEL"),
        image_resolution: getSetting("IMAGE_RESOLUTION"),
        video_resolution: getSetting("VIDEO_RESOLUTION"),
        video_fps: getSetting("VIDEO_FPS"),
      },
      clips: uploadedClips,
    };

    await uploadString(
      JSON.stringify(manifest, null, 2),
      runFolderId!,
      "clips.json",
      "application/json"
    );
    await uploadString(buildDescriptionMarkdown(manifest), runFolderId!, "description.md", "text/markdown");
    log(runId, "info", `Uploaded clips.json + description.md`, { stage: "gdrive" });
  }

  // 3. Upload final video to the per-channel Final Videos folder
  const finalDriveName = `${folderName}.mp4`;
  const finalVideoId = await uploadFile(finalPath, workspace.finalVideosFolderId, { name: finalDriveName });
  if (!finalVideoId?.trim()) {
    throw new Error("Drive upload finished but did not return a final video file ID.");
  }
  log(runId, "info", `Uploaded final video → Drive/${channel}/01 Final Videos/${finalDriveName}`, {
    stage: "gdrive",
  });

  // Persist the Drive references so the run page can show status + open-links
  // without making another Drive API call.
  updateDriveRefs.run(runFolderId, finalVideoId, runId);
  const savedDriveRefs = getDriveRefs.get(runId) as {
    drive_clips_folder_id: string | null;
    drive_final_video_id: string | null;
  } | undefined;
  if (savedDriveRefs?.drive_final_video_id !== finalVideoId) {
    throw new Error("Drive final video ID was not saved locally after upload.");
  }
  await mirrorVideoRun(runId);

  // 4. Clean up local raw clips — they live in Drive now. Final video and
  //    audio files stay locally. Only delete when EVERY asset we set out to
  //    upload actually reached Drive; a partial/empty upload keeps its raw clips
  //    locally so a re-sync can retry without regenerating.
  const cleanupAllowed =
    shouldCleanupRawClips(uploadedClips.length, sceneAssets.length) &&
    rawClipCountBefore > 0 &&
    uploadedClips.length >= rawClipCountBefore;
  let cleanupDeletedClipCount = 0;
  let cleanupReason = "partial upload";
  if (cleanupAllowed) {
    cleanupDeletedClipCount = cleanupLocalRawClips(runId, runDir, uploadedLocalPaths);
    cleanupReason = "all raw scene clips uploaded";
  } else if (finalOnlySync) {
    cleanupReason = "final-only render; no reusable raw scene clips";
  } else {
    cleanupReason =
      rawClipCountBefore === 0
        ? "no raw scene clips on disk"
        : uploadedClips.length < rawClipCountBefore
          ? `uploaded ${uploadedClips.length}/${rawClipCountBefore} raw scene clips`
          : `uploaded ${uploadedClips.length}/${sceneAssets.length} requested assets`;
    log(
      runId,
      "warn",
      `Kept local raw clips — ${cleanupReason}. Re-sync to retry.`,
      { stage: "gdrive" }
    );
  }

  writeDriveSyncReport(runDir, {
    schema_version: 1,
    run_id: runId,
    synced_at: new Date().toISOString(),
    requested_asset_count: sceneAssets.length,
    uploaded_clip_count: uploadedClips.length,
    raw_clip_count_before: rawClipCountBefore,
    fallback_count: uploadedClips.filter((clip) => clip.fallback_kind != null).length,
    still_motion_fallback_count: uploadedClips.filter((clip) => clip.fallback_kind === "still-motion").length,
    stock_fallback_count: uploadedClips.filter((clip) => clip.fallback_kind === "stock").length,
    cleanup: {
      cleaned: cleanupAllowed,
      deleted_clip_count: cleanupDeletedClipCount,
      reason: cleanupReason,
    },
    clips_folder_id: runFolderId,
    final_video_id: finalVideoId,
  });

  log(runId, "success", `Drive sync complete · ${uploadedClips.length} clips + final video`, {
    stage: "gdrive",
  });
  return true;
}

/**
 * Removes the raw Veo clips folder ({runDir}/animations) plus intermediate
 * voiced clips ({runDir}/clips) after a successful upload. Keeps final.mp4
 * and audio/ locally.
 */
function cleanupLocalRawClips(runId: string, runDir: string, uploadedLocalPaths: string[]): number {
  let deleted = 0;
  const animDir = path.join(runDir, "animations");
  for (const filePath of [...new Set(uploadedLocalPaths)]) {
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(animDir) + path.sep)) continue;
    try {
      if (fs.existsSync(resolved)) {
        fs.rmSync(resolved, { force: true });
        deleted++;
      }
      const manifest = resolved.replace(/\.mp4$/i, ".manifest.json");
      if (fs.existsSync(manifest)) fs.rmSync(manifest, { force: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(runId, "warn", `Could not delete ${resolved}: ${msg}`, { stage: "gdrive" });
    }
  }

  try {
    if (fs.existsSync(animDir) && fs.readdirSync(animDir).length === 0) fs.rmSync(animDir, { recursive: true, force: true });
  } catch {
    /* leave non-empty or locked folder alone */
  }

  const clipsDir = path.join(runDir, "clips");
  if (fs.existsSync(clipsDir)) {
    try {
      fs.rmSync(clipsDir, { recursive: true, force: true });
      log(runId, "info", "Cleaned local: clips/", { stage: "gdrive" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(runId, "warn", `Could not delete ${clipsDir}: ${msg}`, { stage: "gdrive" });
    }
  }

  log(runId, "info", `Cleaned local raw clips: ${deleted}`, { stage: "gdrive" });
  return deleted;
}

function writeDriveSyncReport(runDir: string, report: DriveSyncReport): void {
  try {
    fs.writeFileSync(path.join(runDir, "drive-sync-report.json"), JSON.stringify(report, null, 2), "utf-8");
  } catch {
    /* report is best-effort */
  }
}

/** Builds the human-readable description.md companion to clips.json. */
function buildDescriptionMarkdown(m: ClipsManifest): string {
  const lines: string[] = [];
  lines.push(`# Run: ${m.run_title ?? m.folder_name}`);
  lines.push("");
  lines.push(`- **Run ID:** \`${m.run_id}\``);
  lines.push(`- **Folder:** \`${m.folder_name}\``);
  lines.push(`- **Created:** ${m.created_at}`);
  lines.push(`- **Scenes:** ${m.scene_count} (uploaded: ${m.clips.length})`);
  lines.push(
    `- **Model:** ${m.settings_snapshot.animation_provider}/${m.settings_snapshot.animation_model} · ${m.settings_snapshot.video_resolution} @ ${m.settings_snapshot.video_fps}fps`
  );
  lines.push("");
  lines.push(
    "Raw scene clips below are **without voiceover** — suitable for reuse in future runs."
  );
  lines.push(
    "Field `visual_prompt` is what was fed into the video model. Field `scene_text` is the narration line that played over this clip in the original run."
  );
  lines.push("");
  lines.push("---");
  lines.push("");

  for (const c of m.clips) {
    lines.push(`## Scene ${c.index}`);
    lines.push("");
    lines.push(`- **File:** \`${c.file}\``);
    lines.push(`- **Drive file ID:** \`${c.drive_file_id}\``);
    if (c.audio_duration_sec != null) {
      lines.push(`- **Original audio length:** ${c.audio_duration_sec.toFixed(2)}s`);
    }
    if (c.source_mode) lines.push(`- **Source mode:** \`${c.source_mode}\``);
    if (c.fallback_kind) lines.push(`- **Fallback:** \`${c.fallback_kind}\``);
    lines.push("");
    lines.push(`**Visual prompt:**`);
    lines.push("");
    lines.push("```");
    lines.push(c.visual_prompt);
    lines.push("```");
    lines.push("");
    lines.push(`**Scene narration text:**`);
    lines.push("");
    lines.push(c.scene_text);
    lines.push("");
  }

  return lines.join("\n");
}
