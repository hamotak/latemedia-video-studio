import { chunkTextByNarrationUnits } from "./text-chunking";

export interface SceneChunkInput {
  index: number;
  text: string;
  visual_prompt: string;
  duration_hint_sec: number;
  continuity_group_id?: string | null;
  continuity_break?: boolean;
  continuity_hint?: string | null;
}

export const GENERATED_SCENE_MAX_SECONDS = 8;
export const GENERATED_SCENE_TARGET_SECONDS = 7;
export const GENERATED_SCENE_WORDS_PER_SECOND = 2.5; // 150 wpm narration pace
export const FRESH_OPENING_SCENE_MAX_SECONDS = 7;
export const FRESH_OPENING_SCENE_TARGET_SECONDS = 6;
export const IMAGE_CUT_SCENE_MAX_SECONDS = 8;
export const IMAGE_CUT_SCENE_TARGET_SECONDS = 7;
const WORDS_PER_SECOND = GENERATED_SCENE_WORDS_PER_SECOND;
const NARRATION_TARGET_WORDS = Math.floor(GENERATED_SCENE_TARGET_SECONDS * WORDS_PER_SECOND);
const MIN_NARRATION_WORDS = 7;
const MAX_NARRATION_WORDS = Math.floor(GENERATED_SCENE_MAX_SECONDS * WORDS_PER_SECOND);
const FRESH_OPENING_TARGET_WORDS = Math.floor(FRESH_OPENING_SCENE_TARGET_SECONDS * WORDS_PER_SECOND);
const FRESH_OPENING_MAX_WORDS = Math.floor(FRESH_OPENING_SCENE_MAX_SECONDS * WORDS_PER_SECOND);
const NATURAL_BOUNDARY_WORD_MARGIN = 4;
const NATURAL_BOUNDARY_SECONDS_MARGIN = 2;
const IMAGE_CUT_TARGET_WORDS = Math.floor(IMAGE_CUT_SCENE_TARGET_SECONDS * WORDS_PER_SECOND);
const IMAGE_CUT_MAX_WORDS = Math.floor(IMAGE_CUT_SCENE_MAX_SECONDS * WORDS_PER_SECOND);
const DANGLING_END_WORDS = new Set([
  "a",
  "an",
  "after",
  "although",
  "and",
  "as",
  "at",
  "before",
  "because",
  "but",
  "by",
  "during",
  "even",
  "for",
  "from",
  "against",
  "across",
  "if",
  "in",
  "into",
  "of",
  "on",
  "or",
  "since",
  "so",
  "that",
  "these",
  "this",
  "the",
  "them",
  "those",
  "their",
  "though",
  "to",
  "unless",
  "until",
  "when",
  "where",
  "while",
  "who",
  "whose",
  "which",
  "with",
  "without",
]);
const AWKWARD_START_WORDS = new Set(
  [...DANGLING_END_WORDS].filter((word) => !["a", "an", "the", "their"].includes(word))
);
const SAFE_SENTENCE_END_WORDS = new Set(["in", "them", "this", "to"]);
const PROTECTED_BOUNDARY_BIGRAMS = new Set([
  "crowded harbour",
  "golden age",
  "gun ports",
  "jamaican coast",
  "merchant sloop",
  "north atlantic",
  "particular ship",
  "rows of",
  "single note",
  "still stands",
  "trial records",
  "three rows",
  "west africa",
]);

export interface FreshChunkValidation {
  ok: boolean;
  errors: string[];
}

export function normalizeNarrationScenes<T extends SceneChunkInput>(rawScenes: T[]): T[] {
  return normalizeNarrationScenesWithLimits(rawScenes, {
    targetWords: NARRATION_TARGET_WORDS,
    maxWords: MAX_NARRATION_WORDS,
    maxSeconds: GENERATED_SCENE_MAX_SECONDS,
  });
}

