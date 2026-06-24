import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { getSetting, setSetting } from "../settings";
import { DRIVE_ROOT_FOLDER } from "../app-meta";
import { GDRIVE_CALLBACK_PATH, oauthRedirectUri } from "./gdrive-redirect";

const DRIVE_DISABLED_MESSAGE = "Google Drive is disabled in this local-only build.";

type DriveClient = {
  files: {
    list(args: Record<string, unknown>): Promise<{
      data: { files?: Array<Record<string, any>>; nextPageToken?: string | null };
    }>;
    create(args: Record<string, unknown>): Promise<{ data: Record<string, any> }>;
    get(args: Record<string, unknown>, options?: Record<string, unknown>): Promise<{ data: any }>;
    update(args: Record<string, unknown>): Promise<{ data: Record<string, any> }>;
  };
  permissions: {
    create(args: Record<string, unknown>): Promise<{ data: Record<string, any> }>;
  };
};

// Re-export so route handlers keep importing the redirect helper from here.
export { oauthRedirectUri, GDRIVE_CALLBACK_PATH };

/** Build a fresh OAuth2 client, optionally with refresh_token loaded. */
export function getOAuth2Client(redirectUri?: string): null {
  void redirectUri;
  return null;
}

/**
 * First leg of OAuth: URL the user gets redirected to. `redirectUri` MUST be the
 * same value passed to exchangeCodeForTokens — Google rejects a mismatch.
 */
export function buildAuthUrl(redirectUri: string, state?: string): string {
  void redirectUri;
  void state;
  throw new Error(DRIVE_DISABLED_MESSAGE);
}

/**
 * Second leg of OAuth: trade code for tokens, store refresh_token + email.
 * `redirectUri` must match the one used in buildAuthUrl for the same flow.
 */
export async function exchangeCodeForTokens(code: string, redirectUri: string): Promise<{ email: string }> {
  void code;
  void redirectUri;
  throw new Error(DRIVE_DISABLED_MESSAGE);
}

/** Authenticated Drive client; null if creds/token missing. */
export function getDriveClient(): DriveClient | null {
  return null;
}

/** Categorizes legacy Drive errors so compatibility responses stay typed. */
export type ConnectionErrorKind =
  | "api_not_enabled"   // Drive API not enabled in the user's Google Cloud project
  | "auth_invalid"       // refresh_token revoked, expired, or no longer valid
  | "network"            // transient network/timeout
  | "other";

export interface ConnectionStatus {
  connected: boolean;
  email?: string;
  /** Raw error message from the API call (kept verbatim for debugging). */
  error?: string;
  /** Categorized hint so UI can show the right action ("Enable API" vs "Reconnect"). */
  errorKind?: ConnectionErrorKind;
  /** When errorKind === "api_not_enabled", the direct Enable URL Google included in the response. */
  enableUrl?: string;
  /** Sync upload toggle. */
  syncEnabled: boolean;
  /** True when credentials are filled — i.e. OAuth flow can be started. */
  credentialsConfigured: boolean;
}

/** Live check: do we have a working connection right now? */
export async function getConnectionStatus(): Promise<ConnectionStatus> {
  return { connected: false, credentialsConfigured: false, syncEnabled: false };
}

/** Clears refresh_token + email (does NOT clear client_id/secret). */
export function clearConnection(): void {
  setSetting("GDRIVE_REFRESH_TOKEN", "");
  setSetting("GDRIVE_CONNECTED_EMAIL", "");
}

/**
 * Find a folder by name under a parent (or root). Returns the first match or
 * creates one if none exist. Folder name is exact-match.
 */
export async function findOrCreateFolder(name: string, parentId?: string): Promise<string> {
  const drive = getDriveClient();
  if (!drive) throw new Error("Drive not connected");

  // Escape single quotes in the name to keep the query valid.
  const escapedName = name.replace(/'/g, "\\'");
  const qParts = [
    `name='${escapedName}'`,
    "mimeType='application/vnd.google-apps.folder'",
    "trashed=false",
    parentId ? `'${parentId}' in parents` : "'root' in parents",
  ];

  const found = await drive.files.list({
    q: qParts.join(" and "),
    fields: "files(id, name)",
    pageSize: 1,
  });
  if (found.data.files && found.data.files.length > 0) {
    return found.data.files[0].id!;
  }

  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: parentId ? [parentId] : undefined,
    },
    fields: "id",
  });
  return created.data.id!;
}

