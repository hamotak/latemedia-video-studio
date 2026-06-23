const MIN_REASONABLE_WORDS = 6;
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

export interface ScenePlanHealth {
  ok: boolean;
  issue: string | null;
  sceneCount: number;
  avgWords: number;
  shortScenes: number;
  danglingScenes: number;
}

export function analyzeScenePlan(scenes: { text?: unknown }[]): ScenePlanHealth {
  const texts = scenes.map((s) => String(s.text ?? "").trim()).filter(Boolean);
  if (texts.length === 0) {
    return {
      ok: false,
      issue: "No scene text found.",
      sceneCount: 0,
      avgWords: 0,
      shortScenes: 0,
      danglingScenes: 0,
    };
  }

  const wordCounts = texts.map(wordCount);
  const shortScenes = wordCounts.filter((n) => n < MIN_REASONABLE_WORDS).length;
  const danglingIndexes = new Set<number>();
  texts.forEach((text, i) => {
    if (endsOnDanglingWord(text)) danglingIndexes.add(i);
    if (i < texts.length - 1 && endsMidSentenceBeforeContinuation(text, texts[i + 1])) danglingIndexes.add(i);
  });
  const danglingScenes = danglingIndexes.size;
  const avgWords = wordCounts.reduce((sum, n) => sum + n, 0) / wordCounts.length;
  const shortRatio = shortScenes / texts.length;

  const bad =
    danglingScenes > 0 ||
    (texts.length >= 4 &&
      (avgWords < 6 || shortRatio >= 0.65 || danglingScenes >= Math.max(2, Math.ceil(texts.length * 0.08))));

  return {
    ok: !bad,
    issue: bad
      ? `Old unsafe scene plan detected: ${shortScenes}/${texts.length} beats are too short, ${danglingScenes} end mid-thought.`
      : null,
    sceneCount: texts.length,
    avgWords,
    shortScenes,
    danglingScenes,
  };
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function endsOnDanglingWord(text: string): boolean {
  const clean = text.trim();
  if (endsWithSentenceStop(clean)) return false;
  const last = text
    .trim()
    .split(/\s+/)
    .at(-1)
    ?.toLowerCase()
    .replace(/[^a-z]+$/i, "");
  return !!last && DANGLING_END_WORDS.has(last);
}

function endsMidSentenceBeforeContinuation(text: string, next: string): boolean {
  return wordCount(text) < MIN_REASONABLE_WORDS && !endsWithSentenceStop(text) && startsWithLowercaseContinuation(next);
}

function endsWithSentenceStop(text: string): boolean {
  return /[.!?]["')\]}]*$/.test(text.trim());
}

function startsWithLowercaseContinuation(text: string): boolean {
  const first = text.trim().replace(/^["'([{]+/, "").match(/[A-Za-z]/)?.[0];
  return !!first && first.toLowerCase() === first;
}
