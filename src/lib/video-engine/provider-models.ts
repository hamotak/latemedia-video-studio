export const DEFAULT_IMAGE_MODEL = "nano-banana-pro";
export const DEFAULT_ANIMATION_MODEL = "veo-3.1-fast";

const STALE_IMAGE_MODEL_REPLACEMENTS: Record<string, string> = {
  "imagen-4": DEFAULT_IMAGE_MODEL,
  "imagen-4-ultra": DEFAULT_IMAGE_MODEL,
};

export function normalizeImageModelId(model: string | null | undefined): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) return undefined;
  return STALE_IMAGE_MODEL_REPLACEMENTS[trimmed.toLowerCase()] ?? trimmed;
}

export function parseImageFallbackModels(raw: string, primaryModel: string | null | undefined): string[] {
  const primary = normalizeImageModelId(primaryModel)?.toLowerCase() ?? "";
  const seen = new Set<string>();
  const models: string[] = [];

  for (const part of raw.split(/[,\n]/)) {
    const normalized = normalizeImageModelId(part);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (primary && primary === key) continue;
    models.push(normalized);
  }

  return models;
}
