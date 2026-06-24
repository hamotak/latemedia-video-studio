import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/video-engine/init";
import { trashFile } from "@/lib/video-engine/services/gdrive";
import { markStockClipsDeletedByDriveIds } from "@/lib/video-engine/services/stock-gen";
import { isBRollClipId, deleteBRollClip } from "@/lib/video-engine/local-output";
import { tryParseJson, isJsonObject } from "@/lib/video-engine/json-body";
import { requireVideoEditUser } from "@/lib/video-access";
import { parseOptionalChannelId } from "../generate/_shared";

export const runtime = "nodejs";

/** POST /api/video/stock/delete  { ids: string[] } — move clips to Drive trash. */
export async function POST(req: Request) {
  const parsed = tryParseJson(await req.text());
  if (!parsed.ok || !isJsonObject(parsed.value)) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsedChannelId = parseOptionalChannelId(parsed.value.channelId);
  if (!parsedChannelId.ok) return parsedChannelId.response;
  if (!(await requireVideoEditUser(parsedChannelId.value))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  ensureInit();

  const rawIds = (parsed.value as { ids?: unknown }).ids;
  const ids = Array.isArray(rawIds) ? rawIds.filter((x): x is string => typeof x === "string") : [];
  if (ids.length === 0) {
    return NextResponse.json({ error: "No ids provided" }, { status: 400 });
  }

  let deleted = 0;
  let localDeleted = 0;
  const trashedDriveIds: string[] = [];
  const errors: string[] = [];
  for (const id of ids) {
    try {
      if (isBRollClipId(id)) {
        if (deleteBRollClip(id)) localDeleted++;
      } else {
        await trashFile(id);
        trashedDriveIds.push(id);
      }
      deleted++;
    } catch (e) {
      errors.push(`${id}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 120));
    }
  }
  const jobsUpdated = markStockClipsDeletedByDriveIds(trashedDriveIds);
  return NextResponse.json({ deleted, localDeleted, failed: errors.length, errors, jobsUpdated });
}
