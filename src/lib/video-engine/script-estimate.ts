/**
 * Script length estimation + long-run warnings — dependency-free so it powers
 * both the Video page stats and the preflight check, and can be unit-tested.
 *
 * Narration pace is ~150 words/min; the pipeline cuts ~16s scenes. A run is
 * flagged "long" past 40 scenes OR 20 minutes — that's where one-shot runs get
 * risky and a chaptered approach is safer.
 */
export const WORDS_PER_MINUTE = 150;
export const SECONDS_PER_SCENE = 16;
export const LONG_SCENES = 40;
export const LONG_MINUTES = 20;

export interface ScriptEstimate {
  words: number;
  seconds: number;
  minutes: number;
  scenes: number;
  /** Human label, e.g. "~12 min 30 s". */
  durationLabel: string;
  /** True when the run is large enough to warrant a confirmation. */
  isLong: boolean;
  /** Short, practical warnings to show for a long script. */
  warnings: string[];
}

export function estimateScript(words: number): ScriptEstimate {
  const w = Math.max(0, Math.floor(words || 0));
  const seconds = (w / WORDS_PER_MINUTE) * 60;
  const minutes = seconds / 60;
  const scenes = w === 0 ? 0 : Math.max(1, Math.round(seconds / SECONDS_PER_SCENE));

  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  const durationLabel = w === 0 ? "—" : m > 0 ? `~${m} min ${s} s` : `~${s} s`;

  const isLong = scenes >= LONG_SCENES || minutes >= LONG_MINUTES;
  const warnings: string[] = [];
  if (isLong) {
    warnings.push(
      `This is a long video (~${Math.round(minutes)} min, ~${scenes} scenes). Long one-shot runs are slower and more failure-prone.`
    );
    warnings.push("Test a 1-minute script first, then 5–10 min, before committing to a full-length run.");
  }
  if (minutes >= 60) {
    warnings.push("For ~1 hour, run it as separate chapters rather than one job.");
  }
  return { words: w, seconds, minutes, scenes, durationLabel, isLong, warnings };
}
