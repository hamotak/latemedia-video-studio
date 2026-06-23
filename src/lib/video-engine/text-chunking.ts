export interface ChunkTextOptions {
  /** Preferred maximum words per chunk when combining complete narration units. */
  targetWords?: number;
  /** Hard word limit for splitting one oversized narration unit. */
  maxWords?: number;
  /** Hard-ish provider limit in characters. Used by long-form TTS. */
  maxChars?: number;
}

const ABBREVIATIONS = new Set([
  "mr.",
  "mrs.",
  "ms.",
  "dr.",
  "prof.",
  "sr.",
  "jr.",
  "st.",
  "capt.",
  "col.",
  "gen.",
  "lt.",
  "sgt.",
  "adm.",
  "rev.",
  "hon.",
  "pres.",
  "gov.",
  "sen.",
  "rep.",
  "vs.",
  "etc.",
  "fig.",
  "dept.",
  "inc.",
  "ltd.",
  "co.",
  "corp.",
  "mt.",
  "no.",
  "a.m.",
  "p.m.",
  "u.s.",
  "u.k.",
  "u.n.",
  "e.g.",
  "i.e.",
]);

const CLOSERS = new Set(['"', "'", ")", "]", "}"]);
const CLAUSE_BOUNDARY = /[;:,\u2014-]/;
const WORD = /\S+/g;
const DANGLING_END_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "after",
  "although",
  "before",
  "because",
  "but",
  "by",
  "during",
  "even",
  "for",
  "from",
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
const PROTECTED_BIGRAMS = new Set([
  "big bang",
  "crowded harbour",
  "converted merchant",
  "golden age",
  "gun ports",
  "jamaican coast",
  "merchant sloop",
  "north atlantic",
  "rows of",
  "single note",
  "somewhere off",
  "still stands",
  "tall masts",
  "three rows",
  "trial records",
  "west africa",
]);
const CONJUNCTION_START_WORDS = new Set(["and", "but", "while", "because", "as"]);

export function splitIntoNarrationUnits(text: string): string[] {
  const input = text.trim();
  if (!input) return [];

  const units: string[] = [];
  let start = 0;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch !== "." && ch !== "!" && ch !== "?") continue;
    if (ch === "." && isProtectedPeriod(input, i)) continue;

    let end = i + 1;
    while (end < input.length && (input[end] === "." || input[end] === "!" || input[end] === "?")) end++;
    while (end < input.length && CLOSERS.has(input[end])) end++;

    const unit = input.slice(start, end).trim();
    if (unit) units.push(unit);
    start = end;
    while (start < input.length && /\s/.test(input[start])) start++;
    i = start - 1;
  }

  const leftover = input.slice(start).trim();
  if (leftover) units.push(leftover);

  if (units.length > 0) return units;
  return input
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
}

export function chunkTextByNarrationUnits(text: string, options: ChunkTextOptions): string[] {
  const clean = normalizeSpace(text);
  if (!clean) return [];

  const units = splitIntoNarrationUnits(clean).flatMap((unit) => splitOversizeUnit(unit, options));
  const chunks: string[] = [];
  let current = "";

  for (const unit of units) {
    const next = current ? `${current} ${unit}` : unit;
    if (current && exceeds(next, options)) {
      chunks.push(current);
      current = unit;
    } else {
      current = next;
    }
  }

  if (current) chunks.push(current);
  return chunks.length > 0 ? chunks : [clean];
}

export function countTextChunks(text: string, options: ChunkTextOptions): number {
  return chunkTextByNarrationUnits(text, options).length;
}

function isProtectedPeriod(input: string, index: number): boolean {
  const prev = input[index - 1] ?? "";
  const next = input[index + 1] ?? "";
  if (/\d/.test(prev) && /\d/.test(next)) return true;
  if (/^[A-Za-z]\./.test(input.slice(index + 1))) return true;

  const token = tokenEndingAt(input, index).toLowerCase();
  if (!token) return false;
  const nextNonSpace = input.slice(index + 1).match(/\S/)?.[0] ?? "";
  if ((token === "a.m." || token === "p.m.") && /[A-Z]/.test(nextNonSpace)) return false;
  if (ABBREVIATIONS.has(token)) return true;
  if (/^(?:[a-z]\.){2,}$/i.test(token)) return true;

  if (/^[A-Z]\.$/.test(tokenEndingAt(input, index)) && /[A-Z]/.test(nextNonSpace)) return true;

  return false;
}

