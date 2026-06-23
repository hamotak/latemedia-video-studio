/**
 * Pure preflight evaluation: raw facts → labelled checks + an overall `ready`
 * flag. Dependency-free so the gating logic is unit-tested without the
 * filesystem / DB that `preflight.ts` pulls in to gather the facts.
 */
export type CheckStatus = "ok" | "warn" | "fail";

export interface PreflightCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** Required checks gate the run; informational ones (Drive) do not. */
  required: boolean;
}

export interface PreflightResult {
  /** True when every REQUIRED check passes — safe to start a run. */
  ready: boolean;
  checks: PreflightCheck[];
}

export interface PreflightFacts {
  sceneSplitProvider: string;
  sceneSplitKey: boolean;
  labs69KeyCount: number;
  ffmpeg: boolean;
  outputWritable: boolean;
  /** Global TTS_VOICE_ID is set. Channel runs override per-channel but fall back
   *  to global if their voice_id is blank, so a configured global voice is the
   *  safety net for both no-channel and channel runs. */
  voiceConfigured: boolean;
  driveConnected: boolean;
  driveSyncEnabled: boolean;
}

export function buildPreflight(f: PreflightFacts): PreflightResult {
  const sceneProvider = (f.sceneSplitProvider || "google").toLowerCase();
  const sceneKeyName = sceneProvider === "anthropic" ? "ANTHROPIC_API_KEY" : "GOOGLE_API_KEY";
  const sceneLabel = sceneProvider === "anthropic" ? "Anthropic API key" : "Google API key";
  const checks: PreflightCheck[] = [
    {
      id: "scene_split_key",
      label: sceneLabel,
      status: f.sceneSplitKey ? "ok" : "fail",
      detail: f.sceneSplitKey
        ? `Set — used by ${sceneProvider} scene splitting.`
        : `Missing — add ${sceneKeyName} in Settings.`,
      required: true,
    },
    {
      id: "labs69_key",
      label: "69labs key",
      status: f.labs69KeyCount > 0 ? "ok" : "fail",
      detail:
        f.labs69KeyCount > 0
          ? `${f.labs69KeyCount} key${f.labs69KeyCount === 1 ? "" : "s"} — powers video + voiceover (each adds ~5 parallel jobs).`
          : "Missing — add LABS69_API_KEY in Settings.",
      required: true,
    },
    {
      id: "ffmpeg",
      label: "FFmpeg",
      status: f.ffmpeg ? "ok" : "fail",
      detail: f.ffmpeg ? "Available — assembles the final video." : "Not found — install FFmpeg or set FFMPEG_PATH in Settings.",
      required: true,
    },
    {
      id: "output_folder",
      label: "Output folder",
      status: f.outputWritable ? "ok" : "fail",
      detail: f.outputWritable ? "Writable — runs save here." : "Not writable — check RUNS_OUTPUT_DIR in Settings.",
      required: true,
    },
    {
      id: "voice",
      label: "Voice",
      status: f.voiceConfigured ? "ok" : "fail",
      detail: f.voiceConfigured
        ? "A voice is selected — channels can override it; missing channel voices fall back to this one."
        : "No voice selected — open the voice picker on the New Run page or pick one in Settings before running.",
      required: true,
    },
    {
      id: "drive",
      label: "Google Drive",
      status: f.driveSyncEnabled ? (f.driveConnected ? "ok" : "warn") : "ok",
      detail: f.driveSyncEnabled
        ? f.driveConnected
          ? "Sync on and connected — finished runs auto-upload."
          : "Sync is ON but Drive isn't connected — uploads will be skipped. Connect in Settings."
        : "Sync off — runs stay on this machine.",
      required: false,
    },
  ];

  const ready = checks.every((c) => !c.required || c.status === "ok");
  return { ready, checks };
}
