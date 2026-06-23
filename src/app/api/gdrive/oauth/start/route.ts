import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/auth";
import { buildAuthUrl, oauthRedirectUri } from "@/lib/video-engine/services/gdrive";

export const runtime = "nodejs";

function safeReturnTo(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/studio/video";
  if (value.startsWith("/login")) return "/studio/video";
  return value;
}

function encodeState(returnTo: string): string {
  return Buffer.from(JSON.stringify({ returnTo })).toString("base64url");
}

async function requireAdmin() {
  const user = await getAuthedUser();
  const role = user?.app_metadata?.role;
  return user && role === "admin" ? user : null;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const returnTo = safeReturnTo(url.searchParams.get("returnTo"));

  if (!(await requireAdmin())) {
    const denied = new URL("/admin/settings/video", req.url);
    denied.searchParams.set("drive", "admin-required");
    return NextResponse.redirect(denied);
  }

  try {
    const redirectUri = oauthRedirectUri(req);
    const authUrl = buildAuthUrl(redirectUri, encodeState(returnTo));
    return NextResponse.redirect(authUrl);
  } catch (e) {
    const target = new URL(returnTo, req.url);
    target.searchParams.set("drive", "setup-required");
    target.searchParams.set("driveError", e instanceof Error ? e.message : String(e));
    return NextResponse.redirect(target);
  }
}
