import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/video-engine/init";
import { findSimilarClips } from "@/lib/video-engine/services/library";
import type { Scene } from "@/lib/video-engine/services/scene-split";
import { requireVideoEditUser } from "@/lib/video-access";
import { loadAppSettingsIntoCache } from "@/lib/app-settings-store";
import { loadProviderSecretsIntoCache } from "@/lib/provider-secrets-store";

export const runtime = "nodejs";

interface Body {
  scenes?: Scene[];
  minScore?: number;
  topPerScene?: number;
}

function noStore(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store");
  return NextResponse.json(body, { ...init, headers });
}

export async function POST(req: Request) {
  const gate = await requireVideoEditUser();
  if (!gate) {
    return noStore({ error: "Forbidden" }, { status: 403 });
  }
  if (!gate.channel) {
    return noStore({ error: "Pick a channel before searching reusable clips." }, { status: 400 });
  }

  await Promise.all([
    loadProviderSecretsIntoCache(),
    loadAppSettingsIntoCache(),
  ]);
  ensureInit();

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return noStore({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!Array.isArray(body.scenes) || body.scenes.length === 0) {
    return noStore({ error: "scenes[] is required" }, { status: 400 });
  }

  try {
    const matches = await findSimilarClips(body.scenes, {
      minScore: body.minScore,
      topPerScene: body.topPerScene,
      channel: gate.channel.name,
    });
    return noStore({ matches, channel: gate.channel.name });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return noStore({ error: msg }, { status: 500 });
  }
}
