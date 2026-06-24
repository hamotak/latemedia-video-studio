/**
 * Visual-continuity planning — pure rules, no DB, no FFmpeg.
 *
 * Bilal Video Studio generates each scene independently, so adjacent shots can jump
 * even when the narration is one beat. Continuity gives the next scene a way
 * to inherit visual identity (subject, wardrobe, palette) from the previous
 * one when they actually belong together — and to deliberately NOT inherit
 * when the script cuts to a new place or subject.
 *
 * Three modes are recognised (`VISUAL_CONTINUITY_MODE`):
 *  - "off"      → no anchors, every scene generated fresh (original behaviour).
 *  - "prompt"   → the next scene's image prompt is enriched with the previous
 *                 scene's `continuity_hint`. Pure prompt-engineering. No new
 *                 network calls. Safe default.
 *  - "keyframe" → would chain the previous video's last frame into the next
 *                 image. Requires the provider to be able to fetch the local
 *                 last-frame file (a public URL or an upload endpoint). The
 *                 current 69labs client supports neither, so the pipeline
 *                 declines to enable this mode and logs a clear reason.
 *
 * The PLANNING here is identical in "prompt" and "keyframe" mode — it answers
 * "should scene N continue from scene M?". Only what the pipeline DOES with
 * that answer differs.
 */
import path from "node:path";

export type ContinuityMode = "off" | "prompt" | "keyframe";

export function isContinuityMode(s: string | null | undefined): s is ContinuityMode {
  return s === "off" || s === "prompt" || s === "keyframe";
}

/** Shape we actually need from a Scene; intentionally NOT typed against the
 *  full Scene to keep this module dependency-free + unit-testable. */
export interface ContinuityScene {
  index: number;
  visual_prompt: string;
  continuity_group_id?: string | null;
  continuity_break?: boolean;
  continuity_hint?: string | null;
}

export interface ContinuityStep {
  index: number;
  /** Previous scene whose identity this scene should inherit (null = fresh). */
  anchorIndex: number | null;
  /** Text to append to the next image prompt when anchoring. Null when fresh. */
  promptSuffix: string | null;
}

/**
 * Returns a per-scene continuity plan. The rules are conservative — when in
 * doubt, generate FRESH so a close-up of a beard never inherits a wide
 * ocean shot's hint.
 *
 * A scene continues from the previous one only when ALL hold:
 *  - mode is "prompt" or "keyframe"
 *  - it's not the first scene
 *  - this scene is not flagged `continuity_break`
 *  - both scenes share a non-empty `continuity_group_id`
 *  - the previous scene contributes a non-empty `continuity_hint` (or a fallback)
 */
export function planContinuity(
  scenes: ContinuityScene[],
  mode: ContinuityMode = "prompt"
): ContinuityStep[] {
  const out: ContinuityStep[] = [];
  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i];
    if (mode === "off" || i === 0) {
      out.push({ index: s.index, anchorIndex: null, promptSuffix: null });
      continue;
    }
    const prev = scenes[i - 1];
    const sameGroup =
      !!s.continuity_group_id &&
      !!prev.continuity_group_id &&
      s.continuity_group_id === prev.continuity_group_id;
    const broken = s.continuity_break === true;
    if (!sameGroup || broken) {
      out.push({ index: s.index, anchorIndex: null, promptSuffix: null });
      continue;
    }
    // Carry the previous scene's identity hint. If the LLM omitted the hint,
    // fall back to a one-line distillation of the previous visual prompt so the
    // anchor still says SOMETHING concrete.
    const hint = prev.continuity_hint?.trim() || firstSentence(prev.visual_prompt);
    out.push({
      index: s.index,
      anchorIndex: prev.index,
      promptSuffix: hint
        ? `Match the visual identity of the previous shot: ${hint}`
        : null,
    });
  }
  return out;
}

function firstSentence(text: string): string {
  const t = (text || "").trim();
  if (!t) return "";
  const m = /^[^.!?]+[.!?]/.exec(t);
  return (m ? m[0] : t).trim();
}

/** Where the last-frame JPG for scene N lives. Three-digit padded to match
 *  the rest of the run filename convention (scene_000.mp4, etc.). */
export function lastFramePath(runDir: string, sceneIndex: number): string {
  const padded = String(sceneIndex).padStart(3, "0");
  return path.join(runDir, "continuity", `scene_${padded}_last.jpg`);
}
