import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../run-paths";
import { getSetting } from "../settings";
import { log } from "../logger";
import { pLimit } from "../plimit";
import type { Scene } from "./scene-split";
import { generateImage } from "./image-gen";
import { animateScene } from "./img2vid";
import { uploadFile, uploadString } from "./gdrive";
import { saveBRollClip } from "../local-output";
import { driveFileLink, ensureChannelStockBrollFolder, ensureStockCollectionFolder } from "./drive-workspace";
import { cancelJob } from "./labs69";

/**
 * "Generate Stocks" - build general B-roll clips for a channel and upload them
 * into that channel's Drive stock folder. Pipeline per clip: text -> image ->
 * image-to-video -> Drive upload, matching the main generator.
 */

export interface StockGenClipStep {
  index: number;
  prompt: string;
  finalPrompt?: string;
  promptSource?: "exact" | "ai";
  status: "queued" | "image" | "video" | "upload" | "complete" | "failed" | "cancelled" | "deleted";
  imageStatus?: "queued" | "running" | "done" | "failed";
  videoStatus?: "queued" | "running" | "done" | "failed";
  uploadStatus?: "queued" | "running" | "done" | "failed";
  imageJobId?: string;
  imageProvider?: string;
  imagePath?: string;
  videoJobId?: string;
  videoPath?: string;
  driveFileId?: string;
  driveName?: string;
  driveFileLink?: string | null;
  displayName?: string;
  reviewStatus?: "unreviewed" | "good" | "weak" | "needs_review";
  retryCount?: number;
  lastProgressAt?: number;
  promptReadyAt?: number;
  imageStartedAt?: number;
  imageFinishedAt?: number;
  videoStartedAt?: number;
  videoFinishedAt?: number;
  uploadStartedAt?: number;
  uploadFinishedAt?: number;
  deletedAt?: number;
  error?: string;
}

export type StockGenPhase = "prompting" | "generating" | "finished" | "failed" | "cancelled";

export interface StockGenStatus {
  jobId: string;
  running: boolean;
  phase: StockGenPhase;
  cancelRequested?: boolean;
  total: number;
  requestedCount: number;
  done: number;
  failed: number;
  folder: string;
  theme?: string;
  styleBrief?: string;
  fallbackStyle?: string;
  negativePrompt?: string;
  channelId?: number | string;
  channelName?: string;
  promptMode?: "brief" | "exact" | "mixed";
  exactPrompts?: string[];
  aiPrompts?: string[];
  promptSource?: "ai" | "exact" | "mixed";
  imageConcurrency?: number;
  videoConcurrency?: number;
  startedAt: number;
  updatedAt?: number;
  promptStartedAt?: number;
  finishedAt?: number;
  lastError?: string;
  prompts?: string[];
  clips?: StockGenClipStep[];
  driveFolderId?: string;
  driveFolderLink?: string;
  manifestDriveFileId?: string;
}

const statusByFolder = new Map<string, StockGenStatus>();
const statusByJob = new Map<string, StockGenStatus>();
const promptAborters = new Map<string, AbortController>();
const JOBS_DIR = path.join(DATA_DIR, "stock-gen-jobs");
const DEFAULT_PROMPT_TIMEOUT_MS = 45_000;
const DRIVE_PRECHECK_TIMEOUT_MS = 15_000;

