import fs from "node:fs";
import { CancelledError, checkCancelled } from "../cancellation";
import { getSetting } from "../settings";
import { log, type LogLevel } from "../logger";
import {
  isProviderCapacityResponse,
  pollIntervalMs,
  pollTimeoutMs,
  positiveInt,
  retryWaitMs,
} from "./labs69-capacity";

/**
 * 69labs.vip API client with multi-key pool support.
 *
 * A single API key (vk_...) covers TTS + images + videos.
 * The platform supports MULTIPLE accounts/keys for higher parallelism — each
 * 69labs account has its own hard limits (7 concurrent images, 5 concurrent
 * videos), so 3 keys = 21 image / 15 video slots total.
 *
 * Keys are read from `LABS69_API_KEY` setting (newline or comma separated).
 * Jobs are bound to a specific key for their lifetime (poll/download/cancel
 * all use the same key that created the job) — required for img2vid chaining
 * because 69labs only lets the original account access a job's output.
 *
 * Docs:    https://69labs.vip/api-docs
 * OpenAPI: https://69labs.vip/api/docs/openapi.yaml
 */

const BASE = "https://69labs.vip/api/v1";
const CAPABILITY_CACHE_MS = 60_000;

export type JobKind = "tts" | "images" | "videos";
type JobStatus = "PENDING" | "PROCESSING" | "FINALIZING" | "COMPLETED" | "FAILED" | "CANCELLED" | "CENSORED";
export interface Labs69RuntimeLimits {
  source: "live" | "settings";
  keyCount: number;
  imagePerKey: number;
  videoPerKey: number;
  ttsPerKey: number;
  imageRemainingMonthly?: number;
  videoRemainingMonthly?: number;
  imageModels: string[];
  videoModels: string[];
}

export interface Labs69CapabilitySlots {
  enabled: boolean;
  maxConcurrentJobs?: number;
  activeJobs?: number;
  remainingJobs?: number;
  priorityLevel?: number;
  maxPerGeneration?: number;
  hourlyRemaining?: number;
  monthlyRemaining?: number;
}

export interface Labs69AccountLimits {
  source: "live" | "settings";
  keyCount: number;
  images?: Labs69CapabilitySlots;
  videos?: Labs69CapabilitySlots;
}

interface ModelsSection {
  limits?: { maxConcurrentJobs?: unknown };
  usage?: Record<string, unknown>;
  models?: unknown[];
  monthlyRemaining?: unknown;
  monthlyUsageRemaining?: unknown;
  remainingMonthly?: unknown;
}

let capabilityCache:
  | {
      fingerprint: string;
      expiresAt: number;
      value: Labs69RuntimeLimits;
    }
  | null = null;

let accountLimitsCache:
  | {
      fingerprint: string;
      expiresAt: number;
      value: Labs69AccountLimits;
    }
  | null = null;

// ── Key pool ────────────────────────────────────────────────────────────────

/**
 * Tracks in-flight job count per key.
 * Key list is parsed lazily from the LABS69_API_KEY setting on each pick(),
 * so users can add/remove keys live in /settings and we pick them up next job.
 */
const pool = {
  active: new Map<string, number>(),
  healthyFingerprint: "",
  healthyKeys: null as string[] | null,

  list(): string[] {
    return [...new Set(getSetting("LABS69_API_KEY")
      .split(/[\n,;]+/)
      .map((k) => k.trim())
      .filter(Boolean))];
  },

  fingerprint(keys: string[]): string {
    return keys.map((k) => `${k.length}:${k.slice(0, 4)}:${k.slice(-4)}`).join("|");
  },

  usableList(): string[] {
    const keys = this.list();
    if (
      this.healthyKeys &&
      this.healthyKeys.length > 0 &&
      this.healthyFingerprint === this.fingerprint(keys)
    ) {
      return this.healthyKeys;
    }
    return keys;
  },

  setHealthy(keys: string[] | null, fingerprint: string) {
    this.healthyFingerprint = fingerprint;
    this.healthyKeys = keys && keys.length > 0 ? [...new Set(keys)] : null;
  },

  /** Pick the least-loaded key from the current pool. Bumps its counter. */
  pick(): string {
    const keys = this.usableList();
    if (keys.length === 0) throw new Error("LABS69_API_KEY is not set (Settings)");
    let best = keys[0];
    let bestCount = this.active.get(best) ?? 0;
    for (let i = 1; i < keys.length; i++) {
      const c = this.active.get(keys[i]) ?? 0;
      if (c < bestCount) {
        best = keys[i];
        bestCount = c;
      }
    }
    this.active.set(best, bestCount + 1);
    return best;
  },

  /** Manually acquire a specific key (used when chaining img2vid to a known image's key). */
  acquireSpecific(key: string) {
    if (!key) return;
    this.active.set(key, (this.active.get(key) ?? 0) + 1);
  },

  release(key: string) {
    const c = this.active.get(key) ?? 0;
    if (c > 0) this.active.set(key, c - 1);
  },
};

