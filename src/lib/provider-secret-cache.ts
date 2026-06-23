import "server-only";

export type CachedProviderSecret = {
  name: string;
  api_key: string | null;
  enabled: number;
  config_json: string | null;
};

declare global {
  var __providerSecretCache: Map<string, CachedProviderSecret> | undefined;
  var __providerSecretCacheLoadedAt: number | undefined;
}

function cache(): Map<string, CachedProviderSecret> {
  if (!global.__providerSecretCache) {
    global.__providerSecretCache = new Map();
  }
  return global.__providerSecretCache;
}

export function getCachedProviderSecret(name: string): CachedProviderSecret | undefined {
  return cache().get(name);
}

export function setCachedProviderSecret(secret: CachedProviderSecret): void {
  cache().set(secret.name, secret);
  global.__providerSecretCacheLoadedAt = Date.now();
}

export function setCachedProviderSecrets(secrets: CachedProviderSecret[]): void {
  const c = cache();
  c.clear();
  for (const secret of secrets) c.set(secret.name, secret);
  global.__providerSecretCacheLoadedAt = Date.now();
}

export function listCachedProviderSecrets(): CachedProviderSecret[] {
  return Array.from(cache().values());
}