/** Find a folder by exact name under a parent (or root) without creating it. */
export async function findFolder(name: string, parentId?: string): Promise<string | null> {
  const drive = getDriveClient();
  if (!drive) throw new Error("Drive not connected");

  const escapedName = name.replace(/'/g, "\\'");
  const qParts = [
    `name='${escapedName}'`,
    "mimeType='application/vnd.google-apps.folder'",
    "trashed=false",
    parentId ? `'${parentId}' in parents` : "'root' in parents",
  ];

  const found = await drive.files.list({
    q: qParts.join(" and "),
    fields: "files(id, name)",
    pageSize: 1,
  });
  return found.data.files?.[0]?.id ?? null;
}

/**
 * Resolve the two top-level folders we use. If folder IDs are already saved in
 * settings, they're returned as-is. Otherwise creates the app's Drive root
 * with `Final Videos` and `Clips Library` child folders, then persists the IDs.
 */
export async function ensureTopLevelFolders(): Promise<{
  finalVideosId: string;
  clipsLibraryId: string;
}> {
  let finalId = getSetting("GDRIVE_FINAL_VIDEOS_FOLDER_ID");
  let clipsId = getSetting("GDRIVE_CLIPS_LIBRARY_FOLDER_ID");

  if (!finalId || !clipsId) {
    let rootFolder = getSetting("GDRIVE_ROOT_FOLDER_ID");
    if (!rootFolder) {
      rootFolder = await findOrCreateFolder(DRIVE_ROOT_FOLDER);
      setSetting("GDRIVE_ROOT_FOLDER_ID", rootFolder);
    }
    if (!finalId) {
      finalId = await findOrCreateFolder("Final Videos", rootFolder);
      setSetting("GDRIVE_FINAL_VIDEOS_FOLDER_ID", finalId);
    }
    if (!clipsId) {
      clipsId = await findOrCreateFolder("Clips Library", rootFolder);
      setSetting("GDRIVE_CLIPS_LIBRARY_FOLDER_ID", clipsId);
    }
  }
  return { finalVideosId: finalId, clipsLibraryId: clipsId };
}

function guessMime(file: string): string {
  const ext = path.extname(file).toLowerCase();
  switch (ext) {
    case ".mp4": return "video/mp4";
    case ".mp3": return "audio/mpeg";
    case ".wav": return "audio/wav";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".json": return "application/json";
    case ".md": return "text/markdown";
    case ".txt": return "text/plain";
    default: return "application/octet-stream";
  }
}

/** Upload a local file to Drive. Returns the new file's ID. */
export async function uploadFile(
  localPath: string,
  parentId: string,
  options: { name?: string; mimeType?: string } = {}
): Promise<string> {
  const drive = getDriveClient();
  if (!drive) throw new Error("Drive not connected");

  const fileName = options.name ?? path.basename(localPath);
  const mimeType = options.mimeType ?? guessMime(localPath);

  const res = await drive.files.create({
    requestBody: { name: fileName, parents: [parentId] },
    media: { mimeType, body: fs.createReadStream(localPath) },
    fields: "id",
  });
  return res.data.id!;
}

/** Upload in-memory bytes to Drive. Returns the new file's ID. */
export async function uploadBuffer(
  bytes: Buffer,
  parentId: string,
  options: { name: string; mimeType?: string }
): Promise<string> {
  const drive = getDriveClient();
  if (!drive) throw new Error("Drive not connected");

  const res = await drive.files.create({
    requestBody: { name: options.name, parents: [parentId] },
    media: {
      mimeType: options.mimeType ?? "application/octet-stream",
      body: Readable.from(bytes),
    },
    fields: "id",
  });
  return res.data.id!;
}

/** Upload arbitrary in-memory content as a file (used for clips.json, description.md). */
export async function uploadString(
  content: string,
  parentId: string,
  name: string,
  mimeType: string
): Promise<string> {
  const drive = getDriveClient();
  if (!drive) throw new Error("Drive not connected");

  const res = await drive.files.create({
    requestBody: { name, parents: [parentId] },
    media: { mimeType, body: content },
    fields: "id",
  });
  return res.data.id!;
}

/**
 * Get the human-openable Drive web link for a file or folder ID.
 * Used by the UI to render "Open in Drive" buttons.
 */
export async function getFileWebLink(fileId: string): Promise<string | null> {
  const drive = getDriveClient();
  if (!drive) return null;
  try {
    const res = await drive.files.get({ fileId, fields: "webViewLink" });
    return res.data.webViewLink ?? null;
  } catch {
    return null;
  }
}

/** Make a Drive file readable by link. Best-effort for app-rendered thumbnails. */
export async function makeFileReadableByLink(fileId: string): Promise<boolean> {
  const drive = getDriveClient();
  if (!drive) throw new Error("Drive not connected");
  await drive.permissions.create({
    fileId,
    requestBody: { type: "anyone", role: "reader" },
    fields: "id",
  });
  return true;
}

/** Move a Drive file to trash (recoverable ~30 days). Returns true on success. */
export async function trashFile(fileId: string): Promise<boolean> {
  const drive = getDriveClient();
  if (!drive) throw new Error("Drive not connected");
  await drive.files.update({ fileId, requestBody: { trashed: true } });
  return true;
}

/** Rename a Drive file or folder in place. */
export async function renameFile(fileId: string, name: string): Promise<void> {
  const drive = getDriveClient();
  if (!drive) throw new Error("Drive not connected");
  await drive.files.update({ fileId, requestBody: { name }, fields: "id, name" });
}

export async function listFoldersByName(name: string, parentId: string): Promise<Array<{ id: string; name: string }>> {
  const drive = getDriveClient();
  if (!drive) throw new Error("Drive not connected");
  const escapedName = name.replace(/'/g, "\\'");
  const out: Array<{ id: string; name: string }> = [];
  let pageToken: string | undefined;
  do {
    const res = await drive.files.list({
      q: `'${parentId}' in parents and name='${escapedName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: "nextPageToken, files(id, name)",
      pageSize: 100,
      pageToken,
    });
    for (const f of res.data.files ?? []) {
      if (f.id && f.name) out.push({ id: f.id, name: f.name });
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

export async function listFolderChildren(folderId: string): Promise<Array<{ id: string; name: string; mimeType?: string | null }>> {
  const drive = getDriveClient();
  if (!drive) throw new Error("Drive not connected");
  const out: Array<{ id: string; name: string; mimeType?: string | null }> = [];
  let pageToken: string | undefined;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: "nextPageToken, files(id, name, mimeType)",
      pageSize: 1000,
      pageToken,
    });
    for (const f of res.data.files ?? []) {
      if (f.id && f.name) out.push({ id: f.id, name: f.name, mimeType: f.mimeType });
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

export async function moveFileBetweenFolders(fileId: string, fromFolderId: string, toFolderId: string): Promise<void> {
  const drive = getDriveClient();
  if (!drive) throw new Error("Drive not connected");
  await drive.files.update({
    fileId,
    addParents: toFolderId,
    removeParents: fromFolderId,
    fields: "id, parents",
  });
}

/** Stream a Drive file's bytes (for in-app previews). Caller pipes to a response. */
export async function getFileStream(fileId: string): Promise<NodeJS.ReadableStream> {
  const drive = getDriveClient();
  if (!drive) throw new Error("Drive not connected");
  const res = await drive.files.get({ fileId, alt: "media" }, { responseType: "stream" });
  return res.data as NodeJS.ReadableStream;
}

/** Download a file from Drive to a local path. */
export async function downloadFile(fileId: string, destPath: string): Promise<void> {
  const drive = getDriveClient();
  if (!drive) throw new Error("Drive not connected");

  const res = await drive.files.get({ fileId, alt: "media" }, { responseType: "stream" });
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(destPath);
    res.data.on("end", resolve).on("error", reject).pipe(out);
  });
}