/** Number of configured keys. Exposed for UI / pipeline concurrency scaling. */
export function getKeyCount(): number {
  return pool.list().length;
}

export async function discoverLabs69Runtime(): Promise<Labs69RuntimeLimits> {
  const keys = pool.list();
  const fallback = fallbackRuntime(keys.length);
  if (keys.length === 0) return fallback;

  const fingerprint = pool.fingerprint(keys);
  if (capabilityCache && capabilityCache.fingerprint === fingerprint && capabilityCache.expiresAt > Date.now()) {
    return capabilityCache.value;
  }

  const rows = await Promise.all(
    keys.map(async (key) => {
      try {
        const r = await fetch(`${BASE}/models`, { headers: { Authorization: `Bearer ${key}` } });
        if (!r.ok) return null;
        const json = (await r.json()) as Record<string, unknown>;
        return { key, parsed: parseModelsResponse(json) };
      } catch {
        return null;
      }
    })
  );

  const liveRows = rows.filter((r): r is { key: string; parsed: ParsedModelsResponse } => r !== null);
  pool.setHealthy(liveRows.map((r) => r.key), fingerprint);
  const live = liveRows.map((r) => r.parsed);
  const value =
    live.length > 0
      ? mergeRuntime(live.length, live, fallbackRuntime(live.length))
      : fallback;
  capabilityCache = { fingerprint, expiresAt: Date.now() + CAPABILITY_CACHE_MS, value };
  return value;
}