export function normalizeFreshOpeningScenes<T extends SceneChunkInput>(rawScenes: T[]): T[] {
  return normalizeNarrationScenesWithLimits(rawScenes, {
    targetWords: FRESH_OPENING_TARGET_WORDS,
    maxWords: FRESH_OPENING_MAX_WORDS,
    maxSeconds: FRESH_OPENING_SCENE_MAX_SECONDS,
  });
}

export function normalizeImageCutFreshScenes<T extends SceneChunkInput>(rawScenes: T[]): T[] {
  return normalizeNarrationScenesWithLimits(rawScenes, {
    targetWords: IMAGE_CUT_TARGET_WORDS,
    maxWords: IMAGE_CUT_MAX_WORDS,
    maxSeconds: IMAGE_CUT_SCENE_MAX_SECONDS,
  });
}

function normalizeNarrationScenesWithLimits<T extends SceneChunkInput>(
  rawScenes: T[],
  limits: { targetWords: number; maxWords: number; maxSeconds: number }
): T[] {
  const source = rawScenes.filter((s) => s.text.trim().length > 0);
  if (source.length === 0) return [];

  if (looksLikeSafeGeneratedPlan(source, limits.maxWords)) {
    return source.map((s, i) => ({
      ...s,
      index: i,
      duration_hint_sec: estimateSceneSeconds(wordCount(s.text), limits.maxSeconds),
      visual_prompt: visualPromptForChunk(s.text, s.visual_prompt),
      continuity_break: i === 0 ? true : !!s.continuity_break,
      continuity_group_id: s.continuity_group_id ?? null,
      continuity_hint: s.continuity_hint ?? null,
    }) as T);
  }

  const fullText = repairFalseSentenceBreaks(
    source.map((s) => s.text.trim()).join(" ").replace(/\s+/g, " ").trim()
  );
  const chunks = balanceShortNarrationChunks(
    repairChunkBoundaries(
      balanceShortNarrationChunks(
        chunkTextByNarrationUnits(fullText, {
          targetWords: limits.targetWords,
          maxWords: limits.maxWords,
        }),
        limits.maxWords,
        limits.maxSeconds
      ).map(repairFalseSentenceBreaks),
      limits.maxWords
    ),
    limits.maxWords,
    limits.maxSeconds
  );

  const out: T[] = [];
  let sourceIndex = 0;
  let wordsConsumedInSource = 0;

  for (const chunk of chunks) {
    const words = wordCount(chunk);
    const startSource = source[sourceIndex] ?? source[source.length - 1];
    const covered = collectCoveredSources(source, sourceIndex, wordsConsumedInSource, words);
    const promptSource = covered.find((s) => s.visual_prompt?.trim()) ?? startSource;

    out.push({
      ...startSource,
      index: out.length,
      text: chunk,
      visual_prompt: visualPromptForChunk(chunk, promptSource.visual_prompt),
      duration_hint_sec: estimateSceneSeconds(words, limits.maxSeconds),
      continuity_group_id: startSource.continuity_group_id ?? null,
      continuity_break: out.length === 0 ? true : !!startSource.continuity_break,
      continuity_hint: startSource.continuity_hint ?? null,
    } as T);

    let remaining = words;
    while (remaining > 0 && sourceIndex < source.length) {
      const sourceWords = wordCount(source[sourceIndex].text);
      const available = sourceWords - wordsConsumedInSource;
      if (remaining < available) {
        wordsConsumedInSource += remaining;
        remaining = 0;
      } else {
        remaining -= available;
        sourceIndex++;
        wordsConsumedInSource = 0;
      }
    }
  }

  return out;
}

