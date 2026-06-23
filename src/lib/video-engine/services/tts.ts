import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getSetting } from "../settings";
import { log } from "../logger";
import type { Scene } from "./scene-split";
import { createTtsJob, pollJob, downloadJob, cancelJob, releaseJob } from "./labs69";
import { probeDurationSafe, concatAudioFiles } from "./video-assemble";
import { CancelledError, checkCancelled, isCancelled, registerJob, unregisterJob } from "../cancellation";
import { pickVoiceId } from "../voice-resolve";
import { chunkTextByNarrationUnits } from "../text-chunking";
import type { LimitFunction } from "../plimit";
import { runOrderedLimited } from "../ordered-limiter";
import { sanitizeMediaErrorMessage } from "../media-errors";

export interface TtsResult {
  /** Path to the mp3 file. */
  filePath: string;
  /** Audio duration in seconds, measured via ffprobe. */
  durationSec: number;
}

/**
 * Synthesizes one scene's narration.
 *
 * Default provider is 69labs routing to ElevenLabs. The same LABS69_API_KEY
 * that powers image/video jobs also covers voiceover, so there is no separate
 * voiceover account to manage. Alternatives stay available via the TTS_PROVIDER
 * setting: `69labs`, `openai`, and legacy `minimax`.
 *
 * Each file is sceneN.mp3 in the scene directory.
 *
 * `options.voiceOverride` — when a channel profile sets its own voice id, the
 * pipeline passes it here so that channel's runs use that voice instead of the
 * global TTS_VOICE_ID setting. Empty/null → use the global setting.
 */
export interface TtsOptions {
  /** Per-channel voice id — wins over the global TTS_VOICE_ID setting. */
  voiceOverride?: string | null;
  /** Per-channel voice speed — wins over the global TTS_SPEED setting. */
  speedOverride?: number | null;
  /** Per-channel voice provider for the 69labs path. Unsupported legacy values are treated as ElevenLabs. */
  voiceProviderOverride?: string | null;
  /** Per-channel ElevenLabs tuning — each wins over its global TTS_* setting. */
  stabilityOverride?: number | null;
  similarityOverride?: number | null;
  voiceStyleOverride?: number | null;
}

/** Dispatch one TTS request to the configured provider, writing to `filePath`. */
async function dispatchTts(runId: string, text: string, filePath: string, options: TtsOptions) {
  const provider = (getSetting("TTS_PROVIDER") || "69labs").toLowerCase();
  if (provider === "minimax") {
    await minimaxTts(runId, text, filePath, options.voiceOverride, options.speedOverride);
  } else if (provider === "69labs") {
    await labs69Tts(runId, text, filePath, options);
  } else if (provider === "openai") {
    await openaiTts(text, filePath, options.voiceOverride);
  } else {
    throw new Error(`Unknown TTS provider: ${provider}`);
  }
}

export async function synthesizeScene(
  runId: string,
  scene: Scene,
  outDir: string,
  options: TtsOptions = {}
): Promise<TtsResult> {
  const fileName = `scene_${String(scene.index).padStart(3, "0")}.mp3`;
  const filePath = path.join(outDir, fileName);
  log(runId, "info", `TTS scene #${scene.index}`, { stage: "tts", data: { text: scene.text.slice(0, 80) } });
  checkCancelled(runId);
  await dispatchTts(runId, scene.text, filePath, options);
  const durationSec = await probeDurationSafe(filePath);
  log(runId, "success", `TTS done: ${fileName} (${durationSec.toFixed(1)}s)`, { stage: "tts" });
  return { filePath, durationSec };
}

/**
 * Continuous voiceover (Prompt 7): synthesize the ENTIRE script in one TTS call.
 * One call = one consistent voice/speed and no inter-scene seams. Writes to
 * `outPath` and returns its measured duration.
 */