export async function discoverLabs69AccountLimits(): Promise<Labs69AccountLimits> {
  const keys = pool.list();
  const fallback: Labs69AccountLimits = { source: "settings", keyCount: keys.length };
  if (keys.length === 0) return fallback;

  const fingerprint = pool.fingerprint(keys);
  if (accountLimitsCache && accountLimitsCache.fingerprint === fingerprint && accountLimitsCache.expiresAt > Date.now()) {
    return accountLimitsCache.value;
  }

  const rows = await Promise.all(
    keys.map(async (key) => {
      try {
        const r = await fetch(`${BASE}/limits`, { headers: { Authorization: `Bearer ${key}` } });
        if (!r.ok) return null;
        return (await r.json()) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
  );

  const liveRows = rows.filter((r): r is Record<string, unknown> => r !== null);
  const value =
    liveRows.length > 0
      ? {
          source: "live" as const,
          keyCount: liveRows.length,
          images: mergeCapabilitySlots(liveRows.map((r) => readLimitCapability(r.images))),
          videos: mergeCapabilitySlots(liveRows.map((r) => readLimitCapability(r.videos))),
        }
      : fallback;
  accountLimitsCache = { fingerprint, expiresAt: Date.now() + 10_000, value };
  return value;
}

// ── Job ↔ key binding ───────────────────────────────────────────────────────

/**
 * jobId → key that created it. Needed because:
 *   • polling a job has to use the same account that created it
 *   • img2vid with imageJobId requires the same key as the source image
 */
const jobKeyMap = new Map<string, string>();

/** Release a job's slot manually (used in caller error/cleanup paths). */
export function releaseJob(jobId: string) {
  const key = jobKeyMap.get(jobId);
  if (key) {
    pool.release(key);
    jobKeyMap.delete(jobId);
  }
}

function authHeadersFor(key: string): Record<string, string> {
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
}

function keyFor(jobId: string): string {
  const k = jobKeyMap.get(jobId);
  if (k) return k;
  // Fallback to first key — happens for older jobs without binding (e.g. after server restart).
  const keys = pool.usableList();
  if (keys.length === 0) throw new Error("LABS69_API_KEY is not set");
  return keys[0];
}

/**
 * POST helper. Transparently waits out HTTP 429 (rate limit / hourly cap)
 * instead of failing the run: 69labs caps throughput per hour, so an
 * overnight batch must be able to sleep through the cap and continue.
 * Honors a `Retry-After` header when present, otherwise escalates the wait.
 * Non-429 errors propagate immediately.
 */
async function postJsonWithKey<T>(
  path: string,
  body: unknown,
  key: string,
  ctx?: { runId: string; stage: string }
): Promise<T> {
  const MAX_PROVIDER_RETRIES = 180;
  let retry = 0;
  while (true) {
    if (ctx) checkCancelled(ctx.runId);
    await waitForLiveCreationSlot(path, key, ctx);
    const r = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: authHeadersFor(key),
      body: JSON.stringify(body),
    });
    if (r.ok) return (await r.json()) as T;

    const text = await r.text();
    const capacity = isProviderCapacityResponse(r.status, text);
    const rateLimited = r.status === 429;
    if ((capacity || rateLimited) && retry < MAX_PROVIDER_RETRIES) {
      retry++;
      const waitMs = retryWaitMs(r.headers.get("retry-after"), retry, {
        baseMs: capacity ? 10_000 : 20_000,
        maxMs: capacity ? 2 * 60_000 : 10 * 60_000,
      });
      if (ctx) {
        const label = providerLabel(path);
        log(
          ctx.runId,
          "warn",
          capacity
            ? `Provider full - waiting ${Math.round(waitMs / 1000)}s for a ${label} slot (${retry}/${MAX_PROVIDER_RETRIES})`
            : `69labs rate limit (429) - waiting ${Math.round(waitMs / 1000)}s then retrying (${retry}/${MAX_PROVIDER_RETRIES})`,
          { stage: ctx.stage }
        );
      }
      await sleep(waitMs, ctx?.runId);
      continue;
    }
    throw new Error(`69labs POST ${path} ${r.status}: ${text.slice(0, 400)}`);
  }
}

async function waitForLiveCreationSlot(
  path: string,
  key: string,
  ctx?: { runId: string; stage: string }
): Promise<void> {
  const capability = path.startsWith("/images/") ? "images" : path.startsWith("/videos/") ? "videos" : null;
  if (!capability) return;

  let nextLogAt = 0;
  while (true) {
    if (ctx) checkCancelled(ctx.runId);
    let slots: Labs69CapabilitySlots | undefined;
    try {
      const r = await fetch(`${BASE}/limits`, { headers: { Authorization: `Bearer ${key}` } });
      if (!r.ok) return;
      const json = (await r.json()) as Record<string, unknown>;
      slots = readLimitCapability(json[capability]);
    } catch {
      return;
    }
    if (!slots || slots.remainingJobs == null || slots.remainingJobs > 0) return;

    if (ctx && Date.now() >= nextLogAt) {
      const active =
        typeof slots.activeJobs === "number" && typeof slots.maxConcurrentJobs === "number"
          ? ` (${slots.activeJobs}/${slots.maxConcurrentJobs} active)`
          : "";
      log(
        ctx.runId,
        "warn",
        `69labs ${capability} slots are full${active} — waiting for live /limits before creating another job`,
        { stage: ctx.stage }
      );
      nextLogAt = Date.now() + 30_000;
    }
    await sleep(5_000, ctx?.runId);
  }
}

interface JobCreatedResponse {
  id: string;
  status?: JobStatus;
  queuePosition?: number | null;
}
interface MultiJobCreatedResponse {
  jobs: JobCreatedResponse[];
}

// ── TTS ─────────────────────────────────────────────────────────────────────

/** TTS: create a job. Returns jobId. Supports ElevenLabs, saved clones, and legacy MiniMax voices. */
export async function createTtsJob(opts: {
  text: string;
  voiceId: string;
  voiceProvider?: "elevenlabs" | "voice-clone" | "minimax";
  modelId?: string;
  splitType?: "smart" | "paragraphs" | "max_length";
  voiceSettings?: {
    stability?: number;
    similarityBoost?: number;
    speed?: number;
    style?: number;
    useSpeakerBoost?: boolean;
  };
  /** MiniMax-only delivery tuning — ignored unless voiceProvider === "minimax". */
  minimaxSettings?: {
    speed?: number; // 0.01–10  (1 = neutral)
    pitch?: number; // -12–12   (0 = neutral)
    volume?: number; // 0.5–2   (1 = neutral)
    languageBoost?: string; // language hint, e.g. "English"; "auto" = detect
  };
  autoPauseEnabled?: boolean;
  autoPauseDuration?: number;
  autoPauseFrequency?: number;
  /** Optional — enables rate-limit (429) wait logging into the run log. */
  runId?: string;
}): Promise<string> {
  const key = pool.pick();
  const ctx = opts.runId ? { runId: opts.runId, stage: "tts" } : undefined;
  try {
    // Voice-clone uses a different endpoint
    if (opts.voiceProvider === "voice-clone") {
      const resp = await postJsonWithKey<JobCreatedResponse>(
        "/voice-clones/generate",
        { voiceCloneId: opts.voiceId, text: opts.text },
        key,
        ctx
      );
      jobKeyMap.set(resp.id, key);
      return resp.id;
    }
    const body: Record<string, unknown> = {
      text: opts.text,
      voiceId: opts.voiceId,
      splitType: opts.splitType ?? "smart",
    };
    if (opts.voiceProvider) body.voiceProvider = opts.voiceProvider;
    if (opts.modelId) body.modelId = opts.modelId;
    if (opts.voiceSettings && Object.keys(opts.voiceSettings).length > 0) {
      body.voiceSettings = opts.voiceSettings;
    }
    if (
      opts.voiceProvider === "minimax" &&
      opts.minimaxSettings &&
      Object.keys(opts.minimaxSettings).length > 0
    ) {
      body.minimaxSettings = opts.minimaxSettings;
    }
    if (opts.autoPauseEnabled) {
      body.autoPauseEnabled = true;
      if (opts.autoPauseDuration !== undefined) body.autoPauseDuration = opts.autoPauseDuration;
      if (opts.autoPauseFrequency !== undefined) body.autoPauseFrequency = opts.autoPauseFrequency;
    }
    const resp = await postJsonWithKey<JobCreatedResponse>("/tts/generate", body, key, ctx);
    jobKeyMap.set(resp.id, key);
    return resp.id;
  } catch (e) {
    pool.release(key);
    throw e;
  }
}

/**
 * One MiniMax catalog voice, normalized from the 69labs `/tts/minimax/voices`
 * response — used by the standalone Voiceover tool's voice picker.
 */
export interface MinimaxVoice {
  voiceId: string;
  name: string;
  description: string | null;
  language: string | null;
  gender: string | null;
  isClone: boolean;
  sampleAudio: string | null;
  tags: string[];
}

/**
 * Lists MiniMax catalog voices via 69labs `GET /tts/minimax/voices`.
 * A plain GET — uses the first configured key for auth and never touches the
 * job/key pool (no job is created). Supports server-side search / filtering.
 */
export async function listMinimaxVoices(
  opts: { search?: string; language?: string; gender?: string; page?: number; pageSize?: number } = {}
): Promise<{ voices: MinimaxVoice[]; hasMore: boolean; totalCount: number }> {
  const keys = pool.list();
  if (keys.length === 0) throw new Error("LABS69_API_KEY is not set (Settings)");

  const params = new URLSearchParams();
  params.set("page", String(Math.max(0, opts.page ?? 0)));
  params.set("page_size", String(Math.min(100, Math.max(1, opts.pageSize ?? 100))));
  if (opts.search?.trim()) params.set("search", opts.search.trim());
  if (opts.language?.trim()) params.set("language", opts.language.trim());
  if (opts.gender?.trim()) params.set("gender", opts.gender.trim());

  const r = await fetch(`${BASE}/tts/minimax/voices?${params.toString()}`, {
    headers: { Authorization: `Bearer ${keys[0]}` },
  });
  if (!r.ok) {
    throw new Error(`69labs MiniMax voices ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  const json = (await r.json()) as {
    voices?: Array<{
      voice_id?: string;
      name?: string;
      voice_name?: string;
      description?: string | null;
      sample_audio?: string | null;
      tag_list?: string[];
      language?: string | null;
      gender?: string | null;
      is_clone?: boolean;
    }>;
    has_more?: boolean;
    total_count?: number;
  };
  const voices: MinimaxVoice[] = (json.voices ?? [])
    .filter((v) => typeof v.voice_id === "string" && v.voice_id.length > 0)
    .map((v) => ({
      voiceId: v.voice_id as string,
      name: (v.name || v.voice_name || v.voice_id) as string,
      description: v.description ?? null,
      language: v.language ?? null,
      gender: v.gender ?? null,
      isClone: Boolean(v.is_clone),
      sampleAudio: v.sample_audio ?? null,
      tags: Array.isArray(v.tag_list) ? v.tag_list : [],
    }));
  return {
    voices,
    hasMore: Boolean(json.has_more),
    totalCount: Number.isFinite(json.total_count) ? Number(json.total_count) : voices.length,
  };
}

// ── Images ──────────────────────────────────────────────────────────────────

/** Image: create a job. Returns jobId. */
export async function createImageJob(opts: {
  prompt: string;
  model?: string;
  aspectRatio?: string;
  resolution?: string;
  imageUrls?: string[];
  /** Optional — enables rate-limit (429) wait logging into the run log. */
  runId?: string;
}): Promise<string> {
  const key = pool.pick();
  const ctx = opts.runId ? { runId: opts.runId, stage: "image" } : undefined;
  try {
    const body: Record<string, unknown> = { prompt: opts.prompt };
    if (opts.model) body.model = opts.model;
    if (opts.aspectRatio) body.aspectRatio = opts.aspectRatio;
    if (opts.resolution) body.resolution = opts.resolution;
    if (opts.imageUrls?.length) body.imageUrls = opts.imageUrls;

    const resp = await postJsonWithKey<JobCreatedResponse | MultiJobCreatedResponse>(
      "/images/generate",
      body,
      key,
      ctx
    );
    const id = "jobs" in resp ? resp.jobs[0].id : resp.id;
    jobKeyMap.set(id, key);
    return id;
  } catch (e) {
    pool.release(key);
    throw e;
  }
}

// ── Videos ──────────────────────────────────────────────────────────────────

/**
 * Video: create a job. Supports:
 *  - text-to-video (prompt only)
 *  - image-to-video via imageJobId (reuses a previous /images/generate job)
 *  - image-to-video via imageUrls (external URLs)
 *
 * Critical: when imageJobId is provided, the video job MUST be created using
 * the same API key that created the image job. Otherwise 69labs returns 403
 * (the image belongs to a different account).
 */
export async function createVideoJob(opts: {
  prompt: string;
  model?: string;
  aspectRatio?: string;
  duration?: string;
  imageJobId?: string;
  imageUrls?: string[];
  mute?: boolean;
  /** Optional — enables rate-limit (429) wait logging into the run log. */
  runId?: string;
}): Promise<string> {
  // Pick a key — but if we're chaining off an existing image job, reuse its key
  let key: string;
  if (opts.imageJobId && jobKeyMap.has(opts.imageJobId)) {
    key = jobKeyMap.get(opts.imageJobId)!;
    pool.acquireSpecific(key);
  } else {
    key = pool.pick();
  }
  const ctx = opts.runId ? { runId: opts.runId, stage: "animate" } : undefined;

  try {
    const body: Record<string, unknown> = { prompt: opts.prompt };
    if (opts.model) body.model = opts.model;
    if (opts.aspectRatio) body.aspectRatio = opts.aspectRatio;
    if (opts.duration) body.duration = opts.duration;
    body.mute = opts.mute ?? true;
    if (opts.imageJobId) body.imageJobId = opts.imageJobId;
    else if (opts.imageUrls && opts.imageUrls.length) body.imageUrls = opts.imageUrls;

    const resp = await postJsonWithKey<JobCreatedResponse | MultiJobCreatedResponse>(
      "/videos/generate",
      body,
      key,
      ctx
    );
    const id = "jobs" in resp ? resp.jobs[0].id : resp.id;
    jobKeyMap.set(id, key);
    return id;
  } catch (e) {
    pool.release(key);
    throw e;
  }
}

// ── Polling / download / cancel ─────────────────────────────────────────────

/** Polls a job until COMPLETED or FAILED. Uses the key that created the job. */
export async function pollJob(
  kind: JobKind,
  jobId: string,
  runId: string,
  stage: string,
  level: LogLevel = "debug",
  opts: { model?: string | null; timeoutMs?: number; intervalMs?: number } = {}
): Promise<void> {
  const key = keyFor(jobId);
  const start = Date.now();
  const timeoutMs = opts.timeoutMs ?? pollTimeoutMs(kind, opts.model);
  const intervalMs = opts.intervalMs ?? pollIntervalMs(kind);
  let nextHeartbeatAt = start + 60_000;
  while (true) {
    checkCancelled(runId);
    const r = await fetch(`${BASE}/${kind}/status/${jobId}`, { headers: authHeadersFor(key) });
    checkCancelled(runId);
    if (!r.ok) {
      // A 429 on the status endpoint is transient — back off and keep polling
      // rather than failing the job.
      if (r.status === 429) {
        const waitMs = retryWaitMs(r.headers.get("retry-after"), 1, {
          baseMs: intervalMs * 4,
          maxMs: 60_000,
        });
        await sleep(waitMs, runId);
        continue;
      }
      throw new Error(`69labs status ${kind}/${jobId} ${r.status}: ${(await r.text()).slice(0, 200)}`);
    }
    const json = (await r.json()) as {
      status: JobStatus;
      userMessage?: string | null;
      errorCode?: string;
      errorMessage?: string;
      [k: string]: unknown;
    };
    if (level !== "debug") {
      log(runId, level, `${kind} ${jobId.slice(0, 8)} → ${json.status}`, { stage });
    }
    if (json.status === "COMPLETED") return;
    if (json.status === "FAILED" || json.status === "CANCELLED" || json.status === "CENSORED") {
      // `userMessage` is often generic ("This job failed to complete. Please try again.").
      // Surface every other field the response carries — errorCode / errorMessage and
      // anything else — because that is where the real diagnostic lives.
      const parts: string[] = [];
      if (json.userMessage) parts.push(String(json.userMessage));
      if (json.errorMessage) parts.push(String(json.errorMessage));
      if (json.errorCode) parts.push(`(${json.errorCode})`);
      const seen = new Set(["status", "userMessage", "errorMessage", "errorCode"]);
      const extras: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(json)) if (!seen.has(k)) extras[k] = v;
      if (Object.keys(extras).length > 0) parts.push(JSON.stringify(extras).slice(0, 800));
      throw new Error(
        `69labs ${kind} job ${jobId} ${json.status}${parts.length ? `: ${parts.join(" | ")}` : ""}`
      );
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`69labs ${kind} job ${jobId} exceeded ${Math.round(timeoutMs / 60_000)}m polling timeout`);
    }
    if (Date.now() >= nextHeartbeatAt) {
      const elapsedMs = Date.now() - start;
      log(
        runId,
        "debug",
        `${kind} ${jobId.slice(0, 8)} still ${json.status} after ${Math.round(elapsedMs / 1000)}s (timeout ${Math.round(timeoutMs / 1000)}s)`,
        { stage }
      );
      nextHeartbeatAt = Date.now() + 60_000;
    }
    await sleep(intervalMs, runId);
  }
}

/** Best-effort job cancellation. Releases the key slot. */
export async function cancelJob(kind: JobKind, jobId: string): Promise<boolean> {
  const key = keyFor(jobId);
  try {
    const r = await fetch(`${BASE}/${kind}/cancel/${jobId}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
    });
    return r.ok;
  } catch {
    return false;
  } finally {
    releaseJob(jobId);
  }
}

