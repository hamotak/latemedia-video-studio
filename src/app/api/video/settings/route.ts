import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/auth";
import {
  getMaskedSettings,
  setSetting,
  SETTING_KEYS,
  isMaskedValue,
  type SettingKey,
} from "@/lib/video-engine/settings";
import { loadAppSettingsIntoCache, setAppSetting } from "@/lib/app-settings-store";
import { loadProviderSecretsIntoCache } from "@/lib/provider-secrets-store";

export const runtime = "nodejs";

async function requireAdmin() {
  const user = await getAuthedUser();
  const role = user?.app_metadata?.role;
  if (!user || role !== "admin") return null;
  return user;
}

/** GET /api/video/settings — masked provider/render settings (admin only). */
export async function GET() {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  await Promise.all([
    loadProviderSecretsIntoCache(),
    loadAppSettingsIntoCache(),
  ]);
  return NextResponse.json({ settings: getMaskedSettings() });
}

/** POST /api/video/settings — update settings. Masked values are ignored (unchanged). */
export async function POST(req: Request) {
  const user = await requireAdmin();
  if (!user) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { settings } = (await req.json().catch(() => ({}))) as {
    settings?: Record<string, string>;
  };
  if (!settings || typeof settings !== "object") {
    return NextResponse.json({ error: "settings object required" }, { status: 400 });
  }

  const valid = new Set<string>(SETTING_KEYS);
  for (const [k, v] of Object.entries(settings)) {
    if (!valid.has(k) || typeof v !== "string") continue;
    // Don't overwrite a secret with its masked display value.
    if (isMaskedValue(v)) continue;
    await setAppSetting(k, v, user.id);
    setSetting(k as SettingKey, v);
  }
  return NextResponse.json({ ok: true });
}
