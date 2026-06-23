export interface LimitSnapshot {
  activeCount: number;
  pendingCount: number;
  concurrency: number;
}

export function percentile(values: number[], pct: number): number | null {
  const clean = values.filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  if (clean.length === 0) return null;
  const clamped = Math.max(0, Math.min(1, pct));
  const idx = Math.min(clean.length - 1, Math.ceil(clean.length * clamped) - 1);
  return clean[idx];
}

export function imageHedgeDelayMs(configuredSeconds: string | number | null | undefined, latenciesMs: number[]): number {
  const configured = Number(configuredSeconds ?? "");
  if (Number.isFinite(configured) && configured > 0) return Math.max(1_000, Math.round(configured * 1000));
  const p75 = percentile(latenciesMs, 0.75);
  return Math.max(120_000, Math.round((p75 ?? 0) * 1.3));
}

export function limitHasSpareSlot(limit: LimitSnapshot): boolean {
  return limit.activeCount < limit.concurrency && limit.pendingCount === 0;
}

export function positiveSettingInt(value: string | number | null | undefined, fallback: number): number {
  const n = Number(value ?? "");
  if (!Number.isFinite(n) || n <= 0) return Math.max(1, Math.floor(fallback));
  return Math.max(1, Math.floor(n));
}

export function positiveSettingMs(value: string | number | null | undefined, fallbackSeconds: number): number {
  const n = Number(value ?? "");
  const seconds = Number.isFinite(n) && n > 0 ? n : fallbackSeconds;
  return Math.max(1_000, Math.round(seconds * 1000));
}

export interface VideoHedgeConfig {
  maxAttempts: number;
  maxParallel: number;
}

export function normalizeVideoHedgeConfig(
  maxAttemptsValue: string | number | null | undefined,
  maxParallelValue: string | number | null | undefined,
  fallbackMaxParallel = 3
): VideoHedgeConfig {
  const maxParallel = Math.max(1, positiveSettingInt(maxParallelValue, fallbackMaxParallel));
  const configuredAttempts = positiveSettingInt(maxAttemptsValue, maxParallel);
  return {
    maxParallel,
    maxAttempts: Math.max(configuredAttempts, maxParallel),
  };
}

export function shouldLaunchVideoHedge(input: {
  elapsedMs: number;
  hedgeAfterMs: number;
  launchedAttempts: number;
  activeAttempts: number;
  maxAttempts: number;
  maxParallel: number;
  spareSlotAvailable: boolean;
  settled?: boolean;
}): boolean {
  if (input.settled) return false;
  if (!input.spareSlotAvailable) return false;
  if (input.elapsedMs < input.hedgeAfterMs) return false;
  if (input.launchedAttempts >= input.maxAttempts) return false;
  if (input.activeAttempts >= input.maxParallel) return false;
  return true;
}
