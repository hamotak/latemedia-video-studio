import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/video-engine/init";
import { getConnectionStatus } from "@/lib/video-engine/services/gdrive";
import { getDriveWorkspaceStatus } from "@/lib/video-engine/services/drive-workspace";
import { requireVideoEditUser } from "@/lib/video-access";

export const runtime = "nodejs";

/**
 * GET /api/video/gdrive-status — live Google Drive connection status for the
 * Saved Videos / Clips tools. Returns `{ connected, credentialsConfigured }`
 * (plus email/error detail) so the UI can decide whether to show the Drive
 * library, a "connect Drive" card, or a paused/error state.
 */
export async function GET() {
  const gate = await requireVideoEditUser();
  if (!gate) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  ensureInit();
  try {
    const status = await getConnectionStatus();
    const workspace =
      status.connected && gate.channel
        ? await getDriveWorkspaceStatus(gate.channel.name).catch((e) => ({
            error: e instanceof Error ? e.message : String(e),
          }))
        : null;
    return NextResponse.json({ ...status, workspace }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { connected: false, credentialsConfigured: false, error: msg },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  }
}
