import fs from "node:fs";
import path from "node:path";
import { getRunDir } from "./run-paths";
import { analyzeScenePlan, type ScenePlanHealth } from "./scene-plan-health";

export interface RunExportState {
  runDir: string;
  finalPath: string;
  finalFileExists: boolean;
  finalOnDisk: boolean;
  finalSize: number;
  scenePlanPresent: boolean;
  scenePlanParsed: boolean;
  scenePlanHealth: ScenePlanHealth;
  finalNeedsRepair: boolean;
  finalReady: boolean;
  canRepairPlan: boolean;
}

type ExportMode = "full" | "hybrid" | "stock" | "image" | string;
type ExportSourceKind = "fresh" | "stock" | "image_card" | string;

function unknownHealth(issue: string): ScenePlanHealth {
  return {
    ok: true,
    issue,
    sceneCount: 0,
    avgWords: 0,
    shortScenes: 0,
    danglingScenes: 0,
  };
}

export function readRunExportState(
  runId: string,
  status?: string | null,
  opts: { mode?: ExportMode | null } = {}
): RunExportState {
  const runDir = getRunDir(runId);
  const finalPath = path.join(runDir, "final.mp4");
  const finalFileExists = fs.existsSync(finalPath) && fs.statSync(finalPath).isFile();
  const finalOnDisk = finalFileExists && (!status || status === "done");
  const finalSize = finalFileExists ? fs.statSync(finalPath).size : 0;

  let scenePlanPresent = false;
  let scenePlanParsed = false;
  let scenePlanHealth = unknownHealth("Scene plan is unavailable for this older run.");
  const scenesPath = path.join(runDir, "scenes.json");
  if (fs.existsSync(scenesPath)) {
    scenePlanPresent = true;
    try {
      const parsed = JSON.parse(fs.readFileSync(scenesPath, "utf-8")) as { text?: unknown; source_kind?: ExportSourceKind }[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        scenePlanParsed = true;
        scenePlanHealth = analyzeExportScenePlan(parsed, opts.mode);
      }
    } catch {
      scenePlanHealth = unknownHealth("Scene plan is corrupt, so chunking quality cannot be verified.");
    }
  }

  const finalNeedsRepair = finalOnDisk && scenePlanParsed && !scenePlanHealth.ok;
  const finalReady = finalOnDisk;

  return {
    runDir,
    finalPath,
    finalFileExists,
    finalOnDisk,
    finalSize,
    scenePlanPresent,
    scenePlanParsed,
    scenePlanHealth,
    finalNeedsRepair,
    finalReady,
    canRepairPlan: finalNeedsRepair && scenePlanParsed,
  };
}

export function analyzeExportScenePlan(
  scenes: { text?: unknown; source_kind?: ExportSourceKind }[],
  mode?: ExportMode | null
): ScenePlanHealth {
  if (mode === "hybrid" || mode === "stock" || mode === "image") {
    const fresh = scenes.filter((s) => s.source_kind === "fresh");
    if (fresh.length === 0) {
      return {
        ok: true,
        issue: "Stock tail uses one continuous voiceover; tail beat boundaries do not block export.",
        sceneCount: 0,
        avgWords: 0,
        shortScenes: 0,
        danglingScenes: 0,
      };
    }
    const health = analyzeScenePlan(fresh);
    return health.ok
      ? health
      : {
          ...health,
          issue: `Fresh AI opening needs chunk repair: ${health.issue ?? "unsafe narration boundaries."}`,
        };
  }
  return analyzeScenePlan(scenes);
}