export async function synthesizeFullScript(
  runId: string,
  text: string,
  outPath: string,
  options: TtsOptions = {}
): Promise<TtsResult> {
  if (fileReady(outPath)) {
    const durationSec = await probeDurationSafe(outPath);
    log(runId, "info", `Voiceover already exists: ${path.basename(outPath)} (${durationSec.toFixed(1)}s)`, { stage: "tts" });
    return { filePath: outPath, durationSec };
  }
  const provider = (getSetting("TTS_PROVIDER") || "69labs").toLowerCase();
  log(runId, "info", `TTS full script (${provider}, ${text.length} chars)`, { stage: "tts" });
  checkCancelled(runId);
  await dispatchTts(runId, text, outPath, options);
  const durationSec = await probeDurationSafe(outPath);
  log(runId, "success", `Voiceover done: ${path.basename(outPath)} (${durationSec.toFixed(1)}s)`, { stage: "tts" });
  return { filePath: outPath, durationSec };
}

function fileReady(filePath: string): boolean {
  try {
    return fs.statSync(filePath).size > 0;
  } catch {
    return false;
  }
}

/**
 * Continuous voiceover for the hybrid TAIL: one consistent voice over the whole
 * tail, NO per-scene editing. Long text is split at sentence boundaries into
 * chunks (default ≤ 9000 chars — comfortably under provider limits), each
 * synthesized separately and concatenated, so a 1–2 hour tail still works in a
 * single logical voiceover. Short tails are a single call.
 */
export async function synthesizeContinuous(
  runId: string,
  text: string,
  outPath: string,
  options: TtsOptions = {},
  scheduling: number | { maxChars?: number; limitTts?: LimitFunction } = 9000
): Promise<TtsResult> {
  const maxChars = typeof scheduling === "number" ? scheduling : scheduling.maxChars ?? 9000;
  const limitTts = typeof scheduling === "number" ? undefined : scheduling.limitTts;
  if (fileReady(outPath)) {
    const durationSec = await probeDurationSafe(outPath);
    log(runId, "info", `Continuous voiceover already exists: ${path.basename(outPath)} (${(durationSec / 60).toFixed(1)} min)`, {
      stage: "tts",
    });
    return { filePath: outPath, durationSec };
  }

  const clean = text.trim();
  if (clean.length <= maxChars) {
    return synthesizeFullScript(runId, clean, outPath, options);
  }

  const chunks = chunkTextByNarrationUnits(clean, { maxChars });

  log(runId, "info", `Continuous tail voiceover: ${clean.length} chars → ${chunks.length} chunks`, {
    stage: "tts",
  });

  const partPaths = await runOrderedLimited(
    chunks,
    async (chunk, i) => {
      const partPath = outPath.replace(/\.mp3$/i, `_part${String(i).padStart(3, "0")}.mp3`);
      if (fileReady(partPath)) {
        log(runId, "info", `Tail voiceover chunk ${i + 1}/${chunks.length} already exists`, { stage: "tts" });
        return partPath;
      }
      checkCancelled(runId);
      await dispatchTts(runId, chunk, partPath, options);
      log(runId, "info", `Tail voiceover chunk ${i + 1}/${chunks.length} done`, { stage: "tts" });
      return partPath;
    },
    limitTts
  );

  checkCancelled(runId);
  await concatAudioFiles(partPaths, outPath, runId, "tail voiceover concat");
  for (const p of partPaths) {
    try { fs.rmSync(p, { force: true }); } catch {}
  }
  const durationSec = await probeDurationSafe(outPath);
  log(runId, "success", `Tail voiceover done: ${path.basename(outPath)} (${(durationSec / 60).toFixed(1)} min)`, {
    stage: "tts",
  });
  return { filePath: outPath, durationSec };
}

/** A channel profile's voice id wins over the global TTS_VOICE_ID setting. */
function resolveVoiceId(voiceOverride: string | null | undefined, fallback: string): string {
  return pickVoiceId({
    channel: voiceOverride,
    global: getSetting("TTS_VOICE_ID"),
    fallback,
  });
}