/** Downloads a completed job's output. Releases the key slot. */
export async function downloadJob(
  kind: JobKind,
  jobId: string,
  outPath: string,
  opts: { keepBindingOnSuccess?: boolean } = {}
): Promise<void> {
  const key = keyFor(jobId);
  let downloaded = false;
  try {
    const r = await fetch(`${BASE}/${kind}/download/${jobId}`, {
      headers: { Authorization: `Bearer ${key}` },
      redirect: "follow",
    });
    if (!r.ok) {
      throw new Error(`69labs download ${kind}/${jobId} ${r.status}: ${(await r.text()).slice(0, 200)}`);
    }
    const buf = Buffer.from(await r.arrayBuffer());
    fs.writeFileSync(outPath, buf);
    downloaded = true;
  } finally {
    if (downloaded && opts.keepBindingOnSuccess) {
      pool.release(key);
    } else {
      releaseJob(jobId);
    }
  }
}

async function sleep(ms: number, runId?: string) {
  const stepMs = runId ? 1000 : ms;
  let remaining = ms;
  while (remaining > 0) {
    if (runId) {
      try {
        checkCancelled(runId);
      } catch (e) {
        throw e instanceof CancelledError ? e : new CancelledError(`Run ${runId} cancelled`);
      }
    }
    await new Promise((r) => setTimeout(r, Math.min(stepMs, remaining)));
    remaining -= stepMs;
  }
  if (runId) checkCancelled(runId);
}

