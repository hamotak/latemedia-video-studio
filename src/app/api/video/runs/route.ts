import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import db from "@/lib/video-engine/db";
import { ensureInit } from "@/lib/video-engine/init";
import { isRunWorkerActive, startRunPipeline } from "@/lib/video-engine/pipeline";
import { sanitizeFolderName, pickAvailableFolderName } from "@/lib/video-engine/run-paths";
import { getPromptPreset } from "@/lib/video-engine/prompts";
import { resolveChannelStockFolder, resolveHybridFreshMinutes } from "@/lib/video-engine/channel-stock";
import { getSetting } from "@/lib/video-engine/settings";
import { tryParseJson, isJsonObject } from "@/lib/video-engine/json-body";
import { readRunExportState } from "@/lib/video-engine/run-export-state";
import { driveFileLink, driveFolderLink } from "@/lib/video-engine/services/drive-workspace";
import { mirrorVideoRun } from "@/lib/video-engine/supabase-video-mirror";
import { log } from "@/lib/video-engine/logger";
import { requireVideoChannelAccess } from "@/lib/video-access";
import { loadAppSettingsIntoCache } from "@/lib/app-settings-store";
import { loadProviderSecretsIntoCache } from "@/lib/provider-secrets-store";
import { ensurePresetForChannel } from "@/lib/video-bridge";
import { type Channel } from "@/lib/channels-store";
import { runPreflight } from "@/lib/video-engine/preflight";
import {
  normalizeTtsVoiceProvider,
  validateTtsVoiceSample,
  type VoiceSampleValidationOptions,
} from "@/lib/video-engine/services/tts";

export const runtime = "nodejs";

const insertRun = db.prepare(
  "INSERT INTO runs (id, title, folder_name, channel_id, status, script, config_json) VALUES (?, ?, ?, ?, 'pending', ?, ?)"
);
const setReuseMap = db.prepare(
  "UPDATE runs SET reuse_map_json = ? WHERE id = ?"
);
const setPresetSnapshot = db.prepare(
  "UPDATE runs SET preset_id = ?, preset_name = ?, preset_content = ?, preset_animation_motion = ?, preset_image_prompt = ?, preset_voice_id = ?, preset_video_style = ?, preset_voice_speed = ?, preset_scene_pause = ?, preset_voice_provider = ?, preset_style_preset_id = ?, preset_video_model = ?, preset_aspect_ratio = ?, preset_voice_stability = ?, preset_voice_similarity_boost = ?, preset_voice_style = ?, preset_stock_folder = ?, preset_hybrid_fresh_minutes = ? WHERE id = ?"
);
const listRunsByActiveProfile = db.prepare(
  "SELECT id, title, folder_name, status, created_at, updated_at, output_path, preset_id, preset_name, config_json, drive_clips_folder_id, drive_final_video_id, drive_synced_at FROM runs WHERE preset_id = ? OR preset_name = ? ORDER BY created_at DESC LIMIT 50"
);

function ensureChannelPresetId(channel: Channel | null): number | null {
  if (!channel) return null;
  return ensurePresetForChannel({
    id: channel.id,
    name: channel.name,
    handle: channel.handle,
    avatar_url: channel.avatar_url,
    description: channel.description,
    video_style: channel.video_style,
    voice_id: channel.voice_id,
    voice_provider: channel.voice_provider,
    stock_folder: channel.stock_folder,
  });
}

function parsePositiveId(value: string | null | undefined, label: string): number | null | NextResponse {
  if (value == null || value.trim() === "") return null;
  const id = Number(value);
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: `Invalid ${label}` }, { status: 400 });
  }
  return id;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const requestedChannelId = parsePositiveId(url.searchParams.get("channelId"), "channelId");
  if (requestedChannelId instanceof NextResponse) return requestedChannelId;
  const gate = await requireVideoChannelAccess(requestedChannelId);
  if (!gate) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  ensureInit();
  const channel = gate.channel;
  const activePresetId = ensureChannelPresetId(channel);
  if (!activePresetId) return NextResponse.json([]);
  const channelName = channel?.name ?? "";
  const rawPresetId = url.searchParams.get("presetId");
  if (rawPresetId != null && rawPresetId.trim() !== "") {
    const presetId = Number(rawPresetId);
    if (!Number.isFinite(presetId) || presetId <= 0 || presetId !== activePresetId) {
      return NextResponse.json({ error: "Invalid presetId" }, { status: 400 });
    }
  }
  const rows = listRunsByActiveProfile.all(activePresetId, channelName) as Record<string, unknown>[];
  return NextResponse.json(
    rows.map((run) => {
      const id = String(run.id ?? "");
      const dbStatus = String(run.status ?? "");
      const config = tryParseJson(String(run.config_json ?? ""));
      const mode =
        config.ok && isJsonObject(config.value) && typeof config.value.mode === "string"
          ? config.value.mode
          : null;
      const publicRun = { ...run };
      delete publicRun.config_json;
      const workerActive = isRunWorkerActive(id);
      const status = workerActive
        ? "running"
        : (dbStatus === "running" || dbStatus === "pending") && !run.output_path
          ? "paused"
          : dbStatus;
      const needsRepair = readRunExportState(id, dbStatus).finalNeedsRepair;
      return {
        ...publicRun,
        mode,
        output_path: needsRepair ? null : run.output_path,
        finalVideoLink: driveFileLink(String(run.drive_final_video_id ?? "")) ?? null,
        clipsFolderLink: driveFolderLink(String(run.drive_clips_folder_id ?? "")) ?? null,
        driveStatus: {
          synced: !!run.drive_final_video_id || !!run.drive_clips_folder_id,
          syncedAt: run.drive_synced_at ?? null,
          finalVideoId: run.drive_final_video_id ?? null,
          clipsFolderId: run.drive_clips_folder_id ?? null,
        },
        db_status: dbStatus,
        status,
        worker_active: workerActive,
        needs_recovery: status === "paused" || needsRepair,
        needs_repair: needsRepair,
      };
    })
  );
}

