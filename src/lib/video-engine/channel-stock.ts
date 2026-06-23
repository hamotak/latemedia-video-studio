import { loadStylePreset, DEFAULT_STYLE_PRESET_ID } from "./style-presets";
import { inferChannelSettings } from "./channel-intelligence";

export const DEFAULT_HYBRID_FRESH_MINUTES = 1;
export const MAX_HYBRID_FRESH_MINUTES = 10;

function clampHybridFreshMinutes(value: number): number {
  return Math.min(MAX_HYBRID_FRESH_MINUTES, Math.max(1, Math.round(value)));
}

/** Drive-safe folder name derived from a channel name. */
export function defaultStockFolder(channelName: string): string {
  const trimmed = channelName.trim();
  if (!trimmed) return "Channel";
  const slug = trimmed
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug.slice(0, 64) || "Channel";
}

/** Theme string for Gemini stock-prompt expansion — general B-roll, not scene-specific. */
export function channelStockTheme(opts: {
  name: string;
  description?: string | null;
  stylePresetId?: string | null;
  videoStyle?: string | null;
}): string {
  const preset = loadStylePreset(opts.stylePresetId ?? DEFAULT_STYLE_PRESET_ID);
  const inferred = inferChannelSettings({
    name: opts.name,
    description: opts.description,
    stylePresetId: opts.stylePresetId,
    videoStyle: opts.videoStyle,
  });
  const parts = [
    opts.name.trim(),
    opts.description?.trim(),
    inferred.visualDoctrine,
    `${preset.label} channel`,
    preset.defaults.videoStyle?.slice(0, 120),
    opts.videoStyle?.trim()?.slice(0, 120),
  ].filter(Boolean);
  return parts.join(". ");
}

/** Fresh AI minutes for Hybrid — channel wins, then global, then 5. */
export function resolveHybridFreshMinutes(
  channelMinutes: number | null | undefined,
  globalSetting?: string | null
): number {
  if (channelMinutes != null && Number.isFinite(channelMinutes) && channelMinutes > 0) {
    return clampHybridFreshMinutes(channelMinutes);
  }
  const g = globalSetting != null && globalSetting.trim() !== "" ? Number(globalSetting) : NaN;
  if (Number.isFinite(g) && g > 0) return clampHybridFreshMinutes(g);
  return DEFAULT_HYBRID_FRESH_MINUTES;
}

/** Stock Drive folder — channel name slug, explicit folder, or fallback. */
export function resolveStockFolder(
  channelName: string,
  channelFolder: string | null | undefined,
  globalFolder?: string | null
): string {
  const explicit = channelFolder?.trim();
  if (explicit) return explicit;
  const global = globalFolder?.trim();
  if (global) return global;
  return defaultStockFolder(channelName);
}

/** Channel-scoped stock cache/fallback key. Never falls back to the global legacy folder. */
export function resolveChannelStockFolder(
  channelName: string,
  channelFolder: string | null | undefined
): string {
  const explicit = channelFolder?.trim();
  if (explicit) return explicit;
  return defaultStockFolder(channelName);
}