/**
 * 69labs MiniMax TTS — the primary voiceover engine for Late Media Editing Tool.
 *
 * The user picks a MiniMax catalog voice (e.g. "English_Comedian") or a cloned
 * voice in the 69labs dashboard → MiniMax, then pastes that voice id into
 * /settings (TTS_VOICE_ID). A channel profile can override it per channel.
 * MiniMax runs over the same 69labs gateway + multi-key pool as Grok video, so
 * the single LABS69_API_KEY covers both audio and video.
 *
 * Settings: TTS_VOICE_ID (voice), TTS_MODEL (default `speech-02-hd`),
 * TTS_SPEED (delivery rate), TTS_LANGUAGE_BOOST (pronunciation hint).
 */
async function minimaxTts(
  runId: string,
  text: string,
  outPath: string,
  voiceOverride?: string | null,
  speedOverride?: number | null
) {
  const voiceId = resolveVoiceId(voiceOverride, "");
  if (!voiceId) {
    throw new Error(
      "No MiniMax voice set — paste a voice id into /settings → TTS_VOICE_ID " +
        "(e.g. English_Comedian), or add one to the channel profile in /prompts"
    );
  }
  const modelId = getSetting("TTS_MODEL") || "speech-02-hd";

  // MiniMax delivery tuning. `speed` is clamped to a sane narration band (the
  // raw API allows 0.01–10); `languageBoost` sharpens pronunciation for the
  // script's language.
  const minimaxSettings: { speed?: number; languageBoost?: string } = {};
  const speed = speedOverride != null ? speedOverride : parseFloatOr(getSetting("TTS_SPEED"), NaN);
  if (!Number.isNaN(speed)) minimaxSettings.speed = clamp(speed, 0.5, 2);
  const languageBoost = getSetting("TTS_LANGUAGE_BOOST").trim();
  if (languageBoost) minimaxSettings.languageBoost = languageBoost;

  const jobId = await createTtsJob({
    text,
    voiceId,
    voiceProvider: "minimax",
    modelId,
    minimaxSettings,
    runId,
  });
  log(
    runId,
    "debug",
    `69labs MiniMax TTS job ${jobId.slice(0, 8)}… (${modelId} / ${voiceId}, ` +
      `speed=${minimaxSettings.speed ?? "default"}, lang=${minimaxSettings.languageBoost ?? "auto"})`,
    { stage: "tts" }
  );
  // MiniMax accepts the job even when the voice/model is invalid, then fails it
  // during processing — runTtsJob turns that into clear, actionable guidance.
  await runTtsJob(
    runId,
    jobId,
    outPath,
    `The MiniMax voice id "${voiceId}" or model "${modelId}" is likely not valid for this account.`
  );
}

/**
 * Poll + download a TTS job, with the per-run job registry (so Stop can cancel
 * the paid job) and cooperative cancellation woven through. Shared by every TTS
 * call site so the registration / release / cancel logic lives in one place.
 *
 *  - registers the job on entry, unregisters on exit (always)
 *  - checks for cancellation before polling and before download
 *  - on user-cancel: actively cancels the paid 69labs job, then throws CancelledError
 *  - on a real job FAILURE: frees the key slot pollJob holds and rethrows a clear
 *    "this voice failed — pick another or test it first" message
 */
async function runTtsJob(runId: string, jobId: string, outPath: string, voiceHint: string): Promise<void> {
  registerJob(runId, "tts", jobId);
  try {
    if (isCancelled(runId)) throw new CancelledError(`Run ${runId} cancelled`);
    try {
      await pollJob("tts", jobId, runId, "tts");
    } catch (e) {
      if (isCancelled(runId) || e instanceof CancelledError) throw e; // handled by outer catch
      // pollJob does NOT release the key slot on failure — do it here so a bad
      // voice doesn't permanently shrink the concurrency pool.
      releaseJob(jobId);
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        `This voice failed at TTS — pick another voice, or test it first with the "Test" button in the voice picker. ` +
          `${voiceHint} [${msg}]`
      );
    }
    if (isCancelled(runId)) throw new CancelledError(`Run ${runId} cancelled`);
    await downloadJob("tts", jobId, outPath); // releases the slot in its own finally
  } catch (e) {
    if (isCancelled(runId) || e instanceof CancelledError) {
      // Free the paid job + its slot, then surface a clean cancellation.
      await cancelJob("tts", jobId).catch(() => {});
      throw e instanceof CancelledError ? e : new CancelledError(`Run ${runId} cancelled`);
    }
    throw e;
  } finally {
    unregisterJob(runId, jobId);
  }
}

