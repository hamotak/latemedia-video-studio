import type { JobKind } from "./services/labs69";
import db from "./db";

/**
 * In-memory cancellation registry.
 *
 * When the user clicks Stop, the API adds the runId here. The pipeline checks
 * this set between stages and throws CancelledError when it sees its id.
 *
 * Lives in the dev server process memory — clears on restart, which is fine
 * for our use case (any cancelled run will already be marked `cancelled` in DB).
 *
 * It also tracks the 69labs jobs currently in flight per run, so the Stop
 * endpoint can actively cancel the PAID jobs (TTS / video) — not just flip the
 * DB status and let them keep running and billing.
 *
 * The DB status check lets child worker processes observe cancellation even
 * though they do not share the dev server's in-memory cancellation set.
 */
const cancelled = new Set<string>();
const getRunCancelStatusStmt = db.prepare("SELECT status FROM runs WHERE id = ?");

export function markCancelled(runId: string) {
  cancelled.add(runId);
}

export function isCancelled(runId: string): boolean {
  if (cancelled.has(runId)) return true;
  try {
    const row = getRunCancelStatusStmt.get(runId) as { status?: string } | undefined;
    return row?.status === "cancelled";
  } catch {
    return false;
  }
}

export function clearCancelled(runId: string) {
  cancelled.delete(runId);
  activeJobs.delete(runId); // stale entries from a prior attempt with this id
  activeLocalProcesses.delete(runId);
}

// ── Active 69labs job registry (runId → in-flight paid jobs) ─────────────────

export interface ActiveJob {
  kind: JobKind;
  jobId: string;
  sceneIndex?: number;
  model?: string | null;
  attempt?: number;
  startedAt: number;
  timeoutAt?: number | null;
  isHedge?: boolean;
  stage?: string;
}

/** runId → (jobId → ActiveJob). Inner map keys by jobId so re-registering is idempotent. */
const activeJobs = new Map<string, Map<string, ActiveJob>>();

/** Record a 69labs job as in-flight for a run. No-op for blank ids. */
export function registerJob(
  runId: string,
  kind: JobKind,
  jobId: string,
  meta: Partial<Omit<ActiveJob, "kind" | "jobId" | "startedAt">> & { startedAt?: number } = {}
): void {
  if (!runId || !jobId) return;
  let m = activeJobs.get(runId);
  if (!m) {
    m = new Map();
    activeJobs.set(runId, m);
  }
  const existing = m.get(jobId);
  m.set(jobId, {
    ...existing,
    kind,
    jobId,
    startedAt: meta.startedAt ?? existing?.startedAt ?? Date.now(),
    sceneIndex: meta.sceneIndex ?? existing?.sceneIndex,
    model: meta.model ?? existing?.model,
    attempt: meta.attempt ?? existing?.attempt,
    timeoutAt: meta.timeoutAt ?? existing?.timeoutAt,
    isHedge: meta.isHedge ?? existing?.isHedge,
    stage: meta.stage ?? existing?.stage,
  });
}

/** Mark a job no longer in flight (completed, downloaded, failed, or cancelled). */
export function unregisterJob(runId: string, jobId: string): void {
  const m = activeJobs.get(runId);
  if (!m) return;
  m.delete(jobId);
  if (m.size === 0) activeJobs.delete(runId);
}

/** Snapshot of the jobs currently in flight for a run — what Stop must cancel. */
export function getActiveJobs(runId: string): ActiveJob[] {
  const m = activeJobs.get(runId);
  return m ? [...m.values()] : [];
}

// ── Active local process registry (runId → in-flight ffmpeg/process work) ──

export interface ActiveLocalProcessSnapshot {
  id: string;
  label: string;
  pid?: number;
  startedAt: number;
}

interface ActiveLocalProcess extends ActiveLocalProcessSnapshot {
  kill: (signal: NodeJS.Signals) => void;
  killTimer?: ReturnType<typeof setTimeout>;
}

let localProcessCounter = 0;
const activeLocalProcesses = new Map<string, Map<string, ActiveLocalProcess>>();

export function registerLocalProcess(
  runId: string,
  label: string,
  killable: { pid?: number; kill: (signal?: NodeJS.Signals) => unknown }
): () => void {
  if (!runId) return () => {};
  const id = `${Date.now()}-${++localProcessCounter}`;
  let m = activeLocalProcesses.get(runId);
  if (!m) {
    m = new Map();
    activeLocalProcesses.set(runId, m);
  }
  const entry: ActiveLocalProcess = {
    id,
    label,
    pid: typeof killable.pid === "number" ? killable.pid : undefined,
    startedAt: Date.now(),
    kill: (signal) => {
      try {
        killable.kill(signal);
      } catch {
        /* best-effort cancellation */
      }
    },
  };
  m.set(id, entry);
  if (isCancelled(runId)) terminateLocalProcess(entry);

  return () => {
    const current = activeLocalProcesses.get(runId);
    const found = current?.get(id);
    if (found?.killTimer) clearTimeout(found.killTimer);
    current?.delete(id);
    if (current && current.size === 0) activeLocalProcesses.delete(runId);
  };
}

export function getActiveLocalProcesses(runId: string): ActiveLocalProcessSnapshot[] {
  const m = activeLocalProcesses.get(runId);
  return m ? [...m.values()].map(({ id, label, pid, startedAt }) => ({ id, label, pid, startedAt })) : [];
}

export function cancelLocalProcesses(runId: string): ActiveLocalProcessSnapshot[] {
  const m = activeLocalProcesses.get(runId);
  if (!m) return [];
  const snapshot = getActiveLocalProcesses(runId);
  for (const entry of m.values()) terminateLocalProcess(entry);
  return snapshot;
}

function terminateLocalProcess(entry: ActiveLocalProcess): void {
  entry.kill("SIGTERM");
  if (!entry.killTimer) {
    entry.killTimer = setTimeout(() => entry.kill("SIGKILL"), 5000);
    entry.killTimer.unref?.();
  }
}

/** Throws CancelledError if the run has been flagged for cancellation. */
export function checkCancelled(runId: string): void {
  if (isCancelled(runId)) {
    throw new CancelledError(`Run ${runId} cancelled by user`);
  }
}

export class CancelledError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "CancelledError";
  }
}