function fallbackRuntime(keyCount: number): Labs69RuntimeLimits {
  return {
    source: "settings",
    keyCount,
    imagePerKey: positiveInt(getSetting("IMAGE_CONCURRENCY")) ?? 7,
    videoPerKey: positiveInt(getSetting("ANIMATION_CONCURRENCY")) ?? 5,
    ttsPerKey: positiveInt(getSetting("TTS_CONCURRENCY")) ?? 3,
    imageModels: [],
    videoModels: [],
  };
}

interface ParsedModelsResponse {
  imageSlots?: number;
  videoSlots?: number;
  ttsSlots?: number;
  imageRemainingMonthly?: number;
  videoRemainingMonthly?: number;
  imageModels: string[];
  videoModels: string[];
}

function parseModelsResponse(json: Record<string, unknown>): ParsedModelsResponse {
  const images = readSection(json.images);
  const videos = readSection(json.videos);
  const tts = readSection(json.tts);
  return {
    imageSlots: positiveInt(images?.limits?.maxConcurrentJobs) ?? undefined,
    videoSlots: positiveInt(videos?.limits?.maxConcurrentJobs) ?? undefined,
    ttsSlots: positiveInt(tts?.limits?.maxConcurrentJobs) ?? undefined,
    imageRemainingMonthly: readMonthlyRemaining(images),
    videoRemainingMonthly: readMonthlyRemaining(videos),
    imageModels: readModelIds(images),
    videoModels: readModelIds(videos),
  };
}

