import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import { getSetting } from "../settings";
import { getPrompt } from "../prompts";
import { log } from "../logger";
import { getRunDir } from "../run-paths";
import { WORDS_PER_MINUTE } from "../script-estimate";
import { splitScriptAtNarrationDuration } from "../hybrid-fresh-boundary";
import { chunkTextByNarrationUnits } from "../text-chunking";
import {
  FRESH_OPENING_SCENE_MAX_SECONDS,
  FRESH_OPENING_SCENE_TARGET_SECONDS,
  estimateFreshOpeningSceneSeconds,
  normalizeFreshOpeningScenes,
  normalizeNarrationScenes,
  validateFreshOpeningScenes,
} from "../scene-chunking";

export interface Scene {
  index: number;
  text: string;
  visual_prompt: string;
  duration_hint_sec: number;
  source_kind?: "fresh" | "stock" | "image_card";
  /** Visual continuity (optional, added 2026-05-28). All three are emitted by
   *  the LLM when the scene-split prompt asks for them; older scenes.json files
   *  lack them and the planner falls back to "fresh shot per scene". */
  continuity_group_id?: string | null;
  continuity_break?: boolean;
  continuity_hint?: string | null;
}

/**
 * Chunk threshold for scene-split.
 *
 * Gemini 2.5 Flash/Pro caps output at 65 535 tokens. A scene-split JSON entry
 * averages ~180 tokens (text + 60–120-word visual_prompt + duration), so a
 * ~3 000-word script → ~300 scenes → ~54 K output — at that point we are
 * uncomfortably close to the hard cap. Past this we split the script at
 * SENTENCE boundaries into chunks of ≤ this many words, scene-split each
 * chunk separately, and concatenate the results. The pipeline downstream
 * (TTS, video, assembly) is unaware that any chunking happened.
 *
 * Why sentence boundaries: the LLM never sees a half-sentence at the seam,
 * so coverage stays clean and no scene is born torn-in-two.
 */
const WORDS_PER_CHUNK = 3000;
const STOCK_TAIL_TARGET_WORDS = Math.round((16 / 60) * WORDS_PER_MINUTE);
const STOCK_TAIL_MAX_WORDS = Math.round((22 / 60) * WORDS_PER_MINUTE);
const FRESH_OPENING_RESPONSE_SCHEMA = {
  type: "array",
  minItems: 1,
  items: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "Exact contiguous narration text for this Fresh AI opening chunk. Preserve the script words exactly.",
      },
      visual_prompt: {
        type: "string",
        description: "One cinematic historical maritime shot matching this exact narration beat.",
      },
      duration_hint_sec: {
        type: "number",
        description: "Estimated narration duration in seconds, normally 5 to 7.",
      },
      continuity_group_id: {
        type: "string",
        description: "Optional continuity group for recurring ship, harbour, chart, crew, or storm imagery.",
      },
      continuity_break: {
        type: "boolean",
        description: "True only when this chunk intentionally starts a new visual continuity thread.",
      },
      continuity_hint: {
        type: "string",
        description: "Optional visual continuity note for the next scene.",
      },
    },
    required: ["text", "visual_prompt", "duration_hint_sec"],
  },
};

export interface HybridScriptPlan {
  scenes: Scene[];
  freshSceneCount: number;
  freshText: string;
  tailText: string;
}

export interface FreshOpeningScriptPlan {
  scenes: Scene[];
  freshSceneCount: number;
  freshText: string;
  tailText: string;
}

/**
 * Splits the script into scenes. Supports Google Gemini (default, cheap) and
 * Anthropic Claude.
 *
 * `overrideSystemPrompt` — when a channel profile chose its own scene_split
 * prompt on the New Run page, that prompt replaces the default for this call.
 *
 * Scripts longer than ~3 000 words (≈ 20–25 min of narration) are
 * automatically chunked at sentence boundaries; no manual intervention needed.
 */