interface CreateRunBody {
  channelId?: number | null;
  title?: string;
  script?: string;
  /** Optional: scene_index → drive_file_id. Pipeline downloads those instead of generating. */
  reuseMap?: Record<string, string>;
  /** Optional: Prompt Preset id (from /prompts presets). Snapshot is stored on the run. */
  presetId?: number | null;
  /** Optional: true = pipeline auto-searches the library; false = manual reuseMap only. */
  autoReuse?: boolean;
  /** Generation mode: "hybrid" (fresh start + stock tail), "image" (fresh video intro + image tail). */
  mode?: string;
  /** Per-run override — fresh AI video minutes at the start (Hybrid / Image Cut). */
  hybridFreshMinutes?: number;
  /** Per-run override — Drive stock folder for Hybrid / Stock Cut. */
  stockFolder?: string;
}

function resolveVoiceConfig(preset: NonNullable<ReturnType<typeof getPromptPreset>>) {
  const ttsProvider = (getSetting("TTS_PROVIDER") || "69labs").trim().toLowerCase();
  const rawVoiceProvider = (
    (preset.voice_provider && preset.voice_provider.trim()) ||
    getSetting("TTS_VOICE_PROVIDER") ||
    "elevenlabs"
  );
  const voiceProvider =
    ttsProvider === "minimax" ? "minimax" : normalizeTtsVoiceProvider(rawVoiceProvider);
  const voiceId = (preset.voice_id || getSetting("TTS_VOICE_ID") || "").trim();
  return { ttsProvider, voiceProvider, voiceId };
}

function voiceProviderLabel(provider: string): string {
  if (provider === "minimax") return "MiniMax";
  if (provider === "voice-clone") return "voice clone";
  return "ElevenLabs";
}

function voiceConfigError(preset: NonNullable<ReturnType<typeof getPromptPreset>>): string | null {
  const { ttsProvider, voiceProvider, voiceId } = resolveVoiceConfig(preset);
  if (ttsProvider !== "69labs" && ttsProvider !== "minimax") return null;

  if (voiceId) return null;
  const providerLabel = voiceProviderLabel(ttsProvider === "minimax" ? "minimax" : voiceProvider);
  return `No ${providerLabel} voice selected. Pick a voice in Settings or the channel profile before starting a run.`;
}

async function voiceValidationError(preset: NonNullable<ReturnType<typeof getPromptPreset>>): Promise<string | null> {
  const { ttsProvider, voiceProvider, voiceId } = resolveVoiceConfig(preset);
  if (ttsProvider !== "69labs" && ttsProvider !== "minimax") return null;
  const provider = ttsProvider === "minimax" ? "minimax" : voiceProvider;
  if (!voiceId) return voiceConfigError(preset);

  const validationOptions: VoiceSampleValidationOptions = {
    speedOverride: preset.voice_speed,
    stabilityOverride: preset.voice_stability,
    similarityOverride: preset.voice_similarity_boost,
    voiceStyleOverride: preset.voice_style,
  };
  const result = await validateTtsVoiceSample(voiceId, provider, validationOptions);
  if (result.ok) return null;
  return `The selected ${voiceProviderLabel(provider)} voice could not be validated by 69labs. Pick another voice or use the voice Test button before starting a run. ${result.error}`;
}

async function hydrateRuntimeConfig(runId: string): Promise<void> {
  const results = await Promise.allSettled([
    loadProviderSecretsIntoCache(),
    loadAppSettingsIntoCache(),
  ]);
  const failed = results.find((result) => result.status === "rejected") as PromiseRejectedResult | undefined;
  if (failed) {
    const msg = failed.reason instanceof Error ? failed.reason.message : String(failed.reason);
    log(runId, "warn", `Run start could not refresh remote settings before preflight: ${msg.slice(0, 240)}`, {
      stage: "settings",
    });
  }
}

