import { DRIVE_ROOT_FOLDER } from "../app-meta";
import { getSetting, setSetting } from "../settings";
import { findFolder, findOrCreateFolder, listFolderChildren, renameFile } from "./gdrive";

export const DRIVE_CHANNELS_FOLDER = "Channels";
export const DRIVE_FINAL_VIDEOS_FOLDER = "01 Final Videos";
export const DRIVE_REUSABLE_CLIPS_FOLDER = "02 Reusable Scene Clips";
export const DRIVE_STOCK_BROLL_FOLDER = "03 Stock B-Roll";
export const DRIVE_LEGACY_STOCK_BROLL_FOLDER = DRIVE_STOCK_BROLL_FOLDER;
export const DRIVE_IMAGES_FOLDER = "04 Images & Thumbnails";
export const DRIVE_METADATA_FOLDER = "05 Metadata";

export interface ChannelDriveWorkspace {
  rootFolderId: string;
  channelsFolderId: string;
  channelFolderId: string;
  channelFolderName: string;
  finalVideosFolderId: string;
  reusableClipsFolderId: string;
  stockBrollFolderId: string;
  imagesFolderId: string;
  metadataFolderId: string;
}

export interface DriveWorkspaceStatus {
  rootFolderId: string | null;
  rootFolderLink: string | null;
  channelsFolderId: string | null;
  channelsFolderLink: string | null;
  channelFolderName: string | null;
  channelFolderId: string | null;
  channelFolderLink: string | null;
  folders: Array<{
    key: "finalVideos" | "reusableClips" | "stockBroll" | "images" | "metadata";
    name: string;
    id: string | null;
    link: string | null;
    exists: boolean;
  }>;
  missing: string[];
}

export interface DriveWorkspaceRepairResult {
  workspace: ChannelDriveWorkspace;
  workspaceLinks: {
    rootFolderLink: string | null;
    channelsFolderLink: string | null;
    channelFolderLink: string | null;
    finalVideosFolderLink: string | null;
    reusableClipsFolderLink: string | null;
    stockBrollFolderLink: string | null;
    imagesFolderLink: string | null;
    metadataFolderLink: string | null;
  };
  repairedFolders: Array<{
    id: string;
    from: string;
    to: string;
    link: string | null;
  }>;
  legacyFallbackFolders: Array<{
    id: string;
    name: string;
    link: string | null;
    childCount: number;
    videoCount: number;
  }>;
  skippedNonEmptyFolders: Array<{
    id: string;
    name: string;
    link: string | null;
    childCount: number;
    videoCount: number;
    reason: string;
  }>;
  skippedExistingTargets: Array<{
    id: string;
    name: string;
    link: string | null;
    reason: string;
  }>;
}

const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";

export function driveFolderLink(folderId: string | null | undefined): string | null {
  return folderId ? `https://drive.google.com/drive/folders/${folderId}` : null;
}

export function driveFileLink(fileId: string | null | undefined): string | null {
  return fileId ? `https://drive.google.com/file/d/${fileId}/view` : null;
}

export function safeDriveFolderName(name: string | null | undefined): string {
  const trimmed = (name ?? "").trim();
  const safe = trimmed
    .replace(/[\\/:\0]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 120)
    .trim();
  return safe || "_No Channel";
}

export function channelStockBrollFolderName(channelName: string | null | undefined): string {
  const channelFolderName = safeDriveFolderName(channelName);
  return channelFolderName === "_No Channel" ? "Channel B-rolls" : `${channelFolderName} B-rolls`;
}

async function ensureRootFolder(): Promise<string> {
  let rootId = getSetting("GDRIVE_ROOT_FOLDER_ID");
  if (!rootId) {
    rootId = await findOrCreateFolder(DRIVE_ROOT_FOLDER);
    setSetting("GDRIVE_ROOT_FOLDER_ID", rootId);
  }
  return rootId;
}

export async function ensureDriveWorkspace(): Promise<{
  rootFolderId: string;
  channelsFolderId: string;
}> {
  const rootFolderId = await ensureRootFolder();
  let channelsFolderId = getSetting("GDRIVE_CHANNELS_FOLDER_ID");
  if (!channelsFolderId) {
    channelsFolderId = await findOrCreateFolder(DRIVE_CHANNELS_FOLDER, rootFolderId);
    setSetting("GDRIVE_CHANNELS_FOLDER_ID", channelsFolderId);
  }
  return { rootFolderId, channelsFolderId };
}