function mergeRuntime(
  keyCount: number,
  live: ParsedModelsResponse[],
  fallback: Labs69RuntimeLimits
): Labs69RuntimeLimits {
  const imageSlots = live.map((r) => r.imageSlots ?? fallback.imagePerKey);
  const videoSlots = live.map((r) => r.videoSlots ?? fallback.videoPerKey);
  const ttsSlots = live.map((r) => r.ttsSlots ?? fallback.ttsPerKey);
  return {
    source: "live",
    keyCount,
    imagePerKey: Math.max(1, Math.min(...imageSlots)),
    videoPerKey: Math.max(1, Math.min(...videoSlots)),
    ttsPerKey: Math.max(1, Math.min(...ttsSlots)),
    imageRemainingMonthly: sumKnown(live.map((r) => r.imageRemainingMonthly)),
    videoRemainingMonthly: sumKnown(live.map((r) => r.videoRemainingMonthly)),
    imageModels: [...new Set(live.flatMap((r) => r.imageModels))],
    videoModels: [...new Set(live.flatMap((r) => r.videoModels))],
  };
}

function readSection(value: unknown): ModelsSection | undefined {
  return value && typeof value === "object" ? (value as ModelsSection) : undefined;
}

function readLimitCapability(value: unknown): Labs69CapabilitySlots | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  const limits = row.limits && typeof row.limits === "object" ? (row.limits as Record<string, unknown>) : {};
  const hourlyUsage = row.hourlyUsage && typeof row.hourlyUsage === "object" ? (row.hourlyUsage as Record<string, unknown>) : {};
  const monthlyUsage = row.monthlyUsage && typeof row.monthlyUsage === "object" ? (row.monthlyUsage as Record<string, unknown>) : {};
  return {
    enabled: row.enabled !== false,
    maxConcurrentJobs: positiveInt(limits.maxConcurrentJobs) ?? undefined,
    activeJobs: nonNegativeInt(limits.activeJobs) ?? 0,
    remainingJobs: nonNegativeInt(limits.remainingJobs) ?? undefined,
    priorityLevel: positiveInt(limits.priorityLevel) ?? undefined,
    maxPerGeneration: positiveInt(limits.maxPerGeneration) ?? undefined,
    hourlyRemaining: nonNegativeInt(hourlyUsage.remaining) ?? undefined,
    monthlyRemaining: nonNegativeInt(monthlyUsage.remaining) ?? undefined,
  };
}