export async function splitScript(
  runId: string,
  script: string,
  overrideSystemPrompt?: string,
  visualStylePrompt?: string | null
): Promise<Scene[]> {
  const provider = (getSetting("SCENE_SPLIT_PROVIDER") || "google").toLowerCase();
  const basePrompt = overrideSystemPrompt?.trim() ? overrideSystemPrompt : getPrompt("scene_split");
  const systemPrompt = withChannelVisualDoctrine(basePrompt, visualStylePrompt);

  const totalWords = script.trim().split(/\s+/).filter(Boolean).length;
  log(runId, "info", `Splitting script (${provider}) — ${totalWords} words`, {
    stage: "scene_split",
    data: { scriptChars: script.length, totalWords },
  });

  let rawScenes: Scene[];

  if (totalWords <= WORDS_PER_CHUNK) {
    // Small enough for one pass.
    rawScenes = await processChunk(provider, systemPrompt, script, 0, runId);
  } else {
    // Long script — split at sentence boundaries and scene-split each chunk.
    const chunks = chunkTextByNarrationUnits(script, { targetWords: WORDS_PER_CHUNK });
    log(
      runId,
      "info",
      `Script is too long for one ${provider} call (over ${WORDS_PER_CHUNK} words) — ` +
        `splitting into ${chunks.length} chunks for scene_split`,
      { stage: "scene_split", data: { chunkCount: chunks.length, totalWords } }
    );

    rawScenes = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunkWords = chunks[i].trim().split(/\s+/).filter(Boolean).length;
      log(
        runId,
        "info",
        `Scene-splitting chunk ${i + 1}/${chunks.length} (${chunkWords} words)`,
        { stage: "scene_split" }
      );
      const chunkScenes = await processChunk(
        provider,
        systemPrompt,
        chunks[i],
        rawScenes.length,
        runId
      );
      rawScenes.push(...chunkScenes);
    }
  }

  // Apply narration-safe normalization AFTER all chunks are combined. The LLM
  // may still return tiny shot fragments; this rebuilds the scene text from the
  // original order into sentence-first narration beats.
  const scenes = normalizeNarrationScenes(rawScenes);

  // Coverage check: words in scene.text vs original script. <70% means the
  // model summarized; we warn but still return what we got.
  const sceneWords = scenes.reduce(
    (sum, s) => sum + s.text.trim().split(/\s+/).filter(Boolean).length,
    0
  );
  const coverage = totalWords > 0 ? (sceneWords / totalWords) * 100 : 0;

  log(
    runId,
    "success",
    `Done: ${scenes.length} scenes · script coverage ${coverage.toFixed(0)}% (${sceneWords}/${totalWords} words)`,
    {
      stage: "scene_split",
      // Show only the first 5 scene snippets so data_json doesn't bloat on
      // long videos with 500+ scenes.
      data: { scenes: scenes.slice(0, 5).map((s) => ({ i: s.index, text: s.text.slice(0, 60) })) },
    }
  );

  if (coverage < 70) {
    log(
      runId,
      "warn",
      `⚠️ Low coverage (${coverage.toFixed(0)}%) — the model likely summarized the script. Review the scene_split prompt on /prompts.`,
      { stage: "scene_split" }
    );
  }

  return scenes;
}

export async function splitHybridScript(
  runId: string,
  script: string,
  freshSeconds: number,
  overrideSystemPrompt?: string,
  visualStylePrompt?: string | null
): Promise<HybridScriptPlan> {
  const opening = await splitFreshOpeningScript(
    runId,
    script,
    freshSeconds,
    overrideSystemPrompt,
    visualStylePrompt,
    "hybrid script"
  );
  const tailScenes = buildStockTailScenes(opening.tailText, opening.freshSceneCount);
  const scenes = [...opening.scenes, ...tailScenes];

  log(
    runId,
    "success",
    `Hybrid script plan ready: ${opening.freshSceneCount} Fresh AI chunk${opening.freshSceneCount === 1 ? "" : "s"} + stock tail${tailScenes.length ? ` (${tailScenes.length} internal beats)` : ""}`,
    {
      stage: "scene_split",
      data: {
        freshSceneCount: opening.freshSceneCount,
        stockBeatCount: tailScenes.length,
        scenes: opening.scenes.slice(0, 5).map((s) => ({ i: s.index, text: s.text.slice(0, 80) })),
      },
    }
  );

  return {
    scenes,
    freshSceneCount: opening.freshSceneCount,
    freshText: opening.freshText,
    tailText: opening.tailText,
  };
}