export async function ensureChannelWorkspace(channelName: string | null | undefined): Promise<ChannelDriveWorkspace> {
  const { rootFolderId, channelsFolderId } = await ensureDriveWorkspace();
  const channelFolderName = safeDriveFolderName(channelName);
  const stockBrollFolderName = channelStockBrollFolderName(channelName);
  const channelFolderId = await findOrCreateFolder(channelFolderName, channelsFolderId);
  const finalVideosFolderId = await findOrCreateFolder(DRIVE_FINAL_VIDEOS_FOLDER, channelFolderId);
  const reusableClipsFolderId = await findOrCreateFolder(DRIVE_REUSABLE_CLIPS_FOLDER, channelFolderId);
  const stockBrollFolderId = await findOrCreateFolder(stockBrollFolderName, channelFolderId);
  const imagesFolderId = await findOrCreateFolder(DRIVE_IMAGES_FOLDER, channelFolderId);
  const metadataFolderId = await findOrCreateFolder(DRIVE_METADATA_FOLDER, channelFolderId);

  return {
    rootFolderId,
    channelsFolderId,
    channelFolderId,
    channelFolderName,
    finalVideosFolderId,
    reusableClipsFolderId,
    stockBrollFolderId,
    imagesFolderId,
    metadataFolderId,
  };
}

export async function ensureChannelStockBrollFolder(
  channelName: string | null | undefined
): Promise<{ id: string; link: string; name: string; workspace: ChannelDriveWorkspace }> {
  const workspace = await ensureChannelWorkspace(channelName);
  return {
    id: workspace.stockBrollFolderId,
    link: driveFolderLink(workspace.stockBrollFolderId)!,
    name: channelStockBrollFolderName(channelName),
    workspace,
  };
}

export async function ensureStockCollectionFolder(
  channelName: string | null | undefined,
  stockFolder: string | null | undefined
): Promise<{ id: string; link: string; collectionName: string; parentFolderId: string }> {
  const workspace = await ensureChannelWorkspace(channelName);
  const collectionName = safeDriveFolderName(stockFolder);
  const channelDefault = safeDriveFolderName(channelName);
  const shouldUseCollectionChild = collectionName !== "_No Channel" && collectionName !== channelDefault;
  const id = shouldUseCollectionChild
    ? await findOrCreateFolder(collectionName, workspace.stockBrollFolderId)
    : workspace.stockBrollFolderId;
  return {
    id,
    link: driveFolderLink(id)!,
    collectionName: shouldUseCollectionChild ? collectionName : channelStockBrollFolderName(channelName),
    parentFolderId: workspace.stockBrollFolderId,
  };
}

function workspaceLinks(workspace: ChannelDriveWorkspace): DriveWorkspaceRepairResult["workspaceLinks"] {
  return {
    rootFolderLink: driveFolderLink(workspace.rootFolderId),
    channelsFolderLink: driveFolderLink(workspace.channelsFolderId),
    channelFolderLink: driveFolderLink(workspace.channelFolderId),
    finalVideosFolderLink: driveFolderLink(workspace.finalVideosFolderId),
    reusableClipsFolderLink: driveFolderLink(workspace.reusableClipsFolderId),
    stockBrollFolderLink: driveFolderLink(workspace.stockBrollFolderId),
    imagesFolderLink: driveFolderLink(workspace.imagesFolderId),
    metadataFolderLink: driveFolderLink(workspace.metadataFolderId),
  };
}

function uniqueFolderNames(names: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    const safe = safeDriveFolderName(name);
    if (!name?.trim() || safe === "_No Channel" || seen.has(safe)) continue;
    seen.add(safe);
    out.push(safe);
  }
  return out;
}

async function describeFolderChildren(folderId: string): Promise<{ childCount: number; videoCount: number }> {
  const children = await listFolderChildren(folderId);
  return {
    childCount: children.length,
    videoCount: children.filter((child) => (child.mimeType ?? "").startsWith("video/")).length,
  };
}

