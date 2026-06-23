import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/auth";
import { exchangeCodeForTokens, oauthRedirectUri } from "@/lib/video-engine/services/gdrive";

export const runtime = "nodejs";

function safeReturnTo(value: unknown): string {
  if (typeof value !== "string") return "/studio/video";
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/login")) return "/studio/video";
  return value;
}

function decodeState(value: string | null): string {
  if (!value) return "/studio/video";
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { returnTo?: unknown };
    return safeReturnTo(parsed.returnTo);
  } catch {
    return "/studio/video";
  }
}

function withStatus(req: Request, returnTo: string, status: string, error?: string): URL {
  const target = new URL(returnTo, req.url);
  target.searchParams.set("drive", status);
  if (error) target.searchParams.set("driveError", error);
  return target;
}

async function requireAdmin() {
  const user = await getAuthedUser();
  const role = user?.app_metadata?.role;
  return user && role === "admin" ? user : null;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const returnTo = decodeState(url.searchParams.get("state"));

  if (!(await requireAdmin())) {
    return NextResponse.redirect(withStatus(req, "/admin/settings/video", "admin-required"));
  }

  const error = url.searchParams.get("error");
  if (error) {
    return NextResponse.redirect(withStatus(req, returnTo, "error", error));
  }

  const code = url.searchParams.get("code");
  if (!code) {
    return NextResponse.redirect(withStatus(req, returnTo, "error", "Missing Google authorization code."));
  }

  try {
    await exchangeCodeForTokens(code, oauthRedirectUri(req));
    return NextResponse.redirect(withStatus(req, returnTo, "connected"));
  } catch (e) {
    return NextResponse.redirect(withStatus(req, returnTo, "error", e instanceof Error ? e.message : String(e)));
  }
}
