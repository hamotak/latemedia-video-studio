import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import db from "./db";
import { getRunDir } from "./run-paths";
import type { LogEntry } from "./logger";
import { driveFileLink, driveFolderLink } from "./services/drive-workspace";

let client: SupabaseClient | null | undefined;

function supabaseAdmin(): SupabaseClient | null {
  if (client !== undefined) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    client = null;
    return null;
  }
  client = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return client;
}

function parseJson(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function sqliteTimeToIso(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  if (value.includes("T")) return value.endsWith("Z") ? value : `${value}Z`;
  return `${value.replace(" ", "T")}Z`;
}

type RunRow = {
  id: string;
  title: string | null;
  folder_name: string | null;
  status: string;
  script: string | null;
  config_json: string | null;
  output_path: string | null;
  created_at: string | null;
  updated_at: string | null;
  preset_id: number | null;
  preset_name: string | null;
  preset_stock_folder: string | null;
  drive_clips_folder_id: string | null;
  drive_final_video_id: string | null;
  drive_synced_at: string | null;
};

const getRunStmt = db.prepare("SELECT * FROM runs WHERE id = ?");

export async function mirrorVideoRun(
  runId: string,
  opts: { channelId?: number | null; createdBy?: string | null; error?: string | null } = {}
): Promise<void> {
  const sb = supabaseAdmin();
  if (!sb) return;

  const row = getRunStmt.get(runId) as RunRow | undefined;
  if (!row) return;

  const config = {
    ...parseJson(row.config_json),
    folderName: row.folder_name,
    presetId: row.preset_id,
    presetName: row.preset_name,
    stockFolder: row.preset_stock_folder,
    driveSyncedAt: row.drive_synced_at,
    clipsFolderLink: driveFolderLink(row.drive_clips_folder_id),
    finalVideoLink: driveFileLink(row.drive_final_video_id),
  };

  const payload: Record<string, unknown> = {
    id: row.id,
    title: row.title,
    status: row.status,
    script: row.script,
    config,
    local_run_dir: getRunDir(row.id),
    output_path: row.output_path,
    drive_file_id: row.drive_final_video_id,
    drive_folder_id: row.drive_clips_folder_id,
    drive_url: driveFileLink(row.drive_final_video_id) ?? driveFolderLink(row.drive_clips_folder_id),
    preview_url: driveFileLink(row.drive_final_video_id),
    error: opts.error ?? null,
    updated_at: sqliteTimeToIso(row.updated_at) ?? new Date().toISOString(),
  };
  if (opts.channelId !== undefined) payload.channel_id = opts.channelId;
  if (opts.createdBy !== undefined) payload.created_by = opts.createdBy;
  const createdAt = sqliteTimeToIso(row.created_at);
  if (createdAt) payload.created_at = createdAt;

  const { error } = await sb.from("video_runs").upsert(payload, { onConflict: "id" });
  if (error) throw new Error(error.message);
}

export async function mirrorVideoLog(entry: LogEntry): Promise<void> {
  const sb = supabaseAdmin();
  if (!sb) return;

  const payload = {
    run_id: entry.runId,
    level: entry.level,
    message: entry.message,
    payload: {
      stage: entry.stage ?? null,
      data: entry.data ?? null,
      local_id: entry.id ?? null,
      ts: entry.ts,
    },
    created_at: entry.ts,
  };
  const { error } = await sb.from("video_run_logs").insert(payload);
  if (error) throw new Error(error.message);
}
