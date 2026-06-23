import "server-only";

declare global {
  var __appSettingCache: Map<string, string> | undefined;
  var __appSettingCacheLoadedAt: number | undefined;
}

function cache(): Map<string, string> {
  if (!global.__appSettingCache) {
    global.__appSettingCache = new Map();
  }
  return global.__appSettingCache;
}

export function getCachedAppSetting(key: string): string | undefined {
  return cache().get(key);
}

export function setCachedAppSetting(key: string, value: string): void {
  cache().set(key, value);
  global.__appSettingCacheLoadedAt = Date.now();
}

export function setCachedAppSettings(settings: Record<string, string>): void {
  const c = cache();
  c.clear();
  for (const [key, value] of Object.entries(settings)) c.set(key, value);
  global.__appSettingCacheLoadedAt = Date.now();
}

export function listCachedAppSettings(): Record<string, string> {
  return Object.fromEntries(cache().entries());
}

