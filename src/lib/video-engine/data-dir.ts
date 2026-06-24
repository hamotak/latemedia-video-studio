import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DATA_ENV, LEGACY_DATA_ENV } from "./app-meta";

/**
 * Standalone build: keep all local data inside the project's own `data/`
 * folder. This makes the app fully self-contained (copy or delete the folder
 * to move/uninstall) and guarantees it never shares state with any other
 * Bilal Demo install on the same machine. An explicit data-dir env var still
 * wins for advanced setups.
 */
function findProjectRoot(...startDirs: string[]): string {
  for (const startDir of startDirs) {
    let cur = startDir;
    for (let i = 0; i < 12; i++) {
      if (fs.existsSync(path.join(cur, "package.json"))) return cur;
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  return process.cwd();
}

export const DEFAULT_DATA_DIR = path.join(findProjectRoot(process.cwd(), __dirname), "data");
export const LEGACY_DATA_DIR = path.join(os.homedir(), ".conveyer-hum");

export function resolveDataDir(): string {
  const explicit = process.env[DATA_ENV]?.trim();
  if (explicit) return explicit;

  const legacyExplicit = process.env[LEGACY_DATA_ENV]?.trim();
  if (legacyExplicit) return legacyExplicit;

  const oldLegacyExplicit = process.env.CONVEYER_HUM_DATA_DIR?.trim();
  if (oldLegacyExplicit) return oldLegacyExplicit;

  return DEFAULT_DATA_DIR;
}

export const DATA_DIR = resolveDataDir();