export async function splitFreshOpeningScript(
  runId: string,
  script: string,
  freshSeconds: number,
  overrideSystemPrompt?: string,
  visualStylePrompt?: string | null,
  planLabel = "fresh opening"
): Promise<FreshOpeningScriptPlan> {
  const provider = (getSetting("SCENE_SPLIT_PROVIDER") || "google").toLowerCase();
  const systemPrompt = overrideSystemPrompt?.trim() ? overrideSystemPrompt : getPrompt("scene_split");
  const { freshText, tailText } = splitScriptAtNarrationDuration(script, freshSeconds);

  log(runId, "info", `Planning ${planLabel}: ${freshSeconds > 0 ? `${Math.round(freshSeconds)}s Fresh AI opening` : "no Fresh AI opening"}`, {
    stage: "scene_split",
    data: {
      freshWords: wordCount(freshText),
      tailWords: wordCount(tailText),
      aiPlannerScope: "fresh_opening_only",
    },
  });

  const freshScenes = freshText
    ? await splitFreshOpening(provider, systemPrompt, visualStylePrompt ?? null, freshText, runId)
    : [];

  return {
    scenes: freshScenes,
    freshSceneCount: freshScenes.length,
    freshText,
    tailText,
  };
}

async function splitFreshOpening(
  provider: string,
  plannerPrompt: string,
  visualStylePrompt: string | null,
  freshText: string,
  runId: string
): Promise<Scene[]> {
  let rawScenes = await processFreshOpeningChunk(provider, plannerPrompt, visualStylePrompt, freshText, runId);
  let scenes = finalizeFreshScenes(rawScenes);
  let validation = validateFreshOpeningScenes(scenes, freshText);

  if (!validation.ok) {
    log(runId, "warn", `Fresh AI chunk planner needs repair: ${validation.errors.slice(0, 3).join(" ")}`, {
      stage: "scene_split",
      data: { errors: validation.errors },
    });
    rawScenes = await processFreshOpeningChunk(provider, plannerPrompt, visualStylePrompt, freshText, runId, validation.errors);
    scenes = finalizeFreshScenes(rawScenes);
    validation = validateFreshOpeningScenes(scenes, freshText);
  }

  if (!validation.ok) {
    log(runId, "warn", `Fresh AI chunk planner failed validation after repair; using deterministic fallback. ${validation.errors.slice(0, 3).join(" ")}`, {
      stage: "scene_split",
      data: { errors: validation.errors },
    });
    return fallbackFreshOpeningScenes(freshText, visualStylePrompt);
  }

  return scenes;
}

async function processFreshOpeningChunk(
  provider: string,
  plannerPrompt: string,
  visualStylePrompt: string | null,
  freshText: string,
  runId: string,
  repairErrors?: string[]
): Promise<Scene[]> {
  const prompt = buildFreshOpeningPrompt(plannerPrompt, visualStylePrompt, repairErrors);
  const raw =
    provider === "google"
      ? await splitWithGemini(prompt, freshText, {
          thinkingBudget: 0,
          responseSchema: FRESH_OPENING_RESPONSE_SCHEMA,
        })
      : provider === "anthropic"
        ? await splitWithClaude(prompt, freshText)
        : (() => {
            throw new Error(`Unknown SCENE_SPLIT_PROVIDER: ${provider}`);
          })();

  let json: unknown;
  try {
    json = extractJson(raw);
  } catch (e) {
    try {
      const runDir = getRunDir(runId);
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, `fresh_chunk_plan_raw_${Date.now()}.txt`), raw, "utf-8");
    } catch {}
    throw e;
  }
  if (!Array.isArray(json)) throw new Error("fresh chunk planner: model did not return a JSON array");

  return (json as Record<string, unknown>[]).map((s, i) => ({
    index: i,
    text: String(s.text ?? ""),
    visual_prompt: String(s.visual_prompt ?? ""),
    duration_hint_sec: Number(s.duration_hint_sec ?? 6),
    source_kind: "fresh",
    continuity_group_id: typeof s.continuity_group_id === "string" ? s.continuity_group_id : null,
    continuity_break: i === 0 || s.continuity_break === true,
    continuity_hint: typeof s.continuity_hint === "string" ? s.continuity_hint : null,
  }));
}

