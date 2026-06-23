import { google, drive_v3 } from "googleapis";
// Derive the client type from googleapis itself so it matches the instance
// returned by `new google.auth.OAuth2(...)` and avoids a duplicate
// google-auth-library version clash.
type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { getSetting, setSetting } from "../settings";
import { DRIVE_ROOT_FOLDER } from "../app-meta";
import { GDRIVE_CALLBACK_PATH, oauthRedirectUri } from "./gdrive-redirect";

const SCOPES = [
  "https://www.googleapis.com/auth/drive.file",       // only files we create/open
  "https://www.googleapis.com/auth/userinfo.email",   // to identify connected account
];

// Fallback only — used by refresh-token API calls, where redirect_uri is never
// sent to Google. The interactive OAuth dance ALWAYS passes an explicit URI
// derived from the live request (see oauthRedirectUri), so the redirect matches
// the port Next.js actually bound (which may be 3001/3002 if 3000 was busy).
const DEFAULT_REDIRECT_URI = `http://localhost:3000${GDRIVE_CALLBACK_PATH}`;

// Re-export so route handlers keep importing the redirect helper from here.
export { oauthRedirectUri, GDRIVE_CALLBACK_PATH };

/** Build a fresh OAuth2 client, optionally with refresh_token loaded. */
export function getOAuth2Client(redirectUri: string = DEFAULT_REDIRECT_URI): OAuth2Client | null {
  const clientId = getSetting("GDRIVE_CLIENT_ID");
  const clientSecret = getSetting("GDRIVE_CLIENT_SECRET");
  if (!clientId || !clientSecret) return null;

  const client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  const refresh = getSetting("GDRIVE_REFRESH_TOKEN");
  if (refresh) client.setCredentials({ refresh_token: refresh });
  return client;
}

/**
 * First leg of OAuth: URL the user gets redirected to. `redirectUri` MUST be the
 * same value passed to exchangeCodeForTokens — Google rejects a mismatch.
 */
export function buildAuthUrl(redirectUri: string, state?: string): string {
  const oauth = getOAuth2Client(redirectUri);
  if (!oauth) {
    throw new Error("Set GDRIVE_CLIENT_ID and GDRIVE_CLIENT_SECRET in /settings first");
  }
  return oauth.generateAuthUrl({
    access_type: "offline",   // gets us a refresh_token
    prompt: "consent",        // forces refresh_token even on repeat connect
    scope: SCOPES,
    ...(state ? { state } : {}),
  });
}

/**
 * Second leg of OAuth: trade code for tokens, store refresh_token + email.
 * `redirectUri` must match the one used in buildAuthUrl for the same flow.
 */
export async function exchangeCodeForTokens(code: string, redirectUri: string): Promise<{ email: string }> {
  const oauth = getOAuth2Client(redirectUri);
  if (!oauth) throw new Error("OAuth client not configured");

  const { tokens } = await oauth.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error(
      "Google did not return a refresh_token. Revoke prior access at https://myaccount.google.com/permissions and reconnect."
    );
  }
  oauth.setCredentials(tokens);

  const oauth2api = google.oauth2({ version: "v2", auth: oauth });
  const userinfo = await oauth2api.userinfo.get();
  const email = userinfo.data.email ?? "";

  setSetting("GDRIVE_REFRESH_TOKEN", tokens.refresh_token);
  setSetting("GDRIVE_CONNECTED_EMAIL", email);
  return { email };
}

/** Authenticated Drive client; null if creds/token missing. */
export function getDriveClient(): drive_v3.Drive | null {
  const oauth = getOAuth2Client();
  if (!oauth || !getSetting("GDRIVE_REFRESH_TOKEN")) return null;
  return google.drive({ version: "v3", auth: oauth });
}

/** Categorizes Drive errors so the UI can show targeted instructions. */
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

/** Parse the verbose Google API error string into a categorized hint. */
function classifyError(msg: string): { kind: ConnectionErrorKind; enableUrl?: string } {
  if (
    msg.includes("accessNotConfigured") ||
    msg.includes("has not been used in project") ||
    msg.includes("is disabled. Enable it")
  ) {
    // Pull the Enable URL out of the error if present.
    const m = msg.match(/https:\/\/console\.developers\.google\.com\/[^\s)]+/);
    return { kind: "api_not_enabled", enableUrl: m ? m[0] : undefined };
  }
  if (
    msg.includes("invalid_grant") ||
    msg.includes("Token has been expired") ||
    msg.includes("revoked") ||
    msg.includes("invalid_client") ||
    msg.includes("unauthorized")
  ) {
    return { kind: "auth_invalid" };
  }
  if (
    msg.includes("ENOTFOUND") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("ECONNRESET") ||
    msg.includes("network")
  ) {
    return { kind: "network" };
  }
  return { kind: "other" };
}

/** Live check: do we have a working connection right now? */
export async function getConnectionStatus(): Promise<ConnectionStatus> {
  const credentialsConfigured =
    !!getSetting("GDRIVE_CLIENT_ID") && !!getSetting("GDRIVE_CLIENT_SECRET");
  const syncEnabled = getSetting("GDRIVE_SYNC_ENABLED") === "1";
  const email = getSetting("GDRIVE_CONNECTED_EMAIL");

  const drive = getDriveClient();
  if (!drive) return { connected: false, credentialsConfigured, syncEnabled };

  try {
    await drive.about.get({ fields: "user(emailAddress)" });
    return { connected: true, email: email || undefined, credentialsConfigured, syncEnabled };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const { kind, enableUrl } = classifyError(msg);
    return {
      connected: false,
      email: email || undefined,
      error: msg,
      errorKind: kind,
      enableUrl,
      credentialsConfigured,
      syncEnabled,
    };
  }
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
