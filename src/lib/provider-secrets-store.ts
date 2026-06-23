import "server-only";

/**
 * Standalone build: provider API keys are entered in the Settings screen and
 * stored in the local SQLite settings table (read via
 * `@/lib/video-engine/settings`). There is no cloud `provider_secrets` table
 * to hydrate, so this loader is a no-op — kept so the video routes that import
 * it continue to compile and run unchanged.
 */
export async function loadProviderSecretsIntoCache(): Promise<void> {
  /* no-op: provider keys are read directly from local SQLite */
}
