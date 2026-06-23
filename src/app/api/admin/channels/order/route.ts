import { NextRequest, NextResponse } from "next/server";
import { reorderChannels } from "@/lib/channels-store";
import { accessResponse, requireAdminAccess } from "@/lib/server-access";

export const runtime = "nodejs";

export async function PATCH(req: NextRequest) {
  const access = await requireAdminAccess();
  if (!access.ok) return accessResponse(access, "Admin access required.");

  const body = (await req.json().catch(() => ({}))) as {
    orderedChannelIds?: unknown;
  };
  if (!Array.isArray(body.orderedChannelIds)) {
    return NextResponse.json({ error: "orderedChannelIds must be an array." }, { status: 400 });
  }

  const orderedChannelIds = body.orderedChannelIds.map((value) => Number(value));
  if (orderedChannelIds.length === 0 || orderedChannelIds.some((id) => !Number.isInteger(id) || id <= 0)) {
    return NextResponse.json({ error: "orderedChannelIds must contain positive numeric ids." }, { status: 400 });
  }

  try {
    const channels = await reorderChannels(orderedChannelIds);
    return NextResponse.json({ ok: true, channels });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to reorder channels.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
