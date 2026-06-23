/**
 * Built-in style presets (Prompt 9). Each channel (and the no-channel global
 * run) picks one by id. The preset bakes in the scene-split system prompt plus
 * opinionated voice/video defaults — so a non-technical user never edits a raw
 * AI prompt. Adding a new mode = append one object to STYLE_PRESETS.
 *
 * Resolution at run time everywhere: channel column ?? preset default ?? global.
 */
export interface StylePreset {
  /** kebab-case slug stored in prompt_presets.style_preset_id / settings STYLE_PRESET_ID. */
  id: string;
  /** UI label for the dropdown. */
  label: string;
  /** one-line description shown under the dropdown. */
  description: string;
  /** Full system prompt sent to Gemini for scene splitting. */
  sceneSplitPrompt: string;
  /** Opinionated per-mode defaults that pre-fill the channel/inline form. */
  defaults: {
    ttsSpeed: number;
    ttsStability: number;
    ttsSimilarityBoost: number;
    ttsStyle: number;
    videoStyle: string;
  };
}

const SLEEP_VIDEO_STYLE =
  "Slow cinematic documentary motion, low-key lighting with deep shadows and muted earth tones, soft contrast, no harsh highlights, dreamlike pacing, gentle ambient camera drift, photographic realism with a quiet contemplative atmosphere — feels like a hushed nature documentary at dusk.";

const STANDARD_VIDEO_STYLE =
  "Clean cinematic documentary realism, even daytime lighting, natural color, soft shallow depth-of-field, steady ambient camera, no stylization or filters — feels like a network nature documentary.";

const SLEEP_PROMPT = `You are a video editor for a faceless, calming sleep/relaxation YouTube channel. Split the provided script into scenes for an automated AI video pipeline (one narrated visual beat per scene).

HOW TO SPLIT — protect the narration first:
  Each scene is one complete spoken thought. Read for meaning and sentence flow.

PACING:
- Target 12–22 seconds of narration per scene, about 25–45 words.
- Two short related sentences SHOULD share one scene when they form one thought.
- A sentence fragment is never its own scene. Always merge fragments with a neighbor.
- Do not cut after dangling connector words such as and, but, of, to, the, with, or from.

SENTENCE & CLAUSE RULES:
- Prefer breaking on sentence boundaries (. ? !).
- If one sentence is too long, split only at a natural clause boundary near the middle: em-dash (—), semicolon (;), colon (:), then comma (,).
- Never split in the middle of a phrase, name, setup/punchline, or descriptive clause.

VERBATIM COVERAGE (critical):
- Cover the ENTIRE script word-for-word. No omissions, no summarizing, no paraphrasing, no reordering, no punctuation changes.
- The concatenation of every scene's "text" field, joined with single spaces, MUST equal the original script exactly.

For EACH scene, return a JSON object with:
- "text": the exact verbatim slice of the script for this scene.
- "visual_prompt": a 40–90-word description of one calm, atmospheric cinematic shot that literally illustrates this scene's text — subject, setting, and gentle camera or subject motion (slow push-in, drifting light, rising mist). Photographic realism, tranquil mood. No on-screen text, captions, logos, or watermarks. No recognizable real people or faces in close-up. The channel's overall look is appended automatically — describe SUBSTANCE here, not style.
- "duration_hint_sec": estimated narration length in seconds (number, 12–22).

Return ONLY a strictly valid JSON array — no markdown, no commentary.`;

const STANDARD_PROMPT = `You are a video editor for a faceless general-interest documentary YouTube channel. Split the provided script into scenes for an automated AI video pipeline (one narrated visual beat per scene).

HOW TO SPLIT — protect the narration first:
  Each scene is one complete spoken thought. Read for meaning and sentence flow.

PACING:
- Target 12–22 seconds of narration per scene, about 25–45 words.
- Two short related sentences SHOULD share one scene when they form one thought.
- A sentence fragment is never its own scene. Always merge fragments with a neighbor.
- Do not cut after dangling connector words such as and, but, of, to, the, with, or from.

SENTENCE & CLAUSE RULES:
- Prefer breaking on sentence boundaries (. ? !).
- If one sentence is too long, split only at a natural clause boundary near the middle: em-dash (—), semicolon (;), colon (:), then comma (,).
- Never split in the middle of a phrase, name, setup/punchline, or descriptive clause.

VERBATIM COVERAGE (critical):
- Cover the ENTIRE script word-for-word. No omissions, no summarizing, no paraphrasing, no reordering, no punctuation changes.
- The concatenation of every scene's "text" field, joined with single spaces, MUST equal the original script exactly.

For EACH scene, return a JSON object with:
- "text": the exact verbatim slice of the script for this scene.
- "visual_prompt": a 40–90-word description of one clear, informative cinematic shot that literally illustrates this scene's text — subject, setting, and natural camera or subject motion. Photographic realism, clear natural daylight. No on-screen text, captions, logos, or watermarks. No recognizable real people or faces in close-up. The channel's overall look is appended automatically — describe SUBSTANCE here, not style.
- "duration_hint_sec": estimated narration length in seconds (number, 12–22).

Return ONLY a strictly valid JSON array — no markdown, no commentary.`;

export const STYLE_PRESETS: StylePreset[] = [
  {
    id: "sleep-calm",
    label: "Sleep · Calm documentary",
    description: "Slow, hushed pacing for sleep/relaxation content. Snappier hook, then a calm body.",
    sceneSplitPrompt: SLEEP_PROMPT,
    defaults: {
      ttsSpeed: 0.85,
      ttsStability: 0.6,
      ttsSimilarityBoost: 0.75,
      ttsStyle: 0.15,
      videoStyle: SLEEP_VIDEO_STYLE,
    },
  },
  {
    id: "standard-neutral",
    label: "Standard · Neutral documentary",
    description: "Clear, neutral pacing and a clean daytime look for general documentary content.",
    sceneSplitPrompt: STANDARD_PROMPT,
    defaults: {
      ttsSpeed: 1.0,
      ttsStability: 0.5,
      ttsSimilarityBoost: 0.75,
      ttsStyle: 0.0,
      videoStyle: STANDARD_VIDEO_STYLE,
    },
  },
];

export const DEFAULT_STYLE_PRESET_ID = "sleep-calm";

/** Find a preset by id, falling back to the default (sleep-calm). Never throws. */
export function loadStylePreset(id: string | null | undefined): StylePreset {
  return STYLE_PRESETS.find((p) => p.id === id) ?? STYLE_PRESETS[0];
}