function buildFreshOpeningPrompt(plannerPrompt: string, visualStylePrompt: string | null, repairErrors?: string[]): string {
  const visualGuidance = freshOpeningVisualGuidance(plannerPrompt, visualStylePrompt);
  return [
    "You are planning the Fresh AI opening for an AI-video generator.",
    "Return ONLY JSON matching the provided schema. Each item must include: text, visual_prompt, duration_hint_sec.",
    `Each chunk must be a natural narration beat estimated at ${FRESH_OPENING_SCENE_MAX_SECONDS} seconds or less. Target ${Math.max(3, FRESH_OPENING_SCENE_TARGET_SECONDS - 1)}-${FRESH_OPENING_SCENE_TARGET_SECONDS} seconds so an 8-second provider clip has breathing room.`,
    "Preserve the script text exactly and in order. Do not summarize, paraphrase, duplicate, omit, or reorder words.",
    "Prefer sentence and clause boundaries. Never end a chunk on a connector or dangling word such as with, their, across, from, and, the, to, or of.",
    "Never start a chunk with a connector or orphaned phrase such as across the water.",
    "Never split a named place, ship type, historical phrase, or noun phrase across chunks. Examples: Jamaican coast, West Africa coast, golden age, converted merchant sloop, gun ports, tall masts.",
    "If a sentence is too long, split at a meaningful clause boundary so both sides sound natural when narrated.",
    "Keep every visual_prompt anchored to the historical world implied by the script. For pirate, frigate, sloop, Jamaica, Caribbean, West Africa, golden age of piracy, or naval pursuit scripts, every visual_prompt must stay in a 17th-18th century maritime pirate/naval setting: period wooden ships, rigging, gun decks, gun ports, weathered sails, coastal harbors, open sea, and period sailors.",
    "Do not drift into generic rocky coastlines, modern clothing, roads, cars, buildings, fantasy armor, unrelated wilderness, or lone tourist/traveler imagery.",
    "Write visual_prompt as one cinematic shot for that exact narration beat. No text, captions, logos, watermarks, or UI overlays.",
    repairErrors?.length
      ? `Repair these validation issues from the previous attempt: ${repairErrors.join(" ")}`
      : "",
    visualGuidance ? "Visual style reference for prompts:" : "",
    visualGuidance,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function withChannelVisualDoctrine(systemPrompt: string, visualStylePrompt?: string | null): string {
  const doctrine = compact(visualStylePrompt ?? "");
  if (!doctrine) return systemPrompt;
  return [
    systemPrompt,
    "CHANNEL VISUAL DOCTRINE FOR EVERY visual_prompt:",
    doctrine,
    "Hard matching rules: every visual_prompt must visibly match the exact narration text first. Keep named places, era, subject, objects, actions, creatures, vehicles, and physical setting from the scene text. If the scene is abstract, translate it through the channel visual doctrine instead of switching to unrelated generic imagery. Do not use a pretty establishing shot that ignores the words being narrated.",
  ].join("\n\n");
}

function freshOpeningVisualGuidance(plannerPrompt: string, visualStylePrompt: string | null): string {
  const visualStyle = compact(visualStylePrompt ?? "");
  if (visualStyle) return visualStyle;

  const visualLines = plannerPrompt
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) =>
      /(visual|style|cinematic|photographic|atmospheric|lighting|mood|calm|documentary|realism)/i.test(line) &&
      !/(target|duration|seconds|words|split|chunk|scene boundary|verbatim coverage)/i.test(line)
    );
  return compact(visualLines.join(" ")).slice(0, 1000);
}