export async function repairChannelDriveWorkspace(
  channelName: string | null | undefined,
  options: {
    renameEmptyFolders?: Array<string | null | undefined>;
    targetLegacyFolderName?: string | null;
  } = {}
): Promise<DriveWorkspaceRepairResult> {
  const workspace = await ensureChannelWorkspace(channelName);
  const targetLegacyFolderName = safeDriveFolderName(options.targetLegacyFolderName ?? channelName);
  const stockBrollFolderName = channelStockBrollFolderName(channelName);
  const renameCandidates = uniqueFolderNames(options.renameEmptyFolders ?? [])
    .filter(
      (name) =>
        name !== targetLegacyFolderName &&
        name !== DRIVE_STOCK_BROLL_FOLDER &&
        name !== stockBrollFolderName
    );
  const childFolders = (await listFolderChildren(workspace.stockBrollFolderId))
    .filter((child) => child.mimeType === DRIVE_FOLDER_MIME);

  const repairedFolders: DriveWorkspaceRepairResult["repairedFolders"] = [];
  const legacyFallbackFolders: DriveWorkspaceRepairResult["legacyFallbackFolders"] = [];
  const skippedNonEmptyFolders: DriveWorkspaceRepairResult["skippedNonEmptyFolders"] = [];
  const skippedExistingTargets: DriveWorkspaceRepairResult["skippedExistingTargets"] = [];

  for (const folder of childFolders) {
    const details = await describeFolderChildren(folder.id);
    const isRenameCandidate = renameCandidates.includes(folder.name);
    if (isRenameCandidate && details.childCount === 0) {
      const targetExists = childFolders.find((child) => child.name === targetLegacyFolderName);
      if (targetExists) {
        skippedExistingTargets.push({
          id: folder.id,
          name: folder.name,
          link: driveFolderLink(folder.id),
          reason: `Target folder "${targetLegacyFolderName}" already exists.`,
        });
      } else {
        await renameFile(folder.id, targetLegacyFolderName);
        repairedFolders.push({
          id: folder.id,
          from: folder.name,
          to: targetLegacyFolderName,
          link: driveFolderLink(folder.id),
        });
      }
      continue;
    }

    legacyFallbackFolders.push({
      id: folder.id,
      name: folder.name,
      link: driveFolderLink(folder.id),
      childCount: details.childCount,
      videoCount: details.videoCount,
    });
    if (isRenameCandidate) {
      skippedNonEmptyFolders.push({
        id: folder.id,
        name: folder.name,
        link: driveFolderLink(folder.id),
        childCount: details.childCount,
        videoCount: details.videoCount,
        reason: "Folder is not empty, so it was left in place as a legacy fallback.",
      });
    }
  }

  return {
    workspace,
    workspaceLinks: workspaceLinks(workspace),
    repairedFolders,
    legacyFallbackFolders,
    skippedNonEmptyFolders,
    skippedExistingTargets,
  };
}

export async function getDriveWorkspaceStatus(
  channelName?: string | null
): Promise<DriveWorkspaceStatus> {
  const savedRootId = getSetting("GDRIVE_ROOT_FOLDER_ID") || null;
  const rootFolderId = savedRootId ?? (await findFolder(DRIVE_ROOT_FOLDER));
  const channelsFolderId = rootFolderId
    ? getSetting("GDRIVE_CHANNELS_FOLDER_ID") || (await findFolder(DRIVE_CHANNELS_FOLDER, rootFolderId))
    : null;
  const channelFolderName = channelName ? safeDriveFolderName(channelName) : null;
  const channelFolderId =
    channelFolderName && channelsFolderId
      ? await findFolder(channelFolderName, channelsFolderId)
      : null;

  const childDefs = [
    ["finalVideos", DRIVE_FINAL_VIDEOS_FOLDER],
    ["reusableClips", DRIVE_REUSABLE_CLIPS_FOLDER],
    ["stockBroll", channelName ? channelStockBrollFolderName(channelName) : DRIVE_STOCK_BROLL_FOLDER],
    ["images", DRIVE_IMAGES_FOLDER],
    ["metadata", DRIVE_METADATA_FOLDER],
  ] as const;
  const folders = [];
  for (const [key, name] of childDefs) {
    const id = channelFolderId ? await findFolder(name, channelFolderId) : null;
    folders.push({
      key,
      name,
      id,
      link: driveFolderLink(id),
      exists: !!id,
    });
  }

  const missing: string[] = [];
  if (!rootFolderId) missing.push(DRIVE_ROOT_FOLDER);
  if (rootFolderId && !channelsFolderId) missing.push(`${DRIVE_ROOT_FOLDER}/${DRIVE_CHANNELS_FOLDER}`);
  if (channelFolderName && channelsFolderId && !channelFolderId) {
    missing.push(`${DRIVE_ROOT_FOLDER}/${DRIVE_CHANNELS_FOLDER}/${channelFolderName}`);
  }
  for (const folder of folders) {
    if (!folder.exists && channelFolderName) {
      missing.push(`${DRIVE_ROOT_FOLDER}/${DRIVE_CHANNELS_FOLDER}/${channelFolderName}/${folder.name}`);
    }
  }

  return {
    rootFolderId,
    rootFolderLink: driveFolderLink(rootFolderId),
    channelsFolderId,
    channelsFolderLink: driveFolderLink(channelsFolderId),
    channelFolderName,
    channelFolderId,
    channelFolderLink: driveFolderLink(channelFolderId),
    folders,
    missing,
  };
}