function createJobId(folder: string): string {
  const safeFolder = safeFilePart(folder) || "clips";
  return `stockgen-${safeFolder}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function safeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-|-$/g, "");
}

function slugPart(value: string, fallback = "clip"): string {
  const clean = value
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return clean || fallback;
}

function yyyymmdd(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10).replace(/-/g, "");
}

export function stockClipDisplayName(index: number): string {
  return `B-roll ${String(index + 1).padStart(2, "0")}`;
}

function stockClipDriveName(status: StockGenStatus, step: StockGenClipStep): string {
  const channelSlug = slugPart(String(status.channelName || status.theme || status.folder || "channel"), "channel");
  const promptSlug = slugPart(step.prompt, "clip").slice(0, 40).replace(/-+$/g, "");
  const date = yyyymmdd(status.startedAt || Date.now());
  return `${channelSlug}_broll_${date}_${String(step.index + 1).padStart(3, "0")}_${promptSlug}.mp4`;
}

function jobPath(jobId: string): string {
  return path.join(JOBS_DIR, `${safeFilePart(jobId) || "job"}.json`);
}

function latestPath(folder: string): string {
  return path.join(JOBS_DIR, `latest-${safeFilePart(folder) || "clips"}.json`);
}

function remember(status: StockGenStatus): StockGenStatus {
  status.updatedAt = Date.now();
  statusByFolder.set(status.folder, status);
  statusByJob.set(status.jobId, status);
  try {
    fs.mkdirSync(JOBS_DIR, { recursive: true });
    fs.writeFileSync(jobPath(status.jobId), JSON.stringify(status, null, 2));
    fs.writeFileSync(latestPath(status.folder), JSON.stringify({ jobId: status.jobId, updatedAt: status.updatedAt }, null, 2));
  } catch {
    /* Persistence is best-effort; the in-memory job still continues. */
  }
  return status;
}

async function uploadStockGenerationManifest(status: StockGenStatus, metadataFolderId?: string): Promise<void> {
  if (!metadataFolderId || status.manifestDriveFileId) return;
  const manifest = {
    kind: "stock-generation",
    jobId: status.jobId,
    channelId: status.channelId ?? null,
    channelName: status.channelName ?? null,
    folder: status.folder,
    theme: status.theme ?? null,
    phase: status.phase,
    requestedCount: status.requestedCount,
    total: status.total,
    done: status.done,
    failed: status.failed,
    startedAt: status.startedAt,
    finishedAt: status.finishedAt ?? Date.now(),
    driveFolderId: status.driveFolderId ?? null,
    driveFolderLink: status.driveFolderLink ?? null,
    styleBrief: status.styleBrief ?? null,
    negativePrompt: status.negativePrompt ?? null,
    clips: (status.clips ?? []).map((clip) => ({
      index: clip.index,
      displayName: clip.displayName || stockClipDisplayName(clip.index),
      prompt: clip.prompt,
      promptSource: clip.promptSource ?? null,
      reviewStatus: clip.reviewStatus ?? "unreviewed",
      status: clip.status,
      driveFileId: clip.driveFileId ?? null,
      driveName: clip.driveName ?? null,
      driveFileLink: clip.driveFileLink ?? (clip.driveFileId ? driveFileLink(clip.driveFileId) : null),
    })),
  };
  const manifestId = await uploadString(
    JSON.stringify(manifest, null, 2),
    metadataFolderId,
    `stock-generation-${safeFilePart(status.jobId)}.json`,
    "application/json"
  );
  status.manifestDriveFileId = manifestId;
}

function loadJob(jobId: string): StockGenStatus | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(jobPath(jobId), "utf8")) as Partial<StockGenStatus>;
    if (!parsed.jobId || !parsed.folder || typeof parsed.startedAt !== "number") return null;
    const status: StockGenStatus = {
      jobId: parsed.jobId,
      running: Boolean(parsed.running),
      phase: parsed.phase || (parsed.running ? "generating" : "finished"),
      total: Number(parsed.total) || 0,
      requestedCount: Number(parsed.requestedCount || parsed.total) || 0,
      done: Number(parsed.done) || 0,
      failed: Number(parsed.failed) || 0,
      folder: parsed.folder,
      theme: parsed.theme,
      styleBrief: parsed.styleBrief,
      fallbackStyle: parsed.fallbackStyle,
      negativePrompt: parsed.negativePrompt,
      channelId: parsed.channelId,
      channelName: parsed.channelName,
      promptMode: parsed.promptMode,
      exactPrompts: parsed.exactPrompts || [],
      aiPrompts: parsed.aiPrompts || [],
      promptSource: parsed.promptSource,
      imageConcurrency: parsed.imageConcurrency,
      videoConcurrency: parsed.videoConcurrency,
      startedAt: parsed.startedAt,
      updatedAt: parsed.updatedAt,
      promptStartedAt: parsed.promptStartedAt,
      finishedAt: parsed.finishedAt,
      lastError: parsed.lastError,
      prompts: parsed.prompts || [],
      clips: parsed.clips || [],
      driveFolderId: parsed.driveFolderId,
      driveFolderLink: parsed.driveFolderLink,
      manifestDriveFileId: parsed.manifestDriveFileId,
      cancelRequested: parsed.cancelRequested,
    };
    statusByFolder.set(status.folder, status);
    statusByJob.set(status.jobId, status);
    return status;
  } catch {
    return null;
  }
}

function loadLatest(folder: string): StockGenStatus | null {
  try {
    const pointer = JSON.parse(fs.readFileSync(latestPath(folder), "utf8")) as { jobId?: string };
    return pointer.jobId ? loadJob(pointer.jobId) : null;
  } catch {
    return null;
  }
}

export function listStockGenerationHistory(opts: { channelId?: string; folder?: string; limit?: number } = {}): StockGenStatus[] {
  try {
    const limit = Math.max(1, Math.min(100, Number(opts.limit) || 50));
    const files = fs.existsSync(JOBS_DIR) ? fs.readdirSync(JOBS_DIR) : [];
    const rows: StockGenStatus[] = [];
    for (const file of files) {
      if (!file.startsWith("stockgen-") || !file.endsWith(".json")) continue;
      const jobId = file.replace(/\.json$/i, "");
      const status = loadJob(jobId);
      if (!status) continue;
      if (opts.channelId && String(status.channelId || "") !== opts.channelId) continue;
      if (opts.folder && status.folder !== opts.folder) continue;
      rows.push(status);
    }
    return rows
      .sort((a, b) => (b.updatedAt || b.startedAt || 0) - (a.updatedAt || a.startedAt || 0))
      .slice(0, limit);
  } catch {
    return [];
  }
}

export function updateStockClipReview(jobId: string, index: number, reviewStatus: StockGenClipStep["reviewStatus"]): StockGenStatus | null {
  const status = getStockGenStatus(jobId);
  const step = status?.clips?.find((clip) => clip.index === index);
  if (!status || !step || !reviewStatus) return status ?? null;
  step.reviewStatus = reviewStatus;
  return remember(status);
}

export function markStockClipsDeletedByDriveIds(driveFileIds: string[]): number {
  const ids = new Set(driveFileIds.filter(Boolean));
  if (ids.size === 0) return 0;
  const touched = new Map<string, StockGenStatus>();

  for (const status of statusByJob.values()) {
    for (const step of status.clips ?? []) {
      if (!step.driveFileId || !ids.has(step.driveFileId) || step.status === "deleted") continue;
      step.status = "deleted";
      step.deletedAt = Date.now();
      step.lastProgressAt = Date.now();
      if (status.done > 0) status.done--;
      touched.set(status.jobId, status);
    }
  }

  try {
    const files = fs.existsSync(JOBS_DIR) ? fs.readdirSync(JOBS_DIR) : [];
    for (const file of files) {
      if (!file.startsWith("stockgen-") || !file.endsWith(".json")) continue;
      const status = loadJob(file.replace(/\.json$/i, ""));
      if (!status) continue;
      for (const step of status.clips ?? []) {
        if (!step.driveFileId || !ids.has(step.driveFileId) || step.status === "deleted") continue;
        step.status = "deleted";
        step.deletedAt = Date.now();
        step.lastProgressAt = Date.now();
        if (status.done > 0) status.done--;
        touched.set(status.jobId, status);
      }
    }
  } catch {
    /* Best effort: Drive trash remains the source of truth. */
  }

  for (const status of touched.values()) remember(status);
  return touched.size;
}

function promptTimeoutMs(): number {
  const configured = Number(process.env.STOCK_PROMPT_TIMEOUT_MS || "");
  if (Number.isFinite(configured) && configured >= 5_000) return Math.min(configured, 300_000);
  return DEFAULT_PROMPT_TIMEOUT_MS;
}

function stockGenMockEnabled(): boolean {
  return process.env.STOCK_GEN_MOCK === "1";
}

function normalizeExactPrompts(prompts: unknown): string[] {
  if (!Array.isArray(prompts)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of prompts) {
    if (typeof raw !== "string") continue;
    const prompt = raw.trim();
    if (!prompt || seen.has(prompt)) continue;
    seen.add(prompt);
    out.push(prompt);
  }
  return out.slice(0, 300);
}

function imageConcurrency(): number {
  const configured = Number(getSetting("IMAGE_CONCURRENCY") || "");
  return Math.max(20, Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 20);
}

function videoConcurrency(): number {
  const configured = Number(getSetting("ANIMATION_CONCURRENCY") || "");
  return Math.max(5, Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 5);
}

function defaultNegativePrompt(): string {
  return getSetting("GENERATION_NEGATIVE_PROMPT").trim();
}

function strictPromptCore(prompt: string, source: "exact" | "ai" = "ai", negativePrompt?: string | null): string {
  const avoid = negativePrompt?.trim();
  const base =
    source === "exact"
      ? `MANDATORY exact user prompt: ${prompt}. Follow this exact subject, lighting, mood, palette, camera framing, and composition. Single continuous 16:9 cinematic shot. Do not replace it with a broader, brighter, split-screen, collage, or generic scene.`
      : `B-roll prompt: ${prompt}. Preserve the requested subject, lighting, mood, palette, camera framing, and composition. Single continuous 16:9 cinematic shot.`;
  return avoid ? `${base} Avoid: ${avoid}.` : base;
}

function finalImagePrompt(prompt: string, styleOverride?: string | null, negativePrompt?: string | null, source: "exact" | "ai" = "ai"): string {
  const style = styleOverride?.trim();
  return [strictPromptCore(prompt, source, negativePrompt), style ? `Subordinate visual style, only if it does not conflict with the mandatory prompt: ${style}` : ""]
    .filter((part): part is string => Boolean(part && part.trim().length > 0))
    .join(", ");
}

function parsePromptList(text: string, count: number): string[] {
  const cleaned = text.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  const candidates = [cleaned];
  const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
  if (arrayMatch) candidates.push(arrayMatch[0]);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const arr = Array.isArray(parsed) ? parsed : [];
      const prompts = arr.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim());
      if (prompts.length > 0) return prompts.slice(0, count);
    } catch {
      /* Fall through to tolerant parsing. */
    }
  }

  const quoted: string[] = [];
  for (const match of cleaned.matchAll(/"((?:\\.|[^"\\]){24,})"/g)) {
    try {
      const value = JSON.parse(`"${match[1]}"`) as unknown;
      if (typeof value === "string" && value.trim().length > 0) quoted.push(value.trim());
    } catch {
      const value = match[1].replace(/\\"/g, '"').trim();
      if (value.length > 0) quoted.push(value);
    }
  }
  if (quoted.length > 0) return quoted.slice(0, count);

  return cleaned
    .split(/\r?\n+/)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").replace(/^['"]|['"],?$/g, "").trim())
    .filter((line) => line.length >= 24 && !/^\[|^\]|^\{|^\}|json array|return only/i.test(line))
    .slice(0, count);
}

function readVideoJobId(videoPath: string): string | undefined {
  try {
    const manifestPath = videoPath.replace(/\.mp4$/i, ".manifest.json");
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { videoJobId?: unknown };
    return typeof parsed.videoJobId === "string" ? parsed.videoJobId : undefined;
  } catch {
    return undefined;
  }
}

function withTimeout<T>(label: string, promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)} seconds`)), ms);
    promise.then(resolve, reject).finally(() => {
      if (timer) clearTimeout(timer);
    });
  });
}

