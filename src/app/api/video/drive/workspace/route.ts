import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/video-engine/init";
import { getConnectionStatus } from "@/lib/video-engine/services/gdrive";
import {
  driveFolderLink,
  ensureChannelWorkspace,
  getDriveWorkspaceStatus,
} from "@/lib/video-engine/services/drive-workspace";
import { requireVideoEditUser } from "@/lib/video-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await requireVideoEditUser();
  if (!gate) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  ensureInit();

  const connection = await getConnectionStatus();
  if (!connection.connected) {
    return NextResponse.json(
      { connected: false, connection, workspace: null },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  }

  const workspace = gate.channel ? await getDriveWorkspaceStatus(gate.channel.name) : null;
  return NextResponse.json(
    { connected: true, connection, workspace },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function POST() {
  const gate = await requireVideoEditUser();
  if (!gate) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  ensureInit();

  if (!gate.channel) {
    return NextResponse.json({ error: "Pick an active channel before setting up Drive." }, { status: 400 });
  }

  const connection = await getConnectionStatus();
  if (!connection.connected) {
    return NextResponse.json(
      { error: "Google Drive is not connected. Connect Drive in Settings first.", connection },
      { status: 400 }
    );
  }

  const workspace = await ensureChannelWorkspace(gate.channel.name);
  return NextResponse.json({
    ok: true,
    workspace: {
      ...workspace,
      rootFolderLink: driveFolderLink(workspace.rootFolderId),
      channelsFolderLink: driveFolderLink(workspace.channelsFolderId),
      channelFolderLink: driveFolderLink(workspace.channelFolderId),
      finalVideosFolderLink: driveFolderLink(workspace.finalVideosFolderId),
      reusableClipsFolderLink: driveFolderLink(workspace.reusableClipsFolderId),
      stockBrollFolderLink: driveFolderLink(workspace.stockBrollFolderId),
      imagesFolderLink: driveFolderLink(workspace.imagesFolderId),
      metadataFolderLink: driveFolderLink(workspace.metadataFolderId),
    },
  });
}