function finalizeFreshScenes(rawScenes: Scene[]): Scene[] {
  return normalizeFreshOpeningScenes(rawScenes)
    .map((s, i) => ({
      ...s,
      index: i,
      text: s.text.trim().replace(/\s+/g, " "),
      visual_prompt: s.visual_prompt.trim(),
      duration_hint_sec: estimateFreshOpeningSceneSeconds(wordCount(s.text)),
      source_kind: "fresh",
      continuity_break: i === 0 ? true : !!s.continuity_break,
      continuity_group_id: s.continuity_group_id ?? null,
      continuity_hint: s.continuity_hint ?? null,
    }));
}

function fallbackFreshOpeningScenes(freshText: string, visualStylePrompt: string | null): Scene[] {
  const targetWords = Math.max(12, Math.round(FRESH_OPENING_SCENE_TARGET_SECONDS * (WORDS_PER_MINUTE / 60)));
  const maxWords = Math.max(targetWords + 8, Math.round((FRESH_OPENING_SCENE_MAX_SECONDS + 4) * (WORDS_PER_MINUTE / 60)));
  const chunks = chunkTextByNarrationUnits(freshText, {
    targetWords,
    maxWords,
  });

  return normalizeFreshOpeningScenes(chunks.map((text, i) => ({
    index: i,
    text,
    visual_prompt: fallbackFreshOpeningVisualPrompt(text, visualStylePrompt),
    duration_hint_sec: estimateFreshOpeningSceneSeconds(wordCount(text)),
    source_kind: "fresh",
    continuity_break: i === 0,
  }))).map((s, i) => ({
    ...s,
    index: i,
    source_kind: "fresh",
    duration_hint_sec: estimateFreshOpeningSceneSeconds(wordCount(s.text)),
  }));
}

function fallbackFreshOpeningVisualPrompt(freshText: string, visualStylePrompt: string | null): string {
  const lower = freshText.toLowerCase();
  const style = compact(visualStylePrompt ?? "");
  const pirateAnchor = /pirate|frigate|sloop|privateer|corsair|jamaica|jamaican|caribbean|west africa|golden age|naval|warship|gun port|black flag/.test(lower)
    ? "Historical pirate-era maritime documentary shot anchored to the narration: 17th-18th century Caribbean, Atlantic, or West Africa waters as appropriate, period wooden sloops and frigates, rigging, gun ports, weathered sails, salt-stained decks, coastal harbors, open sea, and sailors in period clothing. If the text mentions the Jamaican coast, show a Caribbean pirate/naval coastline with ships or shipboard details, not a generic modern rocky shore."
    : "Cinematic documentary shot anchored tightly to the narration's subject, time period, setting, and physical details.";

  return [
    pirateAnchor,
    "Keep it specific to the narrated beat and avoid unrelated landscapes or modern objects.",
    style ? `Channel style: ${style}` : "",
    "No text, captions, logos, watermarks, or UI overlays.",
  ].filter(Boolean).join(" ");
}

function buildStockTailScenes(tailText: string, startIndex: number): Scene[] {
  if (!tailText.trim()) return [];
  const chunks = repairStockTailBoundaries(chunkTextByNarrationUnits(tailText, {
    targetWords: STOCK_TAIL_TARGET_WORDS,
    maxWords: STOCK_TAIL_MAX_WORDS,
  }));
  return chunks.map((text, i) => ({
    index: startIndex + i,
    text,
    visual_prompt: `Use channel stock B-roll that supports this narration beat: "${text.slice(0, 220)}"`,
    duration_hint_sec: estimateStockTailSeconds(wordCount(text)),
    source_kind: "stock",
    continuity_break: i === 0,
    continuity_group_id: null,
    continuity_hint: null,
  }));
}

function repairStockTailBoundaries(chunks: string[]): string[] {
  const out = chunks.map((chunk) => compact(chunk)).filter(Boolean);
  for (let i = 0; i < out.length - 1; i++) {
    if (!isUnsafeTailBoundary(out[i], out[i + 1])) continue;
    const repaired = repairTailBoundary(out[i], out[i + 1]);
    if (!repaired) continue;
    out[i] = repaired.left;
    out[i + 1] = repaired.right;
  }
  return out.filter(Boolean);
}

