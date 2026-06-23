export type Labs69JobKind = "tts" | "images" | "videos";

const MINUTE_MS = 60_000;

export function positiveInt(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

export function effectiveProviderSlots(configured: unknown, providerLimit: unknown, fallback: number): number {
  const provider = positiveInt(providerLimit);
  const requested = positiveInt(configured);
  const safeFallback = Math.max(1, Math.floor(fallback));
  if (provider && requested) return Math.max(1, Math.min(requested, provider));
  if (provider) return provider;
  if (requested) return requested;
  return safeFallback;
}

export function effectiveLiveSlots(
  configured: unknown,
  providerLimitPerKey: unknown,
  keyCount: number,
  fallbackPerKey: number,
  liveRemainingJobs?: number
): number {
  const perKey = effectiveProviderSlots(configured, providerLimitPerKey, fallbackPerKey);
  const staticSlots = Math.max(1, perKey * Math.max(1, Math.floor(keyCount)));
  if (typeof liveRemainingJobs === "number" && Number.isFinite(liveRemainingJobs)) {
    return Math.max(1, Math.min(staticSlots, Math.floor(liveRemainingJobs)));
  }
  return staticSlots;
}

export function isProviderCapacityResponse(status: number, body: string): boolean {
  if (status !== 403) return false;
  return /\bconcurrent\b|active jobs?|provider full|please wait for current jobs?|capacity|slots?/i.test(body);
}

export function retryWaitMs(
  retryAfterHeader: string | null,
  attempt: number,
  opts: { baseMs: number; maxMs: number }
): number {
  const retryAfter = Number(retryAfterHeader);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, opts.maxMs);
  }
  return Math.min(opts.maxMs, Math.max(opts.baseMs, opts.baseMs * attempt));
}

export function pollTimeoutMs(kind: Labs69JobKind, model?: string | null): number {
  if (kind !== "videos") return 8 * MINUTE_MS;

  const m = (model ?? "").toLowerCase();
  if (m.includes("grok")) return 12 * MINUTE_MS;
  if (m.includes("veo") || m.includes("gemini")) return 25 * MINUTE_MS;
  return 20 * MINUTE_MS;
}

export function pollIntervalMs(kind: Labs69JobKind): number {
  return kind === "videos" ? 5_000 : 2_500;
}
