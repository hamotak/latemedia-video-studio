import fs from "node:fs";
import path from "node:path";

function fileReady(filePath: string): boolean {
  try {
    return fs.statSync(filePath).size > 0;
  } catch {
    return false;
  }
}

function archiveGeneratedFile(filePath: string) {
  if (!fileReady(filePath)) return;
  const ext = path.extname(filePath);
  const base = filePath.slice(0, filePath.length - ext.length);
  const archived = `${base}.stale-${Date.now()}${ext}`;
  try {
    fs.renameSync(filePath, archived);
  } catch {
    /* best-effort; if rename fails, the next write should overwrite */
  }
}

function archiveMatchingFiles(dir: string, pattern: RegExp) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (!pattern.test(name)) continue;
    archiveGeneratedFile(path.join(dir, name));
  }
}

export function archiveMediaForScenePlanChange(runDir: string) {
  archiveMatchingFiles(path.join(runDir, "audio"), /^scene_\d{3}\.mp3$/i);
  archiveMatchingFiles(path.join(runDir, "audio"), /^tail_voiceover(?:_part\d+)?\.mp3$/i);
  archiveMatchingFiles(path.join(runDir, "images"), /^scene_\d{3}\.(png|jpe?g|webp)$/i);
  archiveMatchingFiles(path.join(runDir, "animations"), /^scene_\d{3}\.mp4$/i);
  archiveMatchingFiles(path.join(runDir, "clips"), /^clip_\d{3}\.mp4$/i);
  archiveMatchingFiles(path.join(runDir, "tail-clips"), /^t_\d+\.mp4$/i);
  archiveGeneratedFile(path.join(runDir, "tail.mp4"));
  archiveGeneratedFile(path.join(runDir, "final.mp4"));
  archiveGeneratedFile(path.join(runDir, "final-poster.jpg"));
  archiveGeneratedFile(path.join(runDir, "sync-report.json"));
  archiveGeneratedFile(path.join(runDir, "watermark-cleanup-report.json"));
}
