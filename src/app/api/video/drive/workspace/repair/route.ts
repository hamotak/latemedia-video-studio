import { NextResponse } from "next/server";
import { resolveChannelStockFolder } from "@/lib/video-engine/channel-stock";
import { ensureInit } from "@/lib/video-engine/init";
import { getSetting } from "@/lib/video-engine/settings";
import { getConnectionStatus } from "@/lib/video-engine/services/gdrive";
import { repairChannelDriveWorkspace } from "@/lib/video-engine/services/drive-workspace";
import { requireVideoEditUser } from "@/lib/video-access";
import { parseOptionalChannelId } from "../../../stock/generate/_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const parsedChannelId = parseOptionalChannelId(new URL(req.url).searchParams.get("channelId"));
  if (!parsedChannelId.ok) return parsedChannelId.response;
  const gate = await requireVideoEditUser(parsedChannelId.value);
  if (!gate) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  ensureInit();

  if (!gate.channel) {
    return NextResponse.json({ error: "Pick an active channel before repairing Drive." }, { status: 400 });
  }

  const connection = await getConnectionStatus();
  if (!connection.connected) {
    return NextResponse.json(
      { error: "Google Drive is not connected. Connect Drive in Settings first.", connection },
      { status: 400 }
    );
  }

  const targetLegacyFolder = resolveChannelStockFolder(gate.channel.name, gate.channel.stock_folder);
  const repair = await repairChannelDriveWorkspace(gate.channel.name, {
    targetLegacyFolderName: targetLegacyFolder,
    renameEmptyFolders: [
      gate.channel.stock_folder,
      getSetting("STOCK_LIBRARY_FOLDER"),
    ],
  });

  return NextResponse.json(
    {
      ok: true,
      connectedEmail: connection.email ?? null,
      channel: {
        id: gate.channel.id,
        name: gate.channel.name,
        stockFolder: gate.channel.stock_folder ?? null,
        targetLegacyFolder,
      },
      repair,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