function balanceShortNarrationChunks(chunks: string[], maxWords: number, maxSeconds: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const current = chunks[i].trim();
    const words = wordCount(current);
    const interrupted = looksInterrupted(current);

    if ((words < MIN_NARRATION_WORDS || interrupted) && i + 1 < chunks.length) {
      const next = chunks[i + 1].trim();
      if (
        wordCount(`${current} ${next}`) <= maxWords + NATURAL_BOUNDARY_WORD_MARGIN &&
        !wouldExceedLimit(current, next, maxSeconds + NATURAL_BOUNDARY_SECONDS_MARGIN)
      ) {
        out.push(joinNarrationParts(current, next));
        i++;
        continue;
      }
    }

    if ((words < MIN_NARRATION_WORDS || interrupted) && out.length > 0) {
      const prev = out[out.length - 1];
      if (
        wordCount(`${prev} ${current}`) <= maxWords + NATURAL_BOUNDARY_WORD_MARGIN &&
        !wouldExceedLimit(prev, current, maxSeconds + NATURAL_BOUNDARY_SECONDS_MARGIN)
      ) {
        out[out.length - 1] = joinNarrationParts(prev, current);
        continue;
      }
    }

    out.push(current);
  }
  return out;
}

function repairChunkBoundaries(chunks: string[], maxWords: number): string[] {
  const out = chunks.map((chunk) => chunk.trim()).filter(Boolean);
  for (let i = 0; i < out.length - 1; i++) {
    const unsafeStart =
      isUnsafeMidPhraseBoundary(out[i], out[i + 1]) ||
      (!endsWithSentenceStop(out[i]) && !isSafeCommaBoundary(out[i], out[i + 1]) && startsAwkwardly(out[i + 1]));
    if (!looksInterrupted(out[i]) && !unsafeStart) continue;
    const repaired = findBoundaryRepair(out[i], out[i + 1], maxWords);
    if (!repaired) {
      const merged = `${out[i]} ${out[i + 1]}`.trim();
      if (wordCount(merged) <= maxWords + 4) {
        out.splice(i, 2, merged);
        i = Math.max(-1, i - 2);
      }
      continue;
    }
    out[i] = repaired.left;
    out[i + 1] = repaired.right;
  }
  return out.filter(Boolean);
}

function findBoundaryRepair(left: string, right: string, maxWords: number): { left: string; right: string } | null {
  const rightWords = splitWords(right);
  const leftWords = wordCount(left);
  const repairMaxWords = maxWords + NATURAL_BOUNDARY_WORD_MARGIN;
  for (let take = 1; take < rightWords.length; take++) {
    if (leftWords + take > repairMaxWords) break;
    const candidateLeft = `${left} ${rightWords.slice(0, take).join(" ")}`.trim();
    const candidateRight = rightWords.slice(take).join(" ").trim();
    if (!candidateRight) break;
    const awkwardContinuation =
      !endsWithSentenceStop(candidateLeft) &&
      !isSafeCommaBoundary(candidateLeft, candidateRight) &&
      startsAwkwardly(candidateRight);
    if (!looksInterrupted(candidateLeft) && !awkwardContinuation && !isUnsafeMidPhraseBoundary(candidateLeft, candidateRight)) {
      return { left: candidateLeft, right: candidateRight };
    }
  }
  return null;
}

function joinNarrationParts(left: string, right: string): string {
  const cleanLeft = left.trim();
  const cleanRight = right.trim();
  if (!cleanLeft) return cleanRight;
  if (!cleanRight) return cleanLeft;
  if (!looksInterrupted(cleanLeft)) return `${cleanLeft} ${cleanRight}`.trim();
  return `${cleanLeft.replace(/[.!?,;:—-]+$/g, "").trim()} ${cleanRight}`.trim();
}

