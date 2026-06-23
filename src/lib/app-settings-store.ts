import "server-only";
import { setSetting, type SettingKey } from "@/lib/video-engine/settings";

/**
 * Standalone build: settings live in the local SQLite database the video
 * engine already owns (`hum.db`). There is no cloud `app_settings` table to
 * hydrate, so the loader is a no-op and writes go straight to local storage.
 * This preserves the call signatures the video routes already import.
 */
export async function loadAppSettingsIntoCache(): Promise<void> {
  /* no-op: settings are read directly from local SQLite */
}

export async function setAppSetting(key: string, value: string, _userId?: string): Promise<void> {
  setSetting(key as SettingKey, value);
}
