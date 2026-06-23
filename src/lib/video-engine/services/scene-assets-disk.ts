import fs from "node:fs";
import path from "node:path";
import type { Scene } from "./scene-split";
import type { TtsResult } from "./tts";

/**
 * Disk-only helpers for reconstructing a finished run's scene assets and for
 * deciding when it's safe to delete the local raw clips after a Drive sync.
 *
 * This module is intentionally dependency-free (only `fs`/`path` + type-only
 * imports) so it can be unit-tested without booting the SQLite DB or FFmpeg
 * that `run-upload.ts` pulls in at import time.
 */

/** Shape of a scene asset coming out of the pipeline. Mirrors AssembleInput. */
export interface SceneAsset {
  scene: Scene;
  imagePath: string;
  videoPath?: string | null;
  audio: TtsResult;
  sourceMode?: string | null;
  fallbackKind?: "still-motion" | "stock" | null;
}

/** Candidate filenames the pipeline may have used for a scene's raw video clip. */
function videoCandidates(animDir: string, padded: string): string[] {
  return [
    path.join(animDir, `scene_${padded}.mp4`),
    path.join(animDir, `scene-${padded}.mp4`),
    path.join(animDir, `${padded}.mp4`),
  ];
}

/** Candidate filenames for a per-scene narration mp3 (legacy / segmented runs). */
function perSceneAudioCandidates(audioDir: string, padded: string): string[] {
  return [
    path.join(audioDir, `scene_${padded}.mp3`),
    path.join(audioDir, `scene-${padded}.mp3`),
    path.join(audioDir, `${padded}.mp3`),
  ];
}

interface SceneVideoMetadata {
  sourceMode: string | null;
  fallbackKind: "still-motion" | "stock" | null;
  provider: string | null;
}

function videoManifestPath(videoPath: string): string {
  return videoPath.replace(/\.mp4$/i, ".manifest.json");
}

export function readSceneVideoMetadata(videoPath: string): SceneVideoMetadata {
  try {
    const parsed = JSON.parse(fs.readFileSync(videoManifestPath(videoPath), "utf-8")) as Record<string, unknown>;
    const sourceMode = typeof parsed.sourceMode === "string" ? parsed.sourceMode : null;
    const provider = typeof parsed.provider === "string" ? parsed.provider : null;
    return {
      sourceMode,
      provider,
      fallbackKind:
        sourceMode === "still-motion-fallback"
          ? "still-motion"
          : sourceMode === "stock-fallback"
            ? "stock"
            : null,
    };
  } catch {
    return { sourceMode: null, provider: null, fallbackKind: null };
  }
}

/**
 * Reconstruct SceneAsset[] from files left on disk. Used by manual re-sync to
 * upload a run that finished but never made it to Drive (or only partially).
 *
 * Reads scenes.json (always written by the pipeline) and pairs each scene with
 * its raw video clip. Audio is resolved in two ways:
 *
 *  - **Continuous voiceover runs** (the current pipeline) write ONE shared
 *    `voiceover_full.mp3` in the run folder — there are no per-scene mp3s. Every
 *    scene's asset points its audio at that shared track.
 *  - **Legacy / segmented runs** that wrote `audio/scene_NNN.mp3` still work —
 *    the per-scene file wins when present.
 *
 * A scene is only skipped when it has no raw video clip on disk (there's nothing
 * to upload as a library clip). A missing audio file never drops a clip: the
 * Drive upload reads `videoPath` for the file and `audio.durationSec` for
 * metadata only, so audio degrades gracefully to metadata.
 */
export function rebuildSceneAssetsFromDisk(runDir: string): SceneAsset[] {
  const scenesPath = path.join(runDir, "scenes.json");
  if (!fs.existsSync(scenesPath)) return [];
  let scenes: Scene[];
  try {
    scenes = JSON.parse(fs.readFileSync(scenesPath, "utf-8")) as Scene[];
  } catch {
    return [];
  }
  if (!Array.isArray(scenes)) return [];

  const animDir = path.join(runDir, "animations");
  const audioDir = path.join(runDir, "audio");

  // Continuous voiceover runs share ONE track in the run folder.
  const continuousAudio = path.join(runDir, "voiceover_full.mp3");
  const haveContinuousAudio = fs.existsSync(continuousAudio);

  const result: SceneAsset[] = [];
  for (const scene of scenes) {
    // Real pipeline output is always contiguous 0-based integers, but guard
    // against a hand-edited / corrupt scenes.json so we never build a bogus
    // path like "scene_null.mp4".
    if (!Number.isInteger(scene?.index) || scene.index < 0) continue;
    const padded = String(scene.index).padStart(3, "0");

    const videoPath = videoCandidates(animDir, padded).find((p) => fs.existsSync(p)) ?? null;
    // No raw video → no clip to upload. (We never skip merely for missing audio.)
    if (!videoPath) continue;

    const perSceneAudio = perSceneAudioCandidates(audioDir, padded).find((p) => fs.existsSync(p));
    // Per-scene mp3 (segmented runs) wins; otherwise the shared continuous track.
    const audioPath = perSceneAudio ?? (haveContinuousAudio ? continuousAudio : "");

    // Exact per-scene audio length isn't recoverable from disk without
    // re-probing the whole track, so estimate from the scene's duration hint.
    // This only feeds manifest metadata (audio_duration_sec), never the clip.
    const durationSec = Number.isFinite(scene.duration_hint_sec) ? scene.duration_hint_sec : 0;
    const metadata = readSceneVideoMetadata(videoPath);

    result.push({
      scene,
      imagePath: videoPath,
      videoPath,
      audio: { filePath: audioPath, durationSec },
      sourceMode: metadata.sourceMode,
      fallbackKind: metadata.fallbackKind,
    });
  }
  return result;
}

/**
 * Count raw scene clips (scene_NNN.mp4 / NNN.mp4) still on disk in a run's
 * animations folder. Excludes synthetic buffer clips (e.g. buffer_kenburns.mp4)
 * so the count reflects real, reusable scene clips only.
 */
export function countRawClipsOnDisk(runDir: string): number {
  const animDir = path.join(runDir, "animations");
  if (!fs.existsSync(animDir)) return 0;
  try {
    return fs
      .readdirSync(animDir)
      .filter((f) => /^scene[_-]?\d+\.mp4$/i.test(f) || /^\d+\.mp4$/.test(f)).length;
  } catch {
    return 0;
  }
}

/**
 * Whether it's safe to delete the local raw clips after a Drive sync.
 *
 * Only true when every asset we set out to upload actually reached Drive
 * (`uploadedCount === assetCount`) and at least one clip uploaded. A partial or
 * empty upload keeps its raw clips locally so a re-sync can retry without
 * regenerating — this is what stops the empty-manifest bug from nuking clips.
 */
export function shouldCleanupRawClips(uploadedCount: number, assetCount: number): boolean {
  return uploadedCount > 0 && uploadedCount === assetCount;
}