function splitWords(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

function repairFalseSentenceBreaks(text: string): string {
  return text.replace(
    /\b(a|an|after|although|and|as|at|before|because|but|by|during|even|for|from|if|in|into|of|on|or|since|so|that|the|them|these|this|those|though|to|unless|until|when|where|while|who|whose|which|with|without)[.!?]\s+([A-Za-z])/gi,
    (match, word: string, next: string) => {
      if (next !== next.toLowerCase()) return match;
      return `${word} ${next}`;
    }
  );
}

function looksInterrupted(text: string): boolean {
  const clean = text.trim();
  if (!clean) return false;
  const lastWord = clean
    .split(/\s+/)
    .at(-1)
    ?.toLowerCase()
    .replace(/[^a-z]+$/i, "");
  if (endsWithSentenceStop(clean)) {
    return !!lastWord && DANGLING_END_WORDS.has(lastWord) && !SAFE_SENTENCE_END_WORDS.has(lastWord);
  }
  if (lastWord && DANGLING_END_WORDS.has(lastWord)) return true;
  return /[;:—-]$/.test(clean);
}

function startsAwkwardly(text: string): boolean {
  const firstWord = text
    .trim()
    .split(/\s+/)
    .at(0)
    ?.toLowerCase()
    .replace(/^[^a-z]+|[^a-z]+$/gi, "");
  return !!firstWord && AWKWARD_START_WORDS.has(firstWord);
}

function startsWithLowercaseContinuation(text: string): boolean {
  const first = text.trim().replace(/^["'([{]+/, "").match(/[A-Za-z]/)?.[0];
  return !!first && first.toLowerCase() === first;
}

function endsWithSentenceStop(text: string): boolean {
  return /[.!?]["')\]}]*$/.test(text.trim());
}

function wouldExceedLimit(left: string, right: string, maxSeconds: number): boolean {
  return Math.ceil(wordCount(`${left} ${right}`) / WORDS_PER_SECOND) > maxSeconds;
}

function collectCoveredSources<T extends SceneChunkInput>(
  scenes: T[],
  startIndex: number,
  startOffsetWords: number,
  takeWords: number
): T[] {
  const covered: T[] = [];
  let i = startIndex;
  let offset = startOffsetWords;
  let remaining = takeWords;
  while (remaining > 0 && i < scenes.length) {
    covered.push(scenes[i]);
    const available = wordCount(scenes[i].text) - offset;
    remaining -= Math.max(0, available);
    i++;
    offset = 0;
  }
  return covered;
}

function visualPromptForChunk(text: string, sourcePrompt: string): string {
  const cleanText = text.replace(/\s+/g, " ").trim();
  const cleanPrompt = sourcePrompt.replace(/\s+/g, " ").trim();
  return [
    `Narration beat that must be visibly matched first: "${cleanText}".`,
    "Create one polished documentary shot for this exact beat before applying the channel style.",
    cleanPrompt,
    "Keep the frame clean: no text, no captions, no logos, no watermarks, no UI overlays.",
  ]
    .filter(Boolean)
    .join(" ");
}

export function estimateGeneratedSceneSeconds(words: number): number {
  return estimateSceneSeconds(words, GENERATED_SCENE_MAX_SECONDS);
}

export function estimateFreshOpeningSceneSeconds(words: number): number {
  return estimateSceneSeconds(words, FRESH_OPENING_SCENE_MAX_SECONDS);
}

export function estimateImageCutSceneSeconds(words: number): number {
  return estimateSceneSeconds(words, IMAGE_CUT_SCENE_MAX_SECONDS);
}

function estimateSceneSeconds(words: number, maxSeconds: number): number {
  return Math.min(maxSeconds, Math.max(3, Math.ceil(words / WORDS_PER_SECOND)));
}

export function validateFreshOpeningScenes(
  scenes: { text?: unknown; duration_hint_sec?: unknown }[],
  sourceText: string
): FreshChunkValidation {
  const errors: string[] = [];
  const texts = scenes.map((s) => String(s.text ?? "").trim()).filter(Boolean);
  const expected = compact(sourceText);
  const actual = compact(texts.join(" "));

  if (!expected) errors.push("Fresh opening text is empty.");
  if (texts.length === 0) errors.push("No Fresh AI chunks were returned.");
  if (expected && actual !== expected) errors.push("Chunk text must preserve the Fresh AI opening exactly, in order.");

  texts.forEach((text, i) => {
    const words = wordCount(text);
    const estimate = estimateFreshOpeningSceneSeconds(words);
    const modelHint = Number(scenes[i]?.duration_hint_sec);
    if (
      words > FRESH_OPENING_MAX_WORDS + NATURAL_BOUNDARY_WORD_MARGIN ||
      estimate > FRESH_OPENING_SCENE_MAX_SECONDS ||
      (Number.isFinite(modelHint) && modelHint > FRESH_OPENING_SCENE_MAX_SECONDS)
    ) {
      errors.push(`Chunk ${i + 1} is longer than ${FRESH_OPENING_SCENE_MAX_SECONDS}s safe fresh-video narration budget.`);
    }
    if (looksInterrupted(text)) errors.push(`Chunk ${i + 1} ends mid-thought.`);
    if (i > 0 && !endsWithSentenceStop(texts[i - 1]) && !isSafeCommaBoundary(texts[i - 1], text) && startsAwkwardly(text)) {
      errors.push(`Chunk ${i + 1} starts mid-thought.`);
    }
    if (i < texts.length - 1 && isUnsafeMidPhraseBoundary(text, texts[i + 1])) {
      errors.push(`Chunk ${i + 1} ends mid-phrase before chunk ${i + 2}.`);
    }
    if (texts.length > 1 && words < 4) errors.push(`Chunk ${i + 1} is too short to stand alone.`);
    if (i < texts.length - 1 && words < MIN_NARRATION_WORDS) errors.push(`Chunk ${i + 1} is too short to stand alone.`);
  });

  return { ok: errors.length === 0, errors };
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function compact(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function looksLikeSafeGeneratedPlan(scenes: SceneChunkInput[], maxWords: number): boolean {
  if (scenes.length === 0) return false;
  return scenes.every((s, i) => {
    const text = s.text.trim();
    if (!text) return false;
    if (scenes.length > 1 && wordCount(text) < 4) return false;
    if (wordCount(text) > maxWords + NATURAL_BOUNDARY_WORD_MARGIN) return false;
    if (looksInterrupted(text)) return false;
    if (
      i > 0 &&
      !endsWithSentenceStop(scenes[i - 1].text) &&
      !isSafeCommaBoundary(scenes[i - 1].text, text) &&
      startsAwkwardly(text)
    ) return false;
    if (i > 0 && isUnsafeMidPhraseBoundary(scenes[i - 1].text, text)) return false;
    return true;
  });
}

function isUnsafeMidPhraseBoundary(left: string, right: string): boolean {
  if (isSafeCommaBoundary(left, right)) return false;
  if (splitsProtectedBoundary(left, right)) return true;
  return !endsWithSentenceStop(left) && startsWithLowercaseContinuation(right);
}

function isSafeCommaBoundary(left: string, right: string): boolean {
  if (!/,\s*$/.test(left.trim())) return false;
  const first = firstCleanWord(right);
  const second = secondCleanWord(right);
  if (!first) return false;
  if (first === "and" && second && !AWKWARD_START_WORDS.has(second)) return true;
  return [
    "a",
    "an",
    "but",
    "built",
    "cut",
    "drawn",
    "made",
    "something",
    "some",
    "taken",
    "the",
    "then",
    "while",
    "whereas",
  ].includes(first);
}

function splitsProtectedBoundary(left: string, right: string): boolean {
  const last = lastCleanWord(left);
  const first = firstCleanWord(right);
  return !!last && !!first && PROTECTED_BOUNDARY_BIGRAMS.has(`${last} ${first}`);
}

function lastCleanWord(text: string): string {
  return (
    text
      .trim()
      .split(/\s+/)
      .at(-1)
      ?.toLowerCase()
      .replace(/^[^a-z]+|[^a-z]+$/gi, "") ?? ""
  );
}

function firstCleanWord(text: string): string {
  return (
    text
      .trim()
      .split(/\s+/)
      .at(0)
      ?.toLowerCase()
      .replace(/^[^a-z]+|[^a-z]+$/gi, "") ?? ""
  );
}

function secondCleanWord(text: string): string {
  return (
    text
      .trim()
      .split(/\s+/)
      .at(1)
      ?.toLowerCase()
      .replace(/^[^a-z]+|[^a-z]+$/gi, "") ?? ""
  );
}