export type Labs69VoiceProvider = "elevenlabs" | "voice-clone" | "minimax";

const DEFAULT_ELEVENLABS_MODEL = "eleven_multilingual_v2";

/** Map a saved-voice provider string to a 69labs voiceProvider, defaulting to ElevenLabs. */
function normalizeVoiceProvider(p: string): Labs69VoiceProvider {
  const v = (p || "").toLowerCase().trim();
  return v === "voice-clone" || v === "minimax" ? v : "elevenlabs";
}

export function normalizeTtsVoiceProvider(provider: string): Labs69VoiceProvider {
  return normalizeVoiceProvider(provider);
}

function normalizeTtsModelId(voiceProvider: Labs69VoiceProvider): string | undefined {
  const rawModel = (getSetting("TTS_MODEL") || "").trim();
  if (voiceProvider === "minimax") return rawModel || "speech-02-hd";
  if (voiceProvider === "voice-clone") return undefined;
  return rawModel.toLowerCase().startsWith("eleven_") ? rawModel : DEFAULT_ELEVENLABS_MODEL;
}

const VOICE_SAMPLE_VALID_MS = 6 * 60 * 60 * 1000;
const VOICE_SAMPLE_FAILURE_MS = 5 * 60 * 1000;

type VoiceSampleValidationResult = { ok: true } | { ok: false; error: string };
export interface VoiceSampleValidationOptions {
  speedOverride?: number | null;
  stabilityOverride?: number | null;
  similarityOverride?: number | null;
  voiceStyleOverride?: number | null;
}
const voiceSampleValidationCache = new Map<
  string,
  {
    expiresAt: number;
    promise?: Promise<VoiceSampleValidationResult>;
    result?: VoiceSampleValidationResult;
  }
>();

function voiceSampleJobSettings(
  voiceProvider: Labs69VoiceProvider,
  options: VoiceSampleValidationOptions = {}
) {
  const modelId = normalizeTtsModelId(voiceProvider);
  const splitTypeRaw = (getSetting("TTS_SPLIT_TYPE") || "paragraphs").toLowerCase();
  const splitType: "smart" | "paragraphs" | "max_length" =
    splitTypeRaw === "paragraphs" || splitTypeRaw === "max_length" ? splitTypeRaw : "smart";
  const speed = options.speedOverride != null ? options.speedOverride : parseFloatOr(getSetting("TTS_SPEED"), NaN);

  const voiceSettings: {
    stability?: number;
    similarityBoost?: number;
    speed?: number;
    style?: number;
    useSpeakerBoost?: boolean;
  } = {};
  if (voiceProvider === "elevenlabs") {
    const stability =
      options.stabilityOverride != null ? options.stabilityOverride : parseFloatOr(getSetting("TTS_STABILITY"), NaN);
    const similarity =
      options.similarityOverride != null ? options.similarityOverride : parseFloatOr(getSetting("TTS_SIMILARITY_BOOST"), NaN);
    const style =
      options.voiceStyleOverride != null ? options.voiceStyleOverride : parseFloatOr(getSetting("TTS_STYLE"), NaN);
    const speakerBoost = getSetting("TTS_USE_SPEAKER_BOOST");

    if (!Number.isNaN(stability)) voiceSettings.stability = clamp(stability, 0, 1);
    if (!Number.isNaN(similarity)) voiceSettings.similarityBoost = clamp(similarity, 0, 1);
    if (!Number.isNaN(speed)) voiceSettings.speed = clamp(speed, 0.7, 1.2);
    if (!Number.isNaN(style)) voiceSettings.style = clamp(style, 0, 1);
    if (speakerBoost === "1") voiceSettings.useSpeakerBoost = true;
    else if (speakerBoost === "0") voiceSettings.useSpeakerBoost = false;
  }

  const minimaxSettings: { speed?: number; languageBoost?: string } = {};
  if (voiceProvider === "minimax") {
    if (!Number.isNaN(speed)) minimaxSettings.speed = clamp(speed, 0.5, 2);
    const languageBoost = getSetting("TTS_LANGUAGE_BOOST").trim();
    if (languageBoost) minimaxSettings.languageBoost = languageBoost;
  }

  const autoPauseEnabled = getSetting("TTS_AUTO_PAUSE") === "1";
  const autoPauseDuration = parseFloatOr(getSetting("TTS_PAUSE_DURATION"), NaN);
  const autoPauseFrequency = parseFloatOr(getSetting("TTS_PAUSE_FREQUENCY"), NaN);

  return {
    modelId,
    splitType,
    voiceSettings,
    minimaxSettings,
    autoPauseEnabled,
    autoPauseDuration: !Number.isNaN(autoPauseDuration) ? clamp(autoPauseDuration, 0.1, 30) : undefined,
    autoPauseFrequency: !Number.isNaN(autoPauseFrequency) ? clamp(autoPauseFrequency, 1, 100) : undefined,
  };
}