export function getStockGenStatus(key: string): StockGenStatus | null {
  const memory = statusByJob.get(key) ?? statusByFolder.get(key);
  if (memory) return memory;
  if (key.startsWith("stockgen-")) return loadJob(key);
  return loadLatest(key);
}

export function cancelStockGeneration(key: string): StockGenStatus | null {
  const status = getStockGenStatus(key);
  if (!status || !status.running) return status ?? null;
  status.cancelRequested = true;
  status.lastError = "Stopping after the current in-flight step finishes.";
  promptAborters.get(status.jobId)?.abort();
  return remember(status);
}

/** Expand a channel theme into N varied, GENERAL B-roll visual prompts via Gemini. */
async function expandStockPrompts(theme: string, count: number, jobId: string, styleBrief?: string, negativePrompt?: string): Promise<string[]> {
  const style = (styleBrief || "").trim();
  if (stockGenMockEnabled()) {
    return Array.from({ length: count }, (_, index) =>
      `Cinematic reusable B-roll shot ${index + 1} for ${theme}${style ? ` in this style: ${style}` : ""}: atmospheric environment, detailed textures, slow camera movement, no faces, no readable text${negativePrompt ? `, avoid: ${negativePrompt}` : ""}.`
    );
  }

  const apiKey = getSetting("GOOGLE_API_KEY");
  if (!apiKey) throw new Error("GOOGLE_API_KEY is not set (Settings)");
  const model = getSetting("SCENE_SPLIT_MODEL") || "gemini-flash-latest";
  const timeoutMs = promptTimeoutMs();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  promptAborters.set(jobId, controller);

  const system =
    `You generate GENERAL, reusable B-roll video prompts for a faceless YouTube channel. ` +
    `The channel theme is: "${theme}". Produce ${count} distinct, atmospheric, cinematic shot ideas that are GENERIC to the theme ` +
    (style ? `The user requested this visual style: "${style}". Every prompt should honor this style while staying varied. ` : "") +
    (negativePrompt ? `Never generate these visual traits: "${negativePrompt}". ` : "") +
    `(establishing shots, objects, environments, textures, weather, scenery) - NO specific named people, NO faces, NO readable text, ` +
    `nothing tied to one storyline. Each prompt should be one vivid sentence describing camera + subject + mood. ` +
    `Return ONLY a JSON array of ${count} strings.`;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: `Theme: ${theme}.${style ? ` Style brief: ${style}.` : ""}${negativePrompt ? ` Avoid: ${negativePrompt}.` : ""} Generate ${count} general B-roll prompts.` }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 1.0, thinkingConfig: { thinkingBudget: 0 } },
      }),
    });
    if (!resp.ok) throw new Error(`Gemini ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    const json = (await resp.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "[]";
    const prompts = parsePromptList(text, count);
    if (prompts.length === 0) throw new Error("Gemini returned no usable prompts");
    return prompts.slice(0, count);
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error(timedOut ? `AI prompt generation timed out after ${Math.round(timeoutMs / 1000)} seconds` : "AI prompt generation was stopped");
    }
    throw e;
  } finally {
    clearTimeout(timer);
    promptAborters.delete(jobId);
  }
}

async function resolveDriveStockFolder(
  folder: string,
  channelName?: string | null
): Promise<{ id: string; link: string; metadataFolderId?: string }> {
  if (channelName?.trim()) {
    const info = await ensureChannelStockBrollFolder(channelName);
    return { id: info.id, link: info.link, metadataFolderId: info.workspace.metadataFolderId };
  }
  const info = await ensureStockCollectionFolder(channelName || folder, folder);
  return { id: info.id, link: info.link };
}

/**
 * Start a background batch. Returns immediately; poll getStockGenStatus(jobId).
 * `videoStyle` (optional) is appended to each prompt for the channel's look.
 */
export function startStockGeneration(opts: {
  folder: string;
  theme: string;
  count: number;
  videoStyle?: string | null;
  styleBrief?: string | null;
  negativePrompt?: string | null;
  exactPrompts?: string[];
  channelId?: number | string | null;
  channelName?: string | null;
  promptMode?: "brief" | "exact" | "mixed";
}): StockGenStatus {
  const { folder, theme } = opts;
  const exactPrompts = normalizeExactPrompts(opts.exactPrompts);
  const count = Math.max(1, Math.min(300, Math.max(Math.floor(Number(opts.count) || 10), exactPrompts.length)));
  const styleBrief = (opts.styleBrief ?? "").trim();
  const fallbackStyle = (opts.videoStyle ?? "").trim();
  const negativePrompt = (opts.negativePrompt ?? defaultNegativePrompt()).trim();
  const existing = statusByFolder.get(folder);
  if (existing?.running) return existing;

  const jobId = createJobId(folder);
  const promptMode = opts.promptMode || (exactPrompts.length === 0 ? "brief" : exactPrompts.length >= count ? "exact" : "mixed");
  const status: StockGenStatus = {
    jobId,
    running: true,
    phase: "prompting",
    total: count,
    requestedCount: count,
    done: 0,
    failed: 0,
    folder,
    theme,
    styleBrief: styleBrief || undefined,
    fallbackStyle: fallbackStyle || undefined,
    negativePrompt: negativePrompt || undefined,
    channelId: opts.channelId ?? undefined,
    channelName: opts.channelName ?? undefined,
    promptMode,
    exactPrompts,
    aiPrompts: [],
    promptSource: promptMode === "brief" ? "ai" : promptMode === "exact" ? "exact" : "mixed",
    imageConcurrency: imageConcurrency(),
    videoConcurrency: videoConcurrency(),
    startedAt: Date.now(),
    prompts: [],
    clips: [],
  };
  remember(status);
  const runId = jobId;

  void (async () => {
    try {
      log(runId, "info", `Generate Stocks: preparing ${count} clips for "${folder}"`, { stage: "image" });
      const driveFolder = await withTimeout(
        "Drive folder check",
        resolveDriveStockFolder(folder, opts.channelName),
        DRIVE_PRECHECK_TIMEOUT_MS
      );
      status.driveFolderId = driveFolder.id;
      status.driveFolderLink = driveFolder.link;
      remember(status);

      status.promptStartedAt = Date.now();
      remember(status);
      const aiNeeded = Math.max(0, count - exactPrompts.length);
      const effectiveStyle = status.styleBrief || status.fallbackStyle || "";
      const aiPrompts = aiNeeded > 0 ? await expandStockPrompts(theme, aiNeeded, runId, effectiveStyle, status.negativePrompt) : [];
      if (status.cancelRequested) {
        status.phase = "cancelled";
        status.running = false;
        status.finishedAt = Date.now();
        status.lastError = "Generation stopped before clip creation.";
        remember(status);
        return;
      }

      status.exactPrompts = exactPrompts;
      status.aiPrompts = aiPrompts;
      status.prompts = [...exactPrompts, ...aiPrompts].slice(0, count);
      status.total = status.prompts.length;
      status.phase = "generating";
      status.clips = status.prompts.map((prompt, index) => ({
        index,
        prompt,
        displayName: stockClipDisplayName(index),
        finalPrompt: finalImagePrompt(prompt, effectiveStyle, status.negativePrompt, index < exactPrompts.length ? "exact" : "ai"),
        promptSource: index < exactPrompts.length ? "exact" : "ai",
        status: "queued",
        imageStatus: "queued",
        videoStatus: "queued",
        uploadStatus: "queued",
        reviewStatus: "unreviewed",
        retryCount: 0,
        lastProgressAt: Date.now(),
        promptReadyAt: Date.now(),
      }));
      remember(status);
      log(runId, "info", `Prompt plan: ${exactPrompts.length} exact + ${aiPrompts.length} AI-filled B-roll prompt${status.prompts.length === 1 ? "" : "s"}`, {
        stage: "image",
        data: {
          channel: status.channelName || theme,
          folder,
          styleBrief: status.styleBrief || null,
          fallbackStyle: status.fallbackStyle || null,
          negativePrompt: status.negativePrompt || null,
          exactPrompts,
          aiPrompts,
          finalPrompts: status.clips.map((clip) => clip.finalPrompt || clip.prompt),
        },
      });

      const tmpDir = path.join(DATA_DIR, "library-cache", "_gen", folder);
      const imageDir = path.join(tmpDir, "images");
      const animDir = path.join(tmpDir, "anim");
      for (const d of [imageDir, animDir]) fs.mkdirSync(d, { recursive: true });

      if (stockGenMockEnabled()) {
        for (const step of status.clips || []) {
          step.displayName = stockClipDisplayName(step.index);
          step.status = "complete";
          step.imageStatus = "done";
          step.videoStatus = "done";
          step.uploadStatus = "done";
          step.driveName = stockClipDriveName(status, step);
          step.lastProgressAt = Date.now();
          status.done++;
        }
        status.phase = "finished";
        status.finishedAt = Date.now();
        await uploadStockGenerationManifest(status, driveFolder.metadataFolderId).catch((e) => {
          const msg = e instanceof Error ? e.message.slice(0, 160) : String(e);
          status.lastError = status.lastError || `Manifest upload failed: ${msg}`;
        });
        remember(status);
        return;
      }

      const limitImage = pLimit(status.imageConcurrency || 20);
      const limitVideo = pLimit(status.videoConcurrency || 5);
      const limitUpload = pLimit(8);
      const styleOverride = status.styleBrief || status.fallbackStyle || null;
      const videoPromises: Promise<void>[] = [];
      const uploadPromises: Promise<void>[] = [];

      async function uploadStep(step: StockGenClipStep, videoPath: string) {
        if (status.cancelRequested) {
          step.status = "cancelled";
          remember(status);
          return;
        }
        try {
          step.status = "upload";
          step.uploadStatus = "running";
          step.uploadStartedAt = Date.now();
          step.lastProgressAt = Date.now();
          remember(status);
          step.displayName = stockClipDisplayName(step.index);
          const driveName = stockClipDriveName(status, step);
          // Save the clip into the channel's local B-Roll folder (no Drive).
          const clipId = saveBRollClip(status.channelName || folder, videoPath, driveName);
          step.uploadStatus = "done";
          step.uploadFinishedAt = Date.now();
          step.lastProgressAt = Date.now();
          step.driveFileId = clipId;
          step.driveName = driveName;
          step.driveFileLink = null;
          step.videoPath = videoPath;
          step.status = "complete";
          status.done++;
          remember(status);
          log(runId, "success", `Stock clip ${step.index + 1} saved to local B-Rolls: ${driveName}`, {
            stage: "image",
            data: { prompt: step.prompt, imageJobId: step.imageJobId, videoJobId: step.videoJobId, clipId },
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message.slice(0, 160) : String(e);
          step.status = "failed";
          step.uploadStatus = "failed";
          step.lastProgressAt = Date.now();
          step.error = msg;
          status.failed++;
          status.lastError = msg;
          remember(status);
        }
      }

      async function videoStep(step: StockGenClipStep, image: Awaited<ReturnType<typeof generateImage>>, scene: Scene) {
        try {
          if (status.cancelRequested) {
            step.status = "cancelled";
            remember(status);
            return;
          }
          step.status = "video";
          step.videoStatus = "running";
          step.videoStartedAt = Date.now();
          step.lastProgressAt = Date.now();
          remember(status);
          const videoPath = await animateScene(runId, scene, image.filePath, animDir, {
            providerJobId: image.providerJobId,
            imageProvider: image.provider,
            styleOverride,
          });
          if (!videoPath) throw new Error("no video produced");
          step.videoStatus = "done";
          step.videoFinishedAt = Date.now();
          step.lastProgressAt = Date.now();
          step.videoPath = videoPath;
          step.videoJobId = readVideoJobId(videoPath);
          remember(status);
          uploadPromises.push(limitUpload(() => uploadStep(step, videoPath)));
        } catch (e) {
          const msg = e instanceof Error ? e.message.slice(0, 160) : String(e);
          step.status = "failed";
          step.error = msg;
          step.lastProgressAt = Date.now();
          if (step.videoStatus === "running") step.videoStatus = "failed";
          status.failed++;
          status.lastError = msg;
          remember(status);
          log(runId, "warn", `Stock clip ${step.index + 1} failed: ${msg}`, { stage: "image" });
        }
      }

      const promptsToProcess = status.prompts || [];
      await Promise.all(
        promptsToProcess.map((prompt, i) =>
          limitImage(async () => {
            const step = status.clips?.[i];
            if (!step) return;
            if (status.cancelRequested) {
              step.status = "cancelled";
              remember(status);
              return;
            }
            const source = step.promptSource || (i < exactPrompts.length ? "exact" : "ai");
            const scene: Scene = { index: i, text: "", visual_prompt: strictPromptCore(prompt, source, status.negativePrompt), duration_hint_sec: 8 };
            try {
              step.status = "image";
              step.imageStatus = "running";
              step.imageStartedAt = Date.now();
              step.lastProgressAt = Date.now();
              remember(status);
              const image = await generateImage(runId, scene, imageDir, { styleOverride, omitGlobalImagePrompt: true, aspectOverride: null, continuitySuffix: null });
              step.imageStatus = "done";
              step.imageFinishedAt = Date.now();
              step.lastProgressAt = Date.now();
              step.imageJobId = image.providerJobId;
              step.imageProvider = image.provider;
              step.imagePath = image.filePath;
              remember(status);
              if (status.cancelRequested) {
                step.status = "cancelled";
                step.videoStatus = "queued";
                step.uploadStatus = "queued";
                step.lastProgressAt = Date.now();
                remember(status);
                return;
              }
              videoPromises.push(limitVideo(() => videoStep(step, image, scene)));
            } catch (e) {
              const msg = e instanceof Error ? e.message.slice(0, 160) : String(e);
              step.status = "failed";
              step.error = msg;
              step.lastProgressAt = Date.now();
              if (step.imageStatus === "running") step.imageStatus = "failed";
              if (step.videoStatus === "running") step.videoStatus = "failed";
              if (step.uploadStatus === "running") step.uploadStatus = "failed";
              status.failed++;
              status.lastError = msg;
              remember(status);
              log(runId, "warn", `Stock clip ${i + 1} failed: ${msg}`, { stage: "image" });
            }
          })
        )
      );
      await Promise.all(videoPromises);
      await Promise.all(uploadPromises);

      status.phase = status.cancelRequested ? "cancelled" : status.failed >= status.total && status.done === 0 ? "failed" : "finished";
      status.finishedAt = Date.now();
      await uploadStockGenerationManifest(status, driveFolder.metadataFolderId).catch((e) => {
        const msg = e instanceof Error ? e.message.slice(0, 160) : String(e);
        status.lastError = status.lastError || `Manifest upload failed: ${msg}`;
      });
      if (status.cancelRequested) {
        status.lastError = `Generation stopped after ${status.done}/${status.total} Drive uploads.`;
        log(runId, "warn", `Generate Stocks stopped: ${status.done}/${status.total} added to "${folder}" before stop`, { stage: "image" });
      } else {
        log(runId, "success", `Generate Stocks done: ${status.done}/${status.total} added to "${folder}" (${status.failed} failed)`, { stage: "image" });
      }
    } catch (e) {
      status.lastError = e instanceof Error ? e.message : String(e);
      status.phase = status.cancelRequested ? "cancelled" : "failed";
      log(runId, "error", `Generate Stocks failed: ${status.lastError}`, { stage: "image" });
    } finally {
      status.running = false;
      status.finishedAt = status.finishedAt || Date.now();
      remember(status);
    }
  })();

  return status;
}

export function retryStockGenerationClip(jobId: string, index: number, mode: "image" | "video" = "video"): StockGenStatus | null {
  const status = getStockGenStatus(jobId);
  const step = status?.clips?.find((clip) => clip.index === index);
  if (!status || !step) return status ?? null;
  if (step.status === "complete") {
    status.lastError = "Completed clips are not retried automatically. Delete or rerun manually if you want a replacement.";
    return remember(status);
  }

  const retryMode = mode === "image" || !step.imagePath || !step.imageJobId ? "image" : "video";
  if (step.status === "failed" && status.failed > 0) status.failed--;
  step.retryCount = (step.retryCount || 0) + 1;
  step.error = undefined;
  step.status = retryMode === "image" ? "image" : "video";
  if (retryMode === "image") {
    step.imageStatus = "running";
    step.videoStatus = "queued";
    step.uploadStatus = "queued";
  } else {
    step.videoStatus = "running";
    step.uploadStatus = "queued";
  }
  step.lastProgressAt = Date.now();
  status.running = true;
  status.phase = "generating";
  status.finishedAt = undefined;
  remember(status);

  void (async () => {
    const runId = status.jobId;
    try {
      if (step.videoJobId && step.videoStatus === "running") await cancelJob("videos", step.videoJobId).catch(() => false);
      if (retryMode === "image" && step.imageJobId && step.imageStatus === "running") await cancelJob("images", step.imageJobId).catch(() => false);

      const driveFolder = status.driveFolderId
        ? { id: status.driveFolderId, link: status.driveFolderLink || `https://drive.google.com/drive/folders/${status.driveFolderId}` }
        : await withTimeout(
            "Drive folder check",
            resolveDriveStockFolder(status.folder, status.channelName),
            DRIVE_PRECHECK_TIMEOUT_MS
          );
      status.driveFolderId = driveFolder.id;
      status.driveFolderLink = driveFolder.link;
      const tmpDir = path.join(DATA_DIR, "library-cache", "_gen", status.folder);
      const imageDir = path.join(tmpDir, "images");
      const animDir = path.join(tmpDir, "anim");
      for (const d of [imageDir, animDir]) fs.mkdirSync(d, { recursive: true });
      const styleOverride = status.styleBrief || status.fallbackStyle || null;
      const scene: Scene = {
        index: step.index,
        text: "",
        visual_prompt: strictPromptCore(step.prompt, step.promptSource || "ai", status.negativePrompt),
        duration_hint_sec: 8,
      };

      let image: Awaited<ReturnType<typeof generateImage>> = {
        filePath: step.imagePath || "",
        providerJobId: step.imageJobId,
        provider: step.imageProvider || "69labs",
      };
      if (retryMode === "image") {
        step.status = "image";
        step.imageStatus = "running";
        step.imageStartedAt = Date.now();
        step.lastProgressAt = Date.now();
        remember(status);
        image = await generateImage(runId, scene, imageDir, { styleOverride, omitGlobalImagePrompt: true, aspectOverride: null, continuitySuffix: null });
        step.imageStatus = "done";
        step.imageFinishedAt = Date.now();
        step.imageJobId = image.providerJobId;
        step.imageProvider = image.provider;
        step.imagePath = image.filePath;
        step.lastProgressAt = Date.now();
        remember(status);
      }

      step.status = "video";
      step.videoStatus = "running";
      step.videoStartedAt = Date.now();
      step.lastProgressAt = Date.now();
      remember(status);
      const videoPath = await animateScene(runId, scene, image.filePath, animDir, {
        providerJobId: image.providerJobId,
        imageProvider: image.provider,
        styleOverride,
      });
      if (!videoPath) throw new Error("no video produced");
      step.videoStatus = "done";
      step.videoFinishedAt = Date.now();
      step.videoPath = videoPath;
      step.videoJobId = readVideoJobId(videoPath);
      step.lastProgressAt = Date.now();
      remember(status);

      step.status = "upload";
      step.uploadStatus = "running";
      step.uploadStartedAt = Date.now();
      step.lastProgressAt = Date.now();
      remember(status);
      step.displayName = stockClipDisplayName(step.index);
      const driveName = stockClipDriveName(status, step);
      const driveId = await uploadFile(videoPath, driveFolder.id, { name: driveName, mimeType: "video/mp4" });
      step.uploadStatus = "done";
      step.uploadFinishedAt = Date.now();
      step.driveFileId = driveId;
      step.driveName = driveName;
      step.driveFileLink = driveFileLink(driveId);
      step.status = "complete";
      step.lastProgressAt = Date.now();
      status.done++;
      status.lastError = undefined;
      status.phase = status.failed > 0 ? "generating" : status.done >= status.total ? "finished" : "generating";
    } catch (e) {
      const msg = e instanceof Error ? e.message.slice(0, 160) : String(e);
      step.status = "failed";
      step.error = msg;
      step.lastProgressAt = Date.now();
      if (step.imageStatus === "running") step.imageStatus = "failed";
      if (step.videoStatus === "running") step.videoStatus = "failed";
      if (step.uploadStatus === "running") step.uploadStatus = "failed";
      status.failed++;
      status.lastError = msg;
    } finally {
      status.running = Boolean(status.clips?.some((clip) => ["image", "video", "upload"].includes(clip.status)));
      if (!status.running) {
        status.phase = status.failed >= status.total && status.done === 0 ? "failed" : status.done >= status.total ? "finished" : status.phase;
        status.finishedAt = Date.now();
      }
      remember(status);
    }
  })();

  return status;
}

