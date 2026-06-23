import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/video-engine/init";
import { listLibraryRuns } from "@/lib/video-engine/services/library";
import { isDriveAuthError } from "@/lib/video-engine/services/stock-library";
import { requireVideoEditUser } from "@/lib/video-access";

export const runtime = "nodejs";

/**
 * A failed Drive call caused by bad/expired credentials (not a server fault).
 * Broader than the engine's `isDriveAuthError` so we also catch `deleted_client`
 * (the OAuth client was removed) and similar token failures.
 */
function isRecoverableDriveError(msg: string): boolean {
  if (isDriveAuthError(msg)) return true;
  return (
    msg.includes("deleted_client") ||
    msg.includes("unauthorized_client") ||
    msg.includes("invalid_token") ||
    msg.includes("Drive not connected") ||
    msg.includes("Google Drive is not connected")
  );
}

/**
 * GET /api/video/library/runs?channel=<name> — every past run in the active
 * channel's Drive Clips Library, each with its reusable scene clips. Returns
 * an empty list when Drive is not connected or the library is empty.
 *
 * Reuses the existing engine service (`listLibraryRuns`) — no second engine.
 */
export async function GET(req: Request) {
  const gate = await requireVideoEditUser();
  if (!gate) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  ensureInit();
  try {
    const url = new URL(req.url);
    const channel = url.searchParams.get("channel")?.trim() || undefined;
    const runs = await listLibraryRuns({ channel });
    return NextResponse.json(
      {
        runs,
        count: runs.length,
        channel: channel ?? null,
        source: "drive",
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // A dead/expired Drive token is not a server fault — surface it as a soft,
    // recoverable state (empty list + reconnect hint) instead of a 500 so the
    // UI shows "reconnect Drive" rather than an error toast.
    if (isRecoverableDriveError(msg)) {
      return NextResponse.json(
        {
          runs: [],
          count: 0,
          channel: null,
          source: "drive",
          errorKind: "drive_auth",
          error: "Reconnect Google Drive to load the clips library.",
        },
        { status: 200, headers: { "Cache-Control": "no-store" } }
      );
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