function voiceSampleValidationKey(
  voiceId: string,
  provider: string,
  options: VoiceSampleValidationOptions = {}
): string {
  const voiceProvider = normalizeVoiceProvider(provider);
  const settings = voiceSampleJobSettings(voiceProvider, options);
  return JSON.stringify({
    provider: voiceProvider,
    voiceId: voiceId.trim(),
    model: settings.modelId ?? "",
    splitType: settings.splitType,
    voiceSettings: settings.voiceSettings,
    minimaxSettings: settings.minimaxSettings,
    autoPauseEnabled: settings.autoPauseEnabled,
    autoPauseDuration: settings.autoPauseDuration,
    autoPauseFrequency: settings.autoPauseFrequency,
  });
}

/**
 * Validate a selected 69labs voice with the same tiny sample used by the manual
 * voice-test path. Results are cached so a good voice does not add latency to
 * every run start, while a bad voice blocks future runs before paid video work.
 */
export async function validateTtsVoiceSample(
  voiceId: string,
  provider: string,
  options: VoiceSampleValidationOptions = {}
): Promise<VoiceSampleValidationResult> {
  const vid = voiceId.trim();
  if (!vid) return { ok: false, error: "Voice ID is required." };

  const key = voiceSampleValidationKey(vid, provider, options);
  const now = Date.now();
  const cached = voiceSampleValidationCache.get(key);
  if (cached && cached.expiresAt > now) {
    if (cached.result) return cached.result;
    if (cached.promise) return cached.promise;
  }

  const promise = synthesizeVoiceSample(vid, provider, "Voice check.", options)
    .then<VoiceSampleValidationResult>(() => ({ ok: true }))
    .catch<VoiceSampleValidationResult>((error) => ({
      ok: false,
      error: sanitizeMediaErrorMessage(error instanceof Error ? error.message : String(error)),
    }))
    .then((result) => {
      voiceSampleValidationCache.set(key, {
        expiresAt: Date.now() + (result.ok ? VOICE_SAMPLE_VALID_MS : VOICE_SAMPLE_FAILURE_MS),
        result,
      });
      return result;
    });

  voiceSampleValidationCache.set(key, {
    expiresAt: now + VOICE_SAMPLE_FAILURE_MS,
    promise,
  });
  return promise;
}

/**
 * Synthesize a tiny sample with a specific voice for the "Test voice" button.
 * Returns the mp3 bytes. Throws with a clear message when the voice fails — the
 * whole point is to catch a bad voice BEFORE it burns a paid run. User-initiated
 * only (one short clip), so it's a deliberate, minimal-cost generation.
 */