/* Legacy body replaced by the stricter generation pipeline above. */
/*
      status.clips = status.prompts.map((prompt, index) => ({
        index,
        prompt,
        finalPrompt: finalImagePrompt(prompt, effectiveStyle),
        promptSource: index < exactPrompts.length ? "exact" : "ai",
        status: "queued",
        imageStatus: "queued",
        videoStatus: "queued",
        uploadStatus: "queued",
        reviewStatus: "unreviewed",
        promptReadyAt: Date.now(),
      }));
      remember(status);
      log(runId, "info", `Prompt plan: ${exactPrompts.length} exact + ${aiPrompts.length} AI-filled B-roll prompt${status.prompts.length === 1 ? "" : "s"}`, {
        stage: "image",
        data: {
          channel: status.channelName || theme,
          folder,
          styleBrief: status.styleBrief || null,
          fallbackStyle: status.fallbackStyle || null,
          exactPrompts,
          aiPrompts,
          finalPrompts: status.clips.map((clip) => clip.finalPrompt || clip.prompt),
        },
      });

      const tmpDir = path.join(DATA_DIR, "library-cache", "_gen", folder);
      const imageDir = path.join(tmpDir, "images");
      const animDir = path.join(tmpDir, "anim");
      for (const d of [imageDir, animDir]) fs.mkdirSync(d, { recursive: true });

      if (stockGenMockEnabled()) {
        for (const step of status.clips || []) {
          step.status = "complete";
          step.imageStatus = "done";
          step.videoStatus = "done";
          step.uploadStatus = "done";
          step.driveName = `mock_${String(step.index + 1).padStart(3, "0")}.mp4`;
          status.done++;
        }
        status.phase = "finished";
        remember(status);
        return;
      }

      const limitImage = pLimit(status.imageConcurrency || 20);
      const limitVideo = pLimit(status.videoConcurrency || 5);
      const limitUpload = pLimit(8);
      const styleOverride = status.styleBrief || status.fallbackStyle || null;
      const videoPromises: Promise<void>[] = [];
      const uploadPromises: Promise<void>[] = [];

      async function uploadStep(step: StockGenClipStep, videoPath: string) {
        if (status.cancelRequested) {
          step.status = "cancelled";
          remember(status);
          return;
        }
        try {
          step.status = "upload";
          step.uploadStatus = "running";
          step.uploadStartedAt = Date.now();
          remember(status);
          const stamp = Date.now().toString(36);
          const driveName = `gen_${stamp}_${String(step.index).padStart(3, "0")}.mp4`;
          const driveId = await uploadFile(videoPath, driveFolder.id, { name: driveName, mimeType: "video/mp4" });
          step.uploadStatus = "done";
          step.uploadFinishedAt = Date.now();
          step.driveFileId = driveId;
          step.driveName = driveName;

          const cachedName = `${driveId}__${driveName.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
          const cachedPath = path.join(animDir, cachedName);
          try {
            fs.renameSync(videoPath, cachedPath);
            step.videoPath = cachedPath;
            const oldManifest = videoPath.replace(/\.mp4$/i, ".manifest.json");
            if (fs.existsSync(oldManifest)) fs.renameSync(oldManifest, cachedPath.replace(/\.mp4$/i, ".manifest.json"));
          } catch {
            step.videoPath = videoPath;
          }
          step.status = "complete";
          status.done++;
          remember(status);
          log(runId, "success", `Stock clip ${step.index + 1} uploaded to Drive: ${driveName}`, {
            stage: "image",
            data: { prompt: step.prompt, imageJobId: step.imageJobId, videoJobId: step.videoJobId, driveFileId: driveId },
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message.slice(0, 160) : String(e);
          step.status = "failed";
          step.uploadStatus = "failed";
          step.error = msg;
          status.failed++;
          status.lastError = msg;
          remember(status);
        }
      }

      async function videoStep(step: StockGenClipStep, image: Awaited<ReturnType<typeof generateImage>>, scene: Scene) {
        try {
          if (status.cancelRequested) {
            step.status = "cancelled";
            remember(status);
            return;
          }
          step.status = "video";
          step.videoStatus = "running";
          step.videoStartedAt = Date.now();
          remember(status);
          const videoPath = await animateScene(runId, scene, image.filePath, animDir, {
            providerJobId: image.providerJobId,
            imageProvider: image.provider,
            styleOverride,
          });
          if (!videoPath) throw new Error("no video produced");
          step.videoStatus = "done";
          step.videoFinishedAt = Date.now();
          step.videoPath = videoPath;
          step.videoJobId = readVideoJobId(videoPath);
          remember(status);
          uploadPromises.push(limitUpload(() => uploadStep(step, videoPath)));
        } catch (e) {
          const msg = e instanceof Error ? e.message.slice(0, 160) : String(e);
          step.status = "failed";
          step.error = msg;
          if (step.videoStatus === "running") step.videoStatus = "failed";
          status.failed++;
          status.lastError = msg;
          remember(status);
          log(runId, "warn", `Stock clip ${step.index + 1} failed: ${msg}`, { stage: "image" });
        }
      }

      const promptsToProcess = status.prompts || [];
      await Promise.all(
        promptsToProcess.map((prompt, i) =>
          limitImage(async () => {
            const step = status.clips?.[i];
            if (!step) return;
            if (status.cancelRequested) {
              step.status = "cancelled";
              remember(status);
              return;
            }
            const scene: Scene = { index: i, text: "", visual_prompt: prompt, duration_hint_sec: 8 };
            try {
              step.status = "image";
              step.imageStatus = "running";
              step.imageStartedAt = Date.now();
              remember(status);
              const image = await generateImage(runId, scene, imageDir, { styleOverride, omitGlobalImagePrompt: true, aspectOverride: null, continuitySuffix: null });
              step.imageStatus = "done";
              step.imageFinishedAt = Date.now();
              step.imageJobId = image.providerJobId;
              step.imageProvider = image.provider;
              step.imagePath = image.filePath;
              remember(status);
              videoPromises.push(limitVideo(() => videoStep(step, image, scene)));
            } catch (e) {
              const msg = e instanceof Error ? e.message.slice(0, 160) : String(e);
              step.status = "failed";
              step.error = msg;
              if (step.imageStatus === "running") step.imageStatus = "failed";
              if (step.videoStatus === "running") step.videoStatus = "failed";
              if (step.uploadStatus === "running") step.uploadStatus = "failed";
              status.failed++;
              status.lastError = msg;
              remember(status);
              log(runId, "warn", `Stock clip ${i + 1} failed: ${msg}`, { stage: "image" });
            }
          })
        )
      );
      await Promise.all(videoPromises);
      await Promise.all(uploadPromises);

      status.phase = status.cancelRequested ? "cancelled" : status.failed >= status.total && status.done === 0 ? "failed" : "finished";
      if (status.cancelRequested) {
        status.lastError = `Generation stopped after ${status.done}/${status.total} Drive uploads.`;
        log(runId, "warn", `Generate Stocks stopped: ${status.done}/${status.total} added to "${folder}" before stop`, { stage: "image" });
      } else {
        log(runId, "success", `Generate Stocks done: ${status.done}/${status.total} added to "${folder}" (${status.failed} failed)`, { stage: "image" });
      }
    } catch (e) {
      status.lastError = e instanceof Error ? e.message : String(e);
      status.phase = status.cancelRequested ? "cancelled" : "failed";
      log(runId, "error", `Generate Stocks failed: ${status.lastError}`, { stage: "image" });
    } finally {
      status.running = false;
      status.finishedAt = Date.now();
      remember(status);
    }
  })();

  return status;
}
*/
