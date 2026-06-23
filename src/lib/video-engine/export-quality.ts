import type { ScenePlanHealth } from "./scene-plan-health";

export type ExportQualityStatus = "pass" | "warn" | "fail" | "pending";

export interface ExportQualityCheck {
  id: "chunking" | "sync" | "watermark" | "duration";
  label: string;
  status: ExportQualityStatus;
  detail: string;
}

export interface ExportQualityReport {
  overall: "ready" | "needs_work" | "blocked" | "pending";
  checks: ExportQualityCheck[];
}

interface ExportQualityInput {
  finalReady: boolean;
  finalOnDisk: boolean;
  finalNeedsRepair: boolean;
  finalSize: number;
  scenePlanHealth: ScenePlanHealth;
  syncReport: Record<string, unknown> | null;
  watermarkCleanupEnabled: boolean;
  watermarkReport: Record<string, unknown> | null;
}

function numberFromReport(report: Record<string, unknown> | null, keys: string[]): number | null {
  if (!report) return null;
  for (const key of keys) {
    const value = report[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function boolFromReport(report: Record<string, unknown> | null, key: string): boolean | null {
  if (!report || typeof report[key] !== "boolean") return null;
  return report[key] as boolean;
}

function stringFromReport(report: Record<string, unknown> | null, key: string): string | null {
  if (!report || typeof report[key] !== "string") return null;
  return report[key] as string;
}

export function buildExportQualityReport(input: ExportQualityInput): ExportQualityReport {
  const checks: ExportQualityCheck[] = [];

  checks.push({
    id: "chunking",
    label: "Chunking",
    status: input.scenePlanHealth.ok ? "pass" : "fail",
    detail: input.scenePlanHealth.ok
      ? "Sentence-safe scene plan."
      : input.scenePlanHealth.issue ?? "Old tiny chunks need repair before export.",
  });

  const freshDrift = numberFromReport(input.syncReport, ["freshMaxDriftSec", "maxDriftSec"]);
  const totalDrift = numberFromReport(input.syncReport, ["totalDriftSec"]);
  const drift = freshDrift ?? totalDrift;
  const continuousTail = boolFromReport(input.syncReport, "continuousTail");
  checks.push({
    id: "sync",
    label: "Audio sync",
    status: !input.finalReady
      ? "pending"
      : drift == null
        ? "warn"
        : drift <= 0.35
          ? "pass"
          : "warn",
    detail: !input.finalReady
      ? "Final export is not ready yet."
      : drift == null
        ? "No sync report found for this older export."
        : continuousTail
          ? `Fresh opening drift <= ${drift.toFixed(3)}s; long tail uses one continuous voiceover.`
          : `Audio/video drift <= ${drift.toFixed(3)}s.`,
  });

  const watermarkStatus = stringFromReport(input.watermarkReport, "status");
  checks.push({
    id: "watermark",
    label: "Watermark cleanup",
    status: !input.finalReady
      ? "pending"
      : !input.watermarkCleanupEnabled
        ? "warn"
        : watermarkStatus === "cleaned" || watermarkStatus === "not_applicable"
          ? "pass"
          : watermarkStatus === "failed"
            ? "fail"
            : "warn",
    detail: !input.finalReady
      ? "Final export is not ready yet."
      : !input.watermarkCleanupEnabled
        ? "Provider corner cleanup is disabled in Settings."
        : watermarkStatus === "cleaned"
          ? "Final export was reframed after assembly to remove provider corner marks."
          : watermarkStatus === "not_applicable"
            ? stringFromReport(input.watermarkReport, "message") ?? "No final cleanup was needed for this export."
          : watermarkStatus === "failed"
            ? `Final cleanup failed: ${stringFromReport(input.watermarkReport, "message") ?? "unknown issue"}.`
            : "No final cleanup proof found for this older export.",
  });

  const totalSec = numberFromReport(input.syncReport, ["totalSec", "finalSec"]);
  checks.push({
    id: "duration",
    label: "Export file",
    status: input.finalReady && input.finalSize > 0 ? "pass" : input.finalOnDisk && input.finalNeedsRepair ? "fail" : "pending",
    detail: input.finalReady && input.finalSize > 0
      ? `${(input.finalSize / (1024 * 1024)).toFixed(1)} MB${totalSec ? ` · ${(totalSec / 60).toFixed(1)} min` : ""}.`
      : input.finalOnDisk && input.finalNeedsRepair
        ? "Old export exists but is hidden until chunks are repaired."
        : "Final file has not been assembled yet.",
  });

  const statuses = checks.map((c) => c.status);
  const overall = statuses.includes("fail")
    ? "blocked"
    : !input.finalReady
      ? "pending"
      : statuses.includes("warn")
        ? "needs_work"
        : "ready";

  return { overall, checks };
}