function nonNegativeInt(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.floor(n);
}

function mergeCapabilitySlots(rows: Array<Labs69CapabilitySlots | undefined>): Labs69CapabilitySlots | undefined {
  const known = rows.filter((r): r is Labs69CapabilitySlots => Boolean(r));
  if (known.length === 0) return undefined;
  const sum = (pick: (r: Labs69CapabilitySlots) => number | undefined): number | undefined => {
    const values = known.map(pick).filter((n): n is number => typeof n === "number");
    return values.length > 0 ? values.reduce((a, b) => a + b, 0) : undefined;
  };
  const min = (pick: (r: Labs69CapabilitySlots) => number | undefined): number | undefined => {
    const values = known.map(pick).filter((n): n is number => typeof n === "number");
    return values.length > 0 ? Math.min(...values) : undefined;
  };
  return {
    enabled: known.some((r) => r.enabled),
    maxConcurrentJobs: sum((r) => r.maxConcurrentJobs),
    activeJobs: sum((r) => r.activeJobs),
    remainingJobs: sum((r) => r.remainingJobs),
    priorityLevel: min((r) => r.priorityLevel),
    maxPerGeneration: min((r) => r.maxPerGeneration),
    hourlyRemaining: sum((r) => r.hourlyRemaining),
    monthlyRemaining: sum((r) => r.monthlyRemaining),
  };
}

