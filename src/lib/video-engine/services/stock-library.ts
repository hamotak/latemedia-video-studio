import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "../run-paths";
import db from "../db";
import { DRIVE_ROOT_FOLDER } from "../app-meta";
import {
  getDriveClient,
  findFolder,
  findOrCreateFolder,
  listFolderChildren,
  moveFileBetweenFolders,
  trashFile,
} from "./gdrive";
import {
  DRIVE_LEGACY_STOCK_BROLL_FOLDER,
  DRIVE_STOCK_BROLL_FOLDER,
  channelStockBrollFolderName,
  driveFolderLink,
  ensureChannelStockBrollFolder,
} from "./drive-workspace";
import { log } from "../logger";
import { mergeDriveAndLocalStockClips } from "../stock-merge";
import { channelBRollsDir, listBRollClipRows, resolveBRollClipPath } from "../local-output";

/**
 * Stock / B-roll library for the standalone app.
 *
 * The canonical clips live as plain local files under
 * ~/Desktop/Late Media Videos/<Channel>/B-Rolls. Legacy Drive helpers remain
 * below for old migration endpoints, but the active video pipeline reads the
 * local B-roll folder first and does not require Drive.
 */

export interface StockClip {
  driveFileId: string;
  name: string;
  source?: "drive" | "local";
  createdTime?: string | null;
  modifiedTime?: string | null;
  driveFolderName?: string;
  driveFolderId?: string;
  libraryScope?: "primary" | "fallback";
  previewFileId?: string;
  displayName?: string;
  jobId?: string;
  index?: number;
  prompt?: string;
  reviewStatus?: "unreviewed" | "good" | "weak" | "needs_review";
  driveFileLink?: string | null;
}

export interface LocalStockFolder {
  folder: string;
  count: number;
}

export interface ChannelStockClipsResult {
  primaryFolderId: string;
  primaryFolderLink: string;
  primaryFolderName: string;
  clips: StockClip[];
  legacyFoldersFound: Array<{
    kind: "channel_child" | "channel_sibling" | "legacy_clips_library";
    name: string;
    id: string;
    link: string | null;
    clipCount: number;
  }>;
}

export interface LegacyStockMigrationSource {
  kind: ChannelStockClipsResult["legacyFoldersFound"][number]["kind"];
  name: string;
  id: string;
  link: string | null;
  clipCount: number;
}

type LegacyDriveFileList = {
  data: {
    nextPageToken?: string | null;
    files?: Array<{
      id?: string | null;
      name?: string | null;
      mimeType?: string | null;
      createdTime?: string | null;
      modifiedTime?: string | null;
    }>;
  };
};

export interface LegacyStockMigrationResult {
  dryRun: boolean;
  targetFolderId: string;
  targetFolderName: string;
  targetFolderLink: string;
  sources: LegacyStockMigrationSource[];
  moved: number;
  skipped: number;
  trashedFolders: number;
  failed: number;
  errors: string[];
}

/** Local cache root: <DATA_DIR>/library-cache/<folder>/ */
function cacheDir(folder: string): string {
  return path.join(DATA_DIR, "library-cache", folder);
}

const cacheRoot = path.join(DATA_DIR, "library-cache");
const getRunChannelStmt = db.prepare("SELECT preset_name FROM runs WHERE id = ?");
const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";

function localClipId(localPath: string): string {
  const rel = path.relative(cacheRoot, localPath);
  return `local:${Buffer.from(rel, "utf-8").toString("base64url")}`;
}

export function isLocalStockClipId(id: string): boolean {
  return id.startsWith("local:");
}

export function resolveLocalStockClipPath(id: string): string {
  if (!isLocalStockClipId(id)) throw new Error("Not a local stock clip id");
  const brollPath = resolveBRollClipPath(id);
  if (brollPath) return brollPath;
  let rel: string;
  try {
    rel = Buffer.from(id.slice("local:".length), "base64url").toString("utf-8");
  } catch {
    throw new Error("Invalid local stock clip id");
  }
  const full = path.resolve(cacheRoot, rel);
  const root = path.resolve(cacheRoot);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error("Invalid local stock clip path");
  }
  if (!fs.existsSync(full)) throw new Error("Local stock clip not found");
  return full;
}

/** Resolve the legacy Drive folder id for Late Media Editing Tool / Clips Library / <folder>. */
async function resolveFolderId(folder: string): Promise<string> {
  const root = await findOrCreateFolder(DRIVE_ROOT_FOLDER);
  const lib = await findOrCreateFolder("Clips Library", root);
  return findOrCreateFolder(folder, lib);
}

