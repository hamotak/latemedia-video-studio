export interface MergeableStockClip {
  driveFileId: string;
  name: string;
  source?: "drive" | "local";
  /** Local cached copy to use for fast in-app preview/poster, while keeping driveFileId as source of truth. */
  previewFileId?: string;
}

export interface LocalStockRow {
  clip: MergeableStockClip;
  localPath: string;
}

function basename(p: string): string {
  const normalized = p.replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function cachedDriveId(fileName: string): string | null {
  const marker = fileName.indexOf("__");
  if (marker <= 0) return null;
  return fileName.slice(0, marker);
}

/**
 * Drive is the cloud source of truth, but local cache is still usable work.
 * Show Drive clips plus local-only cached clips without duplicating cache
 * copies that came from the same Drive file.
 */
export function mergeDriveAndLocalStockClips<T extends MergeableStockClip>(
  driveClips: T[],
  localRows: LocalStockRow[]
): MergeableStockClip[] {
  const seenDriveIds = new Set(driveClips.map((c) => c.driveFileId));
  const out: MergeableStockClip[] = driveClips.map((c) => ({ ...c, source: "drive" }));
  const outByDriveId = new Map(out.map((c) => [c.driveFileId, c]));
  const seenLocalPaths = new Set<string>();

  for (const row of localRows) {
    if (seenLocalPaths.has(row.localPath)) continue;
    seenLocalPaths.add(row.localPath);

    const driveId = cachedDriveId(basename(row.localPath));
    if (driveId && seenDriveIds.has(driveId)) {
      const driveClip = outByDriveId.get(driveId);
      if (driveClip) driveClip.previewFileId = row.clip.driveFileId;
      continue;
    }
    out.push(row.clip);
  }

  return out;
}