export async function POST(req: Request) {
  // Malformed JSON is a CLIENT error (400), not a server crash (500): parse the
  // raw text safely instead of letting `await req.json()` throw unhandled.
  const parsed = tryParseJson(await req.text());
  if (!parsed.ok || !isJsonObject(parsed.value)) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const body = parsed.value as CreateRunBody;
  const requestedChannelId =
    typeof body.channelId === "number" && Number.isFinite(body.channelId) && body.channelId > 0
      ? body.channelId
      : null;
  if (body.channelId != null && requestedChannelId == null) {
    return NextResponse.json({ error: "Invalid channelId" }, { status: 400 });
  }
  const gate = await requireVideoChannelAccess(requestedChannelId, { edit: true });
  if (!gate) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  await hydrateRuntimeConfig("video-run-start");
  ensureInit();
  const script = (body.script ?? "").trim();
  if (!script) {
    return NextResponse.json({ error: "script is empty" }, { status: 400 });
  }
  const activePresetId = ensureChannelPresetId(gate.channel);
  if (!activePresetId) {
    return NextResponse.json({ error: "Pick a channel before starting a video run." }, { status: 400 });
  }
  if (typeof body.presetId === "number" && body.presetId !== activePresetId) {
    return NextResponse.json({ error: "The selected video profile no longer matches the active channel." }, { status: 409 });
  }
  const preset = getPromptPreset(activePresetId);
  if (!preset) {
    return NextResponse.json({ error: "Channel not found" }, { status: 404 });
  }
  const voiceError = voiceConfigError(preset);
  if (voiceError) {
    return NextResponse.json({ error: voiceError, errorKind: "voice_required" }, { status: 400 });
  }
  const preflight = runPreflight({ voiceConfigured: true });
  if (!preflight.ready) {
    return NextResponse.json(
      {
        error: "Video generation is not ready. Fix the failed preflight checks before starting a run.",
        errorKind: "preflight_failed",
        preflight,
      },
      { status: 400 }
    );
  }
  const invalidVoice = await voiceValidationError(preset);
  if (invalidVoice) {
    return NextResponse.json({ error: invalidVoice, errorKind: "voice_invalid" }, { status: 400 });
  }
  const mode =
    body.mode == null || body.mode === ""
      ? "hybrid"
      : body.mode === "hybrid" || body.mode === "image"
        ? body.mode
        : null;
  if (!mode) {
    return NextResponse.json({ error: "Unsupported video mode. Use Hybrid or Image cut." }, { status: 400 });
  }
  const requestedHybridFresh =
    typeof body.hybridFreshMinutes === "number" && body.hybridFreshMinutes > 0
      ? body.hybridFreshMinutes
      : resolveHybridFreshMinutes(preset.hybrid_fresh_minutes, getSetting("HYBRID_FRESH_MINUTES"));
  const id = randomUUID();
  const baseFolderName = sanitizeFolderName(body.title ?? "", id.slice(0, 8));
  const folderName = pickAvailableFolderName(baseFolderName);

  const stockFolder = resolveChannelStockFolder(
    preset.name,
    typeof body.stockFolder === "string" && body.stockFolder.trim()
      ? body.stockFolder.trim()
      : preset.stock_folder
  );
  // Per-run config. autoReuse: true = pipeline auto-searches the Drive library
  // for reusable clips; false = use only the manually-picked reuseMap below.
  const config: Record<string, unknown> = {};
  if (typeof body.autoReuse === "boolean") config.autoReuse = body.autoReuse;
  config.mode = mode;
  insertRun.run(id, body.title ?? null, folderName, gate.channelId, script, JSON.stringify(config));

  // Persist reuseMap so the pipeline can read it without callers passing options.
  // Keys are normalized to strings — they already are in JSON, but TS allowed
  // Record<number, string> in some call sites.
  if (body.reuseMap && typeof body.reuseMap === "object") {
    const normalized: Record<string, string> = {};
    for (const [k, v] of Object.entries(body.reuseMap)) {
      if (typeof v === "string" && v.length > 0) normalized[String(k)] = v;
    }
    if (Object.keys(normalized).length > 0) {
      setReuseMap.run(JSON.stringify(normalized), id);
    }
  }

  // Snapshot the chosen channel profile onto the run row (with optional per-run overrides).
  setPresetSnapshot.run(
    preset.id,
    preset.name,
    preset.content,
    preset.animation_motion,
    preset.image_prompt,
    preset.voice_id,
    preset.video_style,
    preset.voice_speed,
    preset.scene_end_pause_seconds,
    preset.voice_provider,
    preset.style_preset_id,
    preset.video_model,
    preset.aspect_ratio,
    preset.voice_stability,
    preset.voice_similarity_boost,
    preset.voice_style,
    stockFolder,
    requestedHybridFresh,
    id
  );
  void mirrorVideoRun(id, {
    channelId: gate.channelId,
    createdBy: gate.user.id,
  }).catch((e) => {
    const message = e instanceof Error ? e.message : String(e);
    log(id, "warn", `Supabase metadata mirror failed: ${message}`, {
      stage: "supabase",
      data: { channelId: gate.channelId },
    });
  });

  // Start the local worker in the background. The worker registry prevents
  // duplicate starts if the UI retries quickly.
  startRunPipeline(id, script);

  return NextResponse.json({ id, folderName });
}