async function resolveLegacyFolderIfPresent(folder: string): Promise<string | null> {
  const root = await findFolder(DRIVE_ROOT_FOLDER);
  if (!root) return null;
  const lib = await findFolder("Clips Library", root);
  if (!lib) return null;
  return findFolder(folder, lib);
}

async function listVideoFiles(
  folderId: string,
  meta: Pick<StockClip, "driveFolderName" | "driveFolderId" | "libraryScope"> = {}
): Promise<StockClip[]> {
  const drive = getDriveClient();
  if (!drive) throw new Error("Google Drive is not connected — connect it in Settings to use the stock library.");

  const clips: StockClip[] = [];
  let pageToken: string | undefined;
  do {
    const res: LegacyDriveFileList = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false and mimeType contains 'video/'`,
      fields: "nextPageToken, files(id, name, createdTime, modifiedTime)",
      pageSize: 1000,
      pageToken,
    });
    for (const f of res.data.files ?? []) {
      if (f.id && f.name) {
        clips.push({
          driveFileId: f.id,
          name: f.name,
          createdTime: f.createdTime ?? null,
          modifiedTime: f.modifiedTime ?? null,
          ...meta,
        });
      }
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return clips;
}

function uniqueNames(names: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    const clean = name?.trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

function dedupeClips(clips: StockClip[]): StockClip[] {
  const seen = new Set<string>();
  return clips.filter((clip) => {
    if (seen.has(clip.driveFileId)) return false;
    seen.add(clip.driveFileId);
    return true;
  });
}

function isVideoDriveChild(child: { name: string; mimeType?: string | null }): boolean {
  return (child.mimeType ?? "").startsWith("video/") || /\.(mp4|mov|m4v|webm)$/i.test(child.name);
}

export async function listChannelStockClips(
  channelName: string,
  options: { legacyFolders?: Array<string | null | undefined>; includeLegacy?: boolean } = {}
): Promise<ChannelStockClipsResult> {
  const drive = getDriveClient();
  if (!drive) throw new Error("Google Drive is not connected — connect it in Settings to use the stock library.");

  const primary = await ensureChannelStockBrollFolder(channelName);
  const legacyFoldersFound: ChannelStockClipsResult["legacyFoldersFound"] = [];
  const clips: StockClip[] = await listVideoFiles(primary.id, {
    driveFolderName: primary.name,
    driveFolderId: primary.id,
    libraryScope: "primary",
  });
  const legacyNames = uniqueNames([
    DRIVE_LEGACY_STOCK_BROLL_FOLDER,
    DRIVE_STOCK_BROLL_FOLDER,
    ...((options.legacyFolders ?? []) as Array<string | null | undefined>),
  ]).filter((name) => name !== primary.name);

  const channelSiblings = await listFolderChildren(primary.workspace.channelFolderId);
  for (const sibling of channelSiblings) {
    if (sibling.mimeType !== DRIVE_FOLDER_MIME || sibling.id === primary.id) continue;
    if (!legacyNames.includes(sibling.name)) continue;
    const siblingClips = await listVideoFiles(sibling.id, {
      driveFolderName: sibling.name,
      driveFolderId: sibling.id,
      libraryScope: "fallback",
    });
    legacyFoldersFound.push({
      kind: "channel_sibling",
      name: sibling.name,
      id: sibling.id,
      link: driveFolderLink(sibling.id),
      clipCount: siblingClips.length,
    });
    if (options.includeLegacy) clips.push(...siblingClips);
  }

  const channelChildren = await listFolderChildren(primary.id);
  for (const child of channelChildren) {
    if (child.mimeType !== DRIVE_FOLDER_MIME) continue;
    const childClips = await listVideoFiles(child.id, {
      driveFolderName: child.name,
      driveFolderId: child.id,
      libraryScope: "fallback",
    });
    legacyFoldersFound.push({
      kind: "channel_child",
      name: child.name,
      id: child.id,
      link: driveFolderLink(child.id),
      clipCount: childClips.length,
    });
    if (options.includeLegacy) clips.push(...childClips);
  }

  for (const name of uniqueNames(options.legacyFolders ?? [])) {
    const legacyFolderId = await resolveLegacyFolderIfPresent(name);
    if (!legacyFolderId) continue;
    const legacyClips = await listVideoFiles(legacyFolderId, {
      driveFolderName: name,
      driveFolderId: legacyFolderId,
      libraryScope: "fallback",
    });
    legacyFoldersFound.push({
      kind: "legacy_clips_library",
      name,
      id: legacyFolderId,
      link: driveFolderLink(legacyFolderId),
      clipCount: legacyClips.length,
    });
    if (options.includeLegacy) clips.push(...legacyClips);
  }

  return {
    primaryFolderId: primary.id,
    primaryFolderLink: primary.link,
    primaryFolderName: primary.name,
    clips: dedupeClips(clips),
    legacyFoldersFound,
  };
}

export async function migrateLegacyChannelStockClips(
  channelName: string,
  options: { legacyFolders?: Array<string | null | undefined>; dryRun?: boolean } = {}
): Promise<LegacyStockMigrationResult> {
  const dryRun = options.dryRun !== false;
  const stock = await listChannelStockClips(channelName, {
    legacyFolders: options.legacyFolders,
    includeLegacy: false,
  });
  const sourceById = new Map<string, LegacyStockMigrationSource>();
  for (const source of stock.legacyFoldersFound) {
    if (source.id === stock.primaryFolderId || sourceById.has(source.id)) continue;
    sourceById.set(source.id, source);
  }
  const sources = [...sourceById.values()];
  const targetChildren = await listFolderChildren(stock.primaryFolderId);
  const targetNames = new Set(targetChildren.map((child) => child.name.toLowerCase()));
  const errors: string[] = [];
  let moved = 0;
  let skipped = 0;
  let trashedFolders = 0;

  for (const source of sources) {
    const children = await listFolderChildren(source.id);
    for (const child of children) {
      if (child.mimeType === DRIVE_FOLDER_MIME || !isVideoDriveChild(child)) {
        skipped++;
        continue;
      }

      const nameKey = child.name.toLowerCase();
      if (targetNames.has(nameKey)) {
        skipped++;
        continue;
      }

      if (dryRun) {
        moved++;
        targetNames.add(nameKey);
        continue;
      }

      try {
        await moveFileBetweenFolders(child.id, source.id, stock.primaryFolderId);
        moved++;
        targetNames.add(nameKey);
      } catch (e) {
        errors.push(`${source.name}/${child.name}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 220));
      }
    }

    if (!dryRun) {
      try {
        const remaining = await listFolderChildren(source.id);
        if (remaining.length === 0) {
          await trashFile(source.id);
          trashedFolders++;
        }
      } catch (e) {
        errors.push(`${source.name}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 220));
      }
    }
  }

  return {
    dryRun,
    targetFolderId: stock.primaryFolderId,
    targetFolderName: stock.primaryFolderName,
    targetFolderLink: stock.primaryFolderLink,
    sources,
    moved,
    skipped,
    trashedFolders,
    failed: errors.length,
    errors,
  };
}

/** List all clips in the standalone stock library. */
export async function listStockClips(
  folder: string,
  options: { channelName?: string | null } = {}
): Promise<StockClip[]> {
  if (options.channelName) {
    return listBRollClipRows(options.channelName).map((row) => row.clip);
  }

  return listLocalCachedClips(folder).map((row) => row.clip);
}

/**
 * Ensure a stock clip is available locally, downloading from Drive only on the
 * first use. Returns the absolute local path. Reused on every later run.
 */
export async function ensureStockClipCached(folder: string, clip: StockClip): Promise<string> {
  const localPath = resolveBRollClipPath(clip.driveFileId);
  if (localPath) return localPath;
  if (isLocalStockClipId(clip.driveFileId)) return resolveLocalStockClipPath(clip.driveFileId);

  const drive = getDriveClient();
  if (!drive) throw new Error("Google Drive is not connected.");
  const dir = cacheDir(folder);
  fs.mkdirSync(dir, { recursive: true });
  const safeName = clip.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const dest = path.join(dir, `${clip.driveFileId}__${safeName}`);

  try {
    if (fs.statSync(dest).size > 0) return dest; // cache hit
  } catch {
    /* not cached yet */
  }

  const res = await drive.files.get(
    { fileId: clip.driveFileId, alt: "media" },
    { responseType: "stream" }
  );
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    (res.data as NodeJS.ReadableStream).on("error", reject).pipe(out).on("finish", resolve).on("error", reject);
  });
  return dest;
}

function scanLocalMp4s(dir: string): { clip: StockClip; localPath: string }[] {
  if (!fs.existsSync(dir)) return [];
  const out: { clip: StockClip; localPath: string }[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!/\.mp4$/i.test(f)) continue;
    const full = path.join(dir, f);
    try {
      if (fs.statSync(full).size <= 0) continue;
    } catch {
      continue;
    }
    out.push({ clip: { driveFileId: localClipId(full), name: f, source: "local" }, localPath: full });
  }
  return out;
}

/** List clips already on disk when Drive is unavailable (invalid_grant, offline, etc.). */
export function listLocalCachedClips(folder: string): { clip: StockClip; localPath: string }[] {
  const downloaded = scanLocalMp4s(cacheDir(folder));
  const generated = scanLocalMp4s(path.join(cacheRoot, "_gen", folder, "anim"));
  const seen = new Set<string>();
  return [...downloaded, ...generated].filter((row) => {
    if (seen.has(row.localPath)) return false;
    seen.add(row.localPath);
    return true;
  });
}

/** Remove cached Drive copies whose filenames start with `<driveFileId>__`. */
export function deleteCachedDriveCopies(driveFileIds: string[]): number {
  const ids = new Set(driveFileIds.filter((id) => id && !isLocalStockClipId(id)));
  if (ids.size === 0 || !fs.existsSync(cacheRoot)) return 0;

  let removed = 0;
  const scan = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(full);
        continue;
      }
      const marker = entry.name.indexOf("__");
      if (marker <= 0 || !ids.has(entry.name.slice(0, marker))) continue;
      try {
        const posterPath = path.join(DATA_DIR, "stock-posters", `${crypto.createHash("sha1").update(full).digest("hex")}.jpg`);
        fs.rmSync(full, { force: true });
        fs.rmSync(posterPath, { force: true });
        const sidecar = full.replace(/\.mp4$/i, ".manifest.json");
        if (sidecar !== full) fs.rmSync(sidecar, { force: true });
        removed++;
      } catch {
        /* best effort: Drive trash still succeeded, so keep deleting the rest */
      }
    }
  };
  scan(cacheRoot);
  return removed;
}

export { mergeDriveAndLocalStockClips };

export function listLocalStockFolders(): LocalStockFolder[] {
  if (!fs.existsSync(cacheRoot)) return [];
  const counts = new Map<string, number>();
  const add = (folder: string, count: number) => counts.set(folder, (counts.get(folder) ?? 0) + count);

  for (const entry of fs.readdirSync(cacheRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "_gen") continue;
    add(entry.name, scanLocalMp4s(path.join(cacheRoot, entry.name)).length);
  }

  const genRoot = path.join(cacheRoot, "_gen");
  if (fs.existsSync(genRoot)) {
    for (const entry of fs.readdirSync(genRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      add(entry.name, scanLocalMp4s(path.join(genRoot, entry.name, "anim")).length);
    }
  }

  return [...counts.entries()]
    .map(([folder, count]) => ({ folder, count }))
    .filter((f) => f.count > 0)
    .sort((a, b) => b.count - a.count || a.folder.localeCompare(b.folder));
}

export function isDriveAuthError(msg: string): boolean {
  return (
    msg.includes("invalid_grant") ||
    msg.includes("Token has been expired") ||
    msg.includes("invalid_client")
  );
}

/**
 * Resolve the local B-roll library for Hybrid tail assembly.
 */
export async function cacheStockLibrary(
  runId: string,
  folder: string,
  concurrency = 4
): Promise<{ clip: StockClip; localPath: string }[]> {
  void concurrency;
  const runChannel = (getRunChannelStmt.get(runId) as { preset_name: string | null } | undefined)?.preset_name ?? null;
  const out = runChannel ? listBRollClipRows(runChannel) : listLocalCachedClips(folder);
  if (out.length === 0) {
    const target = runChannel ? channelBRollsDir(runChannel) : path.join(DATA_DIR, "library-cache", folder);
    const label = runChannel ? `"${runChannel}"` : `"${folder}"`;
    throw new Error(
      `No local B-rolls found for ${label}. ` +
        `Open the B-Rolls page and generate a batch before starting a Hybrid run. ` +
        `Expected folder: ${target}`
    );
  }
  log(runId, "success", `Local B-roll library ready: ${out.length} clip${out.length === 1 ? "" : "s"} available`, {
    stage: "reuse",
    data: { channel: runChannel, folder },
  });
  return out;
}