function readMonthlyRemaining(section: ModelsSection | undefined): number | undefined {
  const usage = section?.usage;
  const monthly = usage?.monthly && typeof usage.monthly === "object" ? (usage.monthly as Record<string, unknown>) : undefined;
  return (
    positiveInt(section?.monthlyRemaining) ??
    positiveInt(section?.monthlyUsageRemaining) ??
    positiveInt(section?.remainingMonthly) ??
    positiveInt(usage?.monthlyRemaining) ??
    positiveInt(usage?.remainingMonthly) ??
    positiveInt(monthly?.remaining) ??
    undefined
  );
}

function readModelIds(section: ModelsSection | undefined): string[] {
  if (!Array.isArray(section?.models)) return [];
  return section.models
    .map((m) => {
      if (typeof m === "string") return m;
      if (!m || typeof m !== "object") return null;
      const row = m as Record<string, unknown>;
      const id = row.id ?? row.modelId ?? row.model ?? row.name;
      return typeof id === "string" && id.trim() ? id.trim() : null;
    })
    .filter((id): id is string => Boolean(id));
}

function sumKnown(values: Array<number | undefined>): number | undefined {
  const known = values.filter((v): v is number => typeof v === "number");
  return known.length > 0 ? known.reduce((a, b) => a + b, 0) : undefined;
}

function providerLabel(path: string): string {
  if (path.startsWith("/videos")) return "video";
  if (path.startsWith("/images")) return "image";
  if (path.startsWith("/tts") || path.startsWith("/voice-clones")) return "voice";
  return "provider";
}
