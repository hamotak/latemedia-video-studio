import { WORDS_PER_MINUTE } from "./script-estimate";
import { splitIntoNarrationUnits } from "./text-chunking";

export function splitScriptAtNarrationDuration(script: string, freshSeconds: number): { freshText: string; tailText: string } {
  const clean = compact(script);
  if (!clean) return { freshText: "", tailText: "" };
  if (!Number.isFinite(freshSeconds) || freshSeconds <= 0) return { freshText: "", tailText: clean };

  const targetWords = Math.max(1, Math.round((freshSeconds / 60) * WORDS_PER_MINUTE));
  const minCompleteFreshWords = Math.max(1, Math.floor(targetWords * 0.72));
  const maxCompleteFreshWords = Math.max(targetWords + 1, Math.ceil(targetWords * 1.25));
  const totalWords = wordCount(clean);
  if (totalWords <= targetWords) return { freshText: clean, tailText: "" };

  const paragraphCut = splitAtParagraphBoundary(script, minCompleteFreshWords, targetWords);
  if (paragraphCut) return paragraphCut;

  const units = splitIntoNarrationUnits(clean);
  const freshParts: string[] = [];
  const tailParts: string[] = [];
  let acc = 0;
  let cut = false;

  for (const unit of units.length ? units : [clean]) {
    if (cut) {
      tailParts.push(unit);
      continue;
    }

    const unitWords = wordCount(unit);
    if (acc + unitWords <= targetWords) {
      freshParts.push(unit);
      acc += unitWords;
      continue;
    }

    // Prefer a complete sentence seam around the Fresh/stock handoff. The
    // exact minute mark is less important than avoiding a torn phrase like
    // "Jamaican / coast" or a tail that starts mid-sentence.
    if (acc > 0 && acc >= minCompleteFreshWords) {
      tailParts.push(unit);
      cut = true;
      continue;
    }
    if (acc + unitWords <= maxCompleteFreshWords) {
      freshParts.push(unit);
      acc += unitWords;
      cut = true;
      continue;
    }

    const remaining = targetWords - acc;
    const [head, tail] = splitTextByWordsAtNaturalCut(unit, remaining);
    if (head) freshParts.push(head);
    if (tail) tailParts.push(tail);
    cut = true;
  }

  return { freshText: compact(freshParts.join(" ")), tailText: compact(tailParts.join(" ")) };
}

function splitAtParagraphBoundary(
  script: string,
  minFreshWords: number,
  targetWords: number
): { freshText: string; tailText: string } | null {
  const paragraphs = script
    .split(/\n\s*\n+/)
    .map(compact)
    .filter(Boolean);
  if (paragraphs.length < 2) return null;

  const freshParts: string[] = [];
  let acc = 0;
  for (let i = 0; i < paragraphs.length - 1; i++) {
    const nextWords = wordCount(paragraphs[i]);
    if (freshParts.length > 0 && acc + nextWords > targetWords) break;
    freshParts.push(paragraphs[i]);
    acc += nextWords;
    if (acc >= minFreshWords && acc <= targetWords) {
      return {
        freshText: compact(freshParts.join(" ")),
        tailText: compact(paragraphs.slice(i + 1).join(" ")),
      };
    }
  }
  return null;
}

function splitTextByWordsAtNaturalCut(text: string, targetWords: number): [string, string] {
  const words = text.match(/\S+/g) ?? [];
  if (words.length === 0) return ["", ""];
  if (targetWords <= 0) return ["", text.trim()];
  if (words.length <= targetWords) return [text.trim(), ""];
  const cut = findNaturalWordCut(words, targetWords);
  return [words.slice(0, cut).join(" "), words.slice(cut).join(" ")];
}

function findNaturalWordCut(words: string[], targetWords: number): number {
  const target = Math.max(1, Math.min(words.length - 1, targetWords));
  const min = Math.max(1, Math.floor(target * 0.65));
  const max = Math.min(words.length - 1, Math.ceil(target * 1.2));

  for (let i = target; i >= min; i--) {
    if (/[.!?;:,\u2014-]$/.test(words[i - 1] ?? "")) return i;
  }
  for (let i = target; i <= max; i++) {
    if (/[.!?;:,\u2014-]$/.test(words[i - 1] ?? "")) return i;
  }
  for (let i = target; i >= min; i--) {
    const next = (words[i] ?? "").toLowerCase().replace(/[^a-z]+/gi, "");
    if (new Set(["and", "but", "while", "because", "as", "with"]).has(next)) return i;
  }
  return target;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function compact(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}
