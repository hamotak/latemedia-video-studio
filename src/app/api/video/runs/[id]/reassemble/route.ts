import { NextResponse } from "next/server";
import db from "@/lib/video-engine/db";
import { ensureInit } from "@/lib/video-engine/init";
import { startResumeRun, canResumeRun, retiredVideoModeError } from "@/lib/video-engine/pipeline";
import { runPreflight } from "@/lib/video-engine/preflight";
import { requireVideoRunAccess } from "@/lib/video-access";
import { loadAppSettingsIntoCache } from "@/lib/app-settings-store";
import { loadProviderSecretsIntoCache } from "@/lib/provider-secrets-store";
import { log } from "@/lib/video-engine/logger";
import { getSetting } from "@/lib/video-engine/settings";
import {
  normalizeTtsVoiceProvider,
  validateTtsVoiceSample,
  type VoiceSampleValidationOptions,
} from "@/lib/video-engine/services/tts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const getRunVoiceConfig = db.prepare(
  "SELECT preset_voice_id, preset_voice_provider, preset_voice_speed, preset_voice_stability, preset_voice_similarity_boost, preset_voice_style FROM runs WHERE id = ?"
);
const getRunConfig = db.prepare("SELECT config_json FROM runs WHERE id = ?");

async function hydrateRuntimeConfig(runId: string): Promise<void> {
  const results = await Promise.allSettled([
    loadProviderSecretsIntoCache(),
    loadAppSettingsIntoCache(),
  ]);
  const failed = results.find((result) => result.status === "rejected") as PromiseRejectedResult | undefined;
  if (failed) {
    const msg = failed.reason instanceof Error ? failed.reason.message : String(failed.reason);
    log(runId, "warn", `Resume could not refresh remote settings before start: ${msg.slice(0, 240)}`, {
      stage: "settings",
    });
  }
}

function resumeVoiceConfigured(runId: string): boolean {
  const ttsProvider = (getSetting("TTS_PROVIDER") || "69labs").trim().toLowerCase();
  if (ttsProvider !== "69labs" && ttsProvider !== "minimax") return true;

  const row = getRunVoiceConfig.get(runId) as
    | { preset_voice_id: string | null; preset_voice_provider: string | null }
    | undefined;

  return !!((row?.preset_voice_id ?? "").trim() || getSetting("TTS_VOICE_ID").trim());
}

function voiceProviderLabel(provider: string): string {
  if (provider === "minimax") return "MiniMax";
  if (provider === "voice-clone") return "voice clone";
  return "ElevenLabs";
}

function readRunMode(runId: string): string | null {
  const row = getRunConfig.get(runId) as { config_json: string | null } | undefined;
  if (!row?.config_json) return null;
  try {
    const parsed = JSON.parse(row.config_json) as { mode?: unknown };
    return typeof parsed.mode === "string" ? parsed.mode : null;
  } catch {
    return null;
  }
}

async function resumeVoiceValidationError(runId: string): Promise<string | null> {
  const ttsProvider = (getSetting("TTS_PROVIDER") || "69labs").trim().toLowerCase();
  if (ttsProvider !== "69labs" && ttsProvider !== "minimax") return null;

  const row = getRunVoiceConfig.get(runId) as
    | {
        preset_voice_id: string | null;
        preset_voice_provider: string | null;
        preset_voice_speed: number | null;
        preset_voice_stability: number | null;
        preset_voice_similarity_boost: number | null;
        preset_voice_style: number | null;
      }
    | undefined;
  const rawVoiceProvider = (
    (row?.preset_voice_provider && row.preset_voice_provider.trim()) ||
    getSetting("TTS_VOICE_PROVIDER") ||
    "elevenlabs"
  );
  const provider = ttsProvider === "minimax" ? "minimax" : normalizeTtsVoiceProvider(rawVoiceProvider);
  const voiceId = ((row?.preset_voice_id ?? "").trim() || getSetting("TTS_VOICE_ID").trim());
  if (!voiceId) {
    return `No ${voiceProviderLabel(provider)} voice selected. Pick a voice in Settings or the channel profile before resuming this run.`;
  }

  const validationOptions: VoiceSampleValidationOptions = {
    speedOverride: row?.preset_voice_speed ?? null,
    stabilityOverride: row?.preset_voice_stability ?? null,
    similarityOverride: row?.preset_voice_similarity_boost ?? null,
    voiceStyleOverride: row?.preset_voice_style ?? null,
  };
  const result = await validateTtsVoiceSample(voiceId, provider, validationOptions);
  if (result.ok) return null;
  return `The selected ${voiceProviderLabel(provider)} voice could not be validated by 69labs. Pick another voice or use the voice Test button before resuming this run. ${result.error}`;
}

export async function POST(_: Request, ctx: { params: Promise<{ id: string }> }) {
  ensureInit();
  const { id } = await ctx.params;
  const access = await requireVideoRunAccess(id, { edit: true });
  if (!access.ok) {
    return NextResponse.json(
      { error: access.status === 404 ? "run not found" : "Forbidden" },
      { status: access.status }
    );
  }

  await hydrateRuntimeConfig(id);

  const mode = readRunMode(id);
  if (mode !== "hybrid" && mode !== "image") {
    return NextResponse.json(
      { error: retiredVideoModeError(mode), errorKind: "mode_retired" },
      { status: 410 }
    );
  }

  if (!canResumeRun(id)) {
    return NextResponse.json(
      {
        error:
          "This run can't be resumed — there's no saved scene plan (scenes.json) on disk, " +
          "which usually means it failed before scene-splitting finished. Start a fresh run instead.",
      },
      { status: 400 }
    );
  }

  const preflight = runPreflight({ voiceConfigured: resumeVoiceConfigured(id) });
  if (!preflight.ready) {
    return NextResponse.json(
      {
        error: "Video generation is not ready. Fix the failed preflight checks before resuming this run.",
        errorKind: "preflight_failed",
        preflight,
      },
      { status: 400 }
    );
  }
  const invalidVoice = await resumeVoiceValidationError(id);
  if (invalidVoice) {
    return NextResponse.json({ error: invalidVoice, errorKind: "voice_invalid" }, { status: 400 });
  }

  const worker = startResumeRun(id);

  return NextResponse.json({
    ok: true,
    started: worker.started,
    alreadyRunning: !worker.started && worker.active,
  });
}
