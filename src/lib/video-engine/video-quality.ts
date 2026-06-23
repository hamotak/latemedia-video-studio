export type VisualJoinKind = "fresh" | "still" | "stock";

export type ImageCutTransitionKind = "hard" | "tight" | "soft" | "fresh-to-still";

export interface ImageCutTransition {
  kind: ImageCutTransitionKind;
  durationSec: number;
}

export interface FrameCrop {
  w: number;
  h: number;
  x: number;
  y: number;
  sourceW: number;
  sourceH: number;
}

const IMAGE_CUT_TRANSITION_PATTERN: ImageCutTransition[] = [
  { kind: "hard", durationSec: 0 },
  { kind: "tight", durationSec: 0.16 },
  { kind: "hard", durationSec: 0 },
  { kind: "soft", durationSec: 0.24 },
];

export function imageCutTransitionForBoundary(
  boundaryIndex: number,
  leftKind: VisualJoinKind,
  rightKind: VisualJoinKind
): ImageCutTransition {
  if (leftKind === "fresh" && rightKind !== "fresh") {
    return { kind: "fresh-to-still", durationSec: 0.28 };
  }
  return IMAGE_CUT_TRANSITION_PATTERN[boundaryIndex % IMAGE_CUT_TRANSITION_PATTERN.length];
}

export function frameNormalizeFilter(w: number, h: number, crop: FrameCrop | null = null): string {
  const prefix = crop ? `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},` : "";
  return `${prefix}scale=${w}:${h}:force_original_aspect_ratio=increase:out_range=tv,crop=${w}:${h},setsar=1,format=yuv420p,setparams=range=tv`;
}

export function frameNormalizeFilterHiRes(w: number, h: number): string {
  return `scale=${w * 2}:${h * 2}:force_original_aspect_ratio=increase:out_range=tv,crop=${w * 2}:${h * 2},setsar=1,setparams=range=tv`;
}

export interface HybridSceneAVVideoFilterOptions {
  padSec?: number;
  stretchFactor?: number;
  fps?: number;
}

export function hybridSceneAVVideoFilter(
  w: number,
  h: number,
  crop: FrameCrop | null,
  options: number | HybridSceneAVVideoFilterOptions
): string {
  const opts = typeof options === "number" ? { padSec: options } : options;
  const stretchFactor = Number.isFinite(opts.stretchFactor) ? Math.max(1, opts.stretchFactor ?? 1) : 1;
  const fps = Number.isFinite(opts.fps) ? Math.max(1, Math.round(opts.fps ?? 30)) : null;
  const padSec = Math.max(0, opts.padSec ?? 0);
  return [
    stretchFactor > 1.01 ? `setpts=${stretchFactor.toFixed(3)}*(PTS-STARTPTS)` : null,
    stretchFactor > 1.01 && fps ? `fps=${fps}` : null,
    frameNormalizeFilter(w, h, crop),
    padSec > 0 ? `tpad=stop_mode=clone:stop_duration=${padSec.toFixed(3)}` : null,
  ].filter(Boolean).join(",");
}

export function tailClipVideoFilter(w: number, h: number, crop: FrameCrop | null): string {
  return frameNormalizeFilter(w, h, crop);
}