export async function synthesizeVoiceSample(
  voiceId: string,
  provider: string,
  sampleText = "This is a test of the selected voice.",
  options: VoiceSampleValidationOptions = {}
): Promise<Buffer> {
  const vid = voiceId.trim();
  if (!vid) throw new Error("Voice ID is required to test a voice");
  const voiceProvider = normalizeVoiceProvider(provider);
  const settings = voiceSampleJobSettings(voiceProvider, options);
  const tmpPath = path.join(os.tmpdir(), `voice-test-${randomUUID()}.mp3`);

  const jobId = await createTtsJob({
    text: sampleText,
    voiceId: vid,
    voiceProvider,
    modelId: settings.modelId,
    splitType: settings.splitType,
    voiceSettings: settings.voiceSettings,
    minimaxSettings: settings.minimaxSettings,
    autoPauseEnabled: settings.autoPauseEnabled,
    autoPauseDuration: settings.autoPauseDuration,
    autoPauseFrequency: settings.autoPauseFrequency,
    runId: "voice-test",
  });
  try {
    // "voice-test" is never in the cancel registry, so this just polls +
    // downloads, and (per the shared helper) frees the key slot if it fails.
    await runTtsJob("voice-test", jobId, tmpPath, `The ${voiceProvider} voice id "${vid}" may be invalid for this account or 69labs plan.`);
    return fs.readFileSync(tmpPath);
  } finally {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      /* temp file may not exist if the job never produced output */
    }
  }
}

/**
 * 69labs TTS via ElevenLabs. Saved clone voices and legacy MiniMax catalog
 * voices are still accepted, while unsupported provider labels route to
 * ElevenLabs so stale local settings cannot trigger a different TTS engine.
 */
async function labs69Tts(runId: string, text: string, outPath: string, options: TtsOptions = {}) {
  const { voiceOverride, voiceProviderOverride } = options;
  const voiceProvider = normalizeVoiceProvider(
    (voiceProviderOverride && voiceProviderOverride.trim()) ||
    getSetting("TTS_VOICE_PROVIDER") ||
    "elevenlabs"
  );
  const voiceId = resolveVoiceId(voiceOverride, "");
  if (!voiceId) {
    const providerLabel =
      voiceProvider === "voice-clone" ? "voice clone" : voiceProvider === "minimax" ? "MiniMax" : "ElevenLabs";
    throw new Error(
      `No ${providerLabel} voice selected. Pick a voice in Settings or the channel profile before starting a run.`
    );
  }
  const settings = voiceSampleJobSettings(voiceProvider, options);

  const jobId = await createTtsJob({
    text,
    voiceId,
    voiceProvider,
    modelId: settings.modelId,
    splitType: settings.splitType,
    voiceSettings: settings.voiceSettings,
    minimaxSettings: settings.minimaxSettings,
    autoPauseEnabled: settings.autoPauseEnabled,
    autoPauseDuration: settings.autoPauseDuration,
    autoPauseFrequency: settings.autoPauseFrequency,
    runId,
  });
  const speed = settings.voiceSettings.speed ?? settings.minimaxSettings.speed ?? "default";
  const pause = settings.autoPauseEnabled ? `${settings.autoPauseDuration ?? "default"}s` : "off";
  log(runId, "debug", `69labs TTS job ${jobId.slice(0, 8)}… (${voiceProvider}/${voiceId}, speed=${speed}, pause=${pause})`, { stage: "tts" });
  // A bad saved/cloned voice id is the most common failure here — runTtsJob
  // turns it into clear guidance and tracks the job for Stop.
  await runTtsJob(
    runId,
    jobId,
    outPath,
    `The ${voiceProvider} voice id "${voiceId}" may be invalid for this account or 69labs plan.`
  );
}

function parseFloatOr(s: string, fallback: number): number {
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : fallback;
}
function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

async function openaiTts(text: string, outPath: string, voiceOverride?: string | null) {
  const apiKey = getSetting("OPENAI_API_KEY");
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  const model = getSetting("TTS_MODEL") || "gpt-4o-mini-tts";
  const voice = resolveVoiceId(voiceOverride, "alloy");

  const resp = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, voice, input: text, format: "mp3" }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`OpenAI TTS ${resp.status}: ${body.slice(0, 300)}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(outPath, buf);
}
