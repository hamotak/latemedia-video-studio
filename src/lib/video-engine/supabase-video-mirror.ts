import "server-only";

import type { LogEntry } from "./logger";

/**
 * Standalone build compatibility shim.
 *
 * The original app mirrored video runs/logs into Supabase. This isolated app is
 * intentionally local-only, so these hooks are kept as no-ops for existing
 * call sites and never read env vars or open network/database clients.
 */
export async function mirrorVideoRun(_runId?: string, _opts?: unknown): Promise<void> {
  return;
}

export async function mirrorVideoLog(_entry: LogEntry): Promise<void> {
  return;
}