function tokenEndingAt(input: string, index: number): string {
  let start = index;
  while (start > 0 && /[A-Za-z.]/.test(input[start - 1])) start--;
  return input.slice(start, index + 1).replace(/^["'([{]+|["')\]}]+$/g, "");
}

function splitOversizeUnit(unit: string, options: ChunkTextOptions): string[] {
  let pieces = [unit];
  if (options.maxChars && options.maxChars > 0) {
    pieces = pieces.flatMap((piece) => splitLongByChars(piece, options.maxChars!));
  }
  if (options.targetWords && options.targetWords > 0) {
    const hardWordLimit = options.maxWords && options.maxWords > 0 ? options.maxWords : options.targetWords;
    pieces = pieces.flatMap((piece) => splitLongByWords(piece, hardWordLimit!));
  }
  return pieces;
}

function splitLongByChars(text: string, maxChars: number): string[] {
  const pieces: string[] = [];
  let rest = text.trim();

  while (rest.length > maxChars) {
    const cut = findCharCut(rest, maxChars);
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }

  if (rest) pieces.push(rest);
  return pieces;
}

function findCharCut(text: string, maxChars: number): number {
  const min = Math.max(1, Math.floor(maxChars * 0.55));
  for (let i = maxChars; i >= min; i--) {
    if (CLAUSE_BOUNDARY.test(text[i - 1] ?? "") && /\s/.test(text[i] ?? " ")) return i;
  }
  for (let i = maxChars; i >= min; i--) {
    if (/\s/.test(text[i] ?? "")) return i;
  }
  return maxChars;
}

function splitLongByWords(text: string, maxWords: number): string[] {
  const words = text.match(WORD) ?? [];
  if (words.length <= maxWords) return [text.trim()];

  const pieces: string[] = [];
  let start = 0;
  while (start < words.length) {
    let end = Math.min(words.length, start + maxWords);
    if (end < words.length) {
      const preferred = findWordCut(words, start, end);
      if (preferred > start) end = preferred;
    }
    pieces.push(words.slice(start, end).join(" "));
    start = end;
  }
  return pieces;
}

function findWordCut(words: string[], start: number, maxEnd: number): number {
  const span = maxEnd - start;
  const min = Math.max(start + 1, start + Math.floor(span * 0.55));
  const clauseMin = Math.max(start + 1, start + Math.floor(span * 0.3));
  for (let i = maxEnd; i >= clauseMin; i--) {
    if (CLAUSE_BOUNDARY.test(words[i - 1] ?? "") && !isBadCut(words, i)) return i;
  }
  for (let i = maxEnd; i >= min; i--) {
    if (isConjunctionClauseCut(words, i)) return i;
  }
  for (let i = maxEnd; i >= min; i--) {
    if (!isBadCut(words, i)) return i;
  }
  return maxEnd;
}

function isBadCut(words: string[], end: number): boolean {
  return isDanglingCut(words, end) || startsBadlyAfterCut(words, end) || splitsProtectedPhrase(words, end);
}

function isDanglingCut(words: string[], end: number): boolean {
  const last = (words[end - 1] ?? "").toLowerCase().replace(/[^a-z]+$/i, "");
  return DANGLING_END_WORDS.has(last);
}

function startsBadlyAfterCut(words: string[], end: number): boolean {
  const next = (words[end] ?? "").toLowerCase().replace(/^[^a-z]+|[^a-z]+$/gi, "");
  if (!next) return false;
  if (DANGLING_END_WORDS.has(next)) {
    const previous = words[end - 1] ?? "";
    if (CLAUSE_BOUNDARY.test(previous) && (next === "a" || next === "an" || next === "the")) return false;
    return true;
  }
  return /ing$/.test(next);
}

function isConjunctionClauseCut(words: string[], end: number): boolean {
  if (isDanglingCut(words, end) || splitsProtectedPhrase(words, end)) return false;
  if (CLAUSE_BOUNDARY.test(words[end - 1] ?? "")) return false;
  const next = (words[end] ?? "").toLowerCase().replace(/^[^a-z]+|[^a-z]+$/gi, "");
  return CONJUNCTION_START_WORDS.has(next);
}

function splitsProtectedPhrase(words: string[], end: number): boolean {
  const left = (words[end - 1] ?? "").toLowerCase().replace(/^[^a-z]+|[^a-z]+$/gi, "");
  const right = (words[end] ?? "").toLowerCase().replace(/^[^a-z]+|[^a-z]+$/gi, "");
  return !!left && !!right && PROTECTED_BIGRAMS.has(`${left} ${right}`);
}

function exceeds(text: string, options: ChunkTextOptions): boolean {
  if (options.maxChars && text.length > options.maxChars) return true;
  if (options.targetWords && wordCount(text) > options.targetWords) return true;
  return false;
}

function wordCount(text: string): number {
  return (text.match(WORD) ?? []).length;
}

function normalizeSpace(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}