function repairTailBoundary(left: string, right: string): { left: string; right: string } | null {
  const rightWords = right.match(/\S+/g) ?? [];
  const leftWords = wordCount(left);
  for (let take = 1; take < rightWords.length; take++) {
    if (leftWords + take > STOCK_TAIL_MAX_WORDS) break;
    const candidateLeft = compact(`${left} ${rightWords.slice(0, take).join(" ")}`);
    const candidateRight = compact(rightWords.slice(take).join(" "));
    if (!candidateRight) break;
    if (!isUnsafeTailBoundary(candidateLeft, candidateRight)) {
      return { left: candidateLeft, right: candidateRight };
    }
  }
  return null;
}

function isUnsafeTailBoundary(left: string, right: string): boolean {
  return !endsWithSentenceStop(left) && startsWithLowercaseContinuation(right);
}

function endsWithSentenceStop(text: string): boolean {
  return /[.!?]["')\]}]*$/.test(text.trim());
}

function startsWithLowercaseContinuation(text: string): boolean {
  const first = text.trim().replace(/^["'([{]+/, "").match(/[A-Za-z]/)?.[0];
  return !!first && first.toLowerCase() === first;
}

function estimateStockTailSeconds(words: number): number {
  return Math.max(4, Math.ceil(words / (WORDS_PER_MINUTE / 60)));
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function compact(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/**
 * Sends one chunk of script to the configured LLM, parses the response, and
 * returns its scenes — re-indexed starting at `sceneIndexOffset` so they line
 * up inside the full-script scene array.
 *
 * `runId === null` skips the on-disk raw-output dump (used by preview).
 */
async function processChunk(
  provider: string,
  systemPrompt: string,
  scriptChunk: string,
  sceneIndexOffset: number,
  runId: string | null
): Promise<Scene[]> {
  let raw: string;
  if (provider === "google") {
    raw = await splitWithGemini(systemPrompt, scriptChunk);
  } else if (provider === "anthropic") {
    raw = await splitWithClaude(systemPrompt, scriptChunk);
  } else {
    throw new Error(`Unknown SCENE_SPLIT_PROVIDER: ${provider}`);
  }

  let json: unknown;
  try {
    json = extractJson(raw);
  } catch (e) {
    // Save raw output so we can see what went wrong — one file per chunk so
    // chunks don't overwrite each other's dumps.
    if (runId) {
      try {
        const runDir = getRunDir(runId);
        fs.mkdirSync(runDir, { recursive: true });
        const filename = `scene_split_raw_${sceneIndexOffset}.txt`;
        fs.writeFileSync(path.join(runDir, filename), raw, "utf-8");
        log(runId, "error", `Raw output saved to ${runDir}/${filename} (${raw.length} chars)`, {
          stage: "scene_split",
        });
      } catch {}
    }
    throw e;
  }
  if (!Array.isArray(json)) {
    if (runId) {
      log(runId, "error", "LLM did not return an array", {
        stage: "scene_split",
        data: { raw: raw.slice(0, 500) },
      });
    }
    throw new Error("scene_split: model did not return a JSON array");
  }

  return json.map((s, i) => {
    const groupId = typeof s.continuity_group_id === "string" && s.continuity_group_id.trim() ? s.continuity_group_id.trim() : null;
    const hint = typeof s.continuity_hint === "string" && s.continuity_hint.trim() ? s.continuity_hint.trim() : null;
    return {
      index: sceneIndexOffset + i,
      text: String(s.text ?? ""),
      visual_prompt: String(s.visual_prompt ?? ""),
      duration_hint_sec: Number(s.duration_hint_sec ?? 6),
      continuity_group_id: groupId,
      continuity_break: s.continuity_break === true,
      continuity_hint: hint,
    } as Scene;
  });
}

async function splitWithGemini(
  systemPrompt: string,
  script: string,
  opts?: { thinkingBudget?: number; responseSchema?: Record<string, unknown> }
): Promise<string> {
  const apiKey = getSetting("GOOGLE_API_KEY");
  if (!apiKey) throw new Error("GOOGLE_API_KEY is not set (Settings)");
  const model = getSetting("SCENE_SPLIT_MODEL") || "gemini-flash-latest";

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const generationConfig: Record<string, unknown> = {
    temperature: 0.7,
    maxOutputTokens: 65535,
    // Disable thinking for structured JSON; it just spends the output budget.
    thinkingConfig: { thinkingBudget: opts?.thinkingBudget ?? 0 },
  };
  if (opts?.responseSchema) {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseSchema = opts.responseSchema;
  } else {
    generationConfig.responseMimeType = "application/json";
  }

  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: `Script:\n\n${script}` }] }],
    // 65535 — Gemini 2.5 Flash/Pro hard max for output. Per-chunk we target
    // ~3 000 words of input → ~54 K of output, leaving an 11 K-token buffer
    // before the hard cap. Anything that still overflows surfaces below
    // with a clear "lower WORDS_PER_CHUNK" message.
    generationConfig,
  });

  // Retry with exponential backoff for transient errors
  // (503 UNAVAILABLE / 429 RATE_LIMIT / 500 — common Google API blips)
  const RETRYABLE = new Set([429, 500, 502, 503, 504]);
  const MAX_RETRIES = 4;
  let attempt = 0;
  let lastErr = "";

  while (attempt <= MAX_RETRIES) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      if (resp.ok) {
        const json = (await resp.json()) as {
          candidates?: {
            content?: { parts?: { text?: string }[] };
            finishReason?: string;
          }[];
          usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
        };
        const cand = json.candidates?.[0];
        const text = cand?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
        const reason = cand?.finishReason;
        if (reason && reason !== "STOP") {
          throw new Error(
            `Gemini finish=${reason} (output cut off, tokens=${json.usageMetadata?.candidatesTokenCount}). ` +
              `Even a single ~3 000-word chunk produced more than Gemini's 65 535-token output cap — ` +
              `lower WORDS_PER_CHUNK in scene-split.ts, or shorten this chunk's visual_prompt instructions.`
          );
        }
        if (!text) throw new Error(`Gemini: empty output (${JSON.stringify(json).slice(0, 300)})`);
        return text;
      }
      const errText = (await resp.text()).slice(0, 400);
      lastErr = `Gemini ${resp.status}: ${errText}`;
      if (!RETRYABLE.has(resp.status) || attempt === MAX_RETRIES) {
        throw new Error(lastErr);
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("Gemini finish=")) throw e;
      if (e instanceof Error && e.message.startsWith("Gemini: empty")) throw e;
      if (e instanceof Error && e.message.match(/^Gemini [45]\d{2}:/)) throw e;
      lastErr = e instanceof Error ? e.message : String(e);
      if (attempt === MAX_RETRIES) {
        throw new Error(
          `Gemini request failed after ${MAX_RETRIES + 1} attempts (${lastErr}). Check your network and GOOGLE_API_KEY, then start a new run.`
        );
      }
    }
    // 1s, 2s, 4s, 8s — transient network blips + 429/503
    const waitMs = 1000 * Math.pow(2, attempt);
    await new Promise((r) => setTimeout(r, waitMs));
    attempt++;
  }
  throw new Error(lastErr);
}

async function splitWithClaude(systemPrompt: string, script: string): Promise<string> {
  const apiKey = getSetting("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set (Settings)");
  const model = getSetting("SCENE_SPLIT_MODEL") || "claude-sonnet-4-6";
  const client = new Anthropic({ apiKey });
  const resp = await client.messages.create({
    model,
    max_tokens: 8000,
    system: systemPrompt,
    messages: [{ role: "user", content: `Script:\n\n${script}` }],
  });
  return resp.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("\n");
}

/** Extracts the first JSON array from a text response, even if the model added markdown. */
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\[[\s\S]*\]/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {}
    }
    throw new Error("Could not parse JSON from model response");
  }
}
