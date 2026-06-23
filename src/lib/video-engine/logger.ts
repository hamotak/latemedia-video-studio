import { EventEmitter } from "node:events";
import db from "./db";
import { mirrorVideoLog } from "./supabase-video-mirror";
import { sanitizeMediaErrorMessage, sanitizeMediaLogData } from "./media-errors";

const insertLog = db.prepare(
  "INSERT INTO run_logs (run_id, ts, level, stage, message, data_json) VALUES (?, ?, ?, ?, ?, ?)"
);

const getLogsStmt = db.prepare(
  "SELECT id, ts, level, stage, message, data_json FROM run_logs WHERE run_id = ? ORDER BY id ASC"
);

export type LogLevel = "info" | "warn" | "error" | "success" | "debug";

export interface LogEntry {
  id?: number;
  ts: string;
  runId: string;
  level: LogLevel;
  stage?: string;
  message: string;
  data?: unknown;
}

/**
 * Global event bus for live run logs. Each runId is its own event channel.
 * The UI subscribes via SSE, the backend pushes through this logger.
 */
class LogBus extends EventEmitter {}
const bus = new LogBus();
bus.setMaxListeners(0);

export function log(
  runId: string,
  level: LogLevel,
  message: string,
  opts: { stage?: string; data?: unknown } = {}
) {
  const safeMessage = sanitizeMediaErrorMessage(message);
  const safeData = opts.data === undefined ? undefined : sanitizeMediaLogData(opts.data);
  const dataJson = safeData === undefined ? null : JSON.stringify(safeData);
  const ts = new Date().toISOString();
  const result = insertLog.run(runId, ts, level, opts.stage ?? null, safeMessage, dataJson);
  const entry: LogEntry = {
    id: Number(result.lastInsertRowid),
    ts,
    runId,
    level,
    stage: opts.stage,
    message: safeMessage,
    data: safeData,
  };
  bus.emit(`log:${runId}`, entry);
  void mirrorVideoLog(entry).catch(() => {});
  // Mirror to the dev console for convenience
  const prefix = `[${runId.slice(0, 8)}${opts.stage ? `/${opts.stage}` : ""}]`;
  // eslint-disable-next-line no-console
  console[level === "error" ? "error" : "log"](prefix, safeMessage, safeData ?? "");
  return entry;
}

export function subscribe(runId: string, handler: (e: LogEntry) => void) {
  const ev = `log:${runId}`;
  bus.on(ev, handler);
  return () => bus.off(ev, handler);
}

export function getLogs(runId: string): LogEntry[] {
  type Row = {
    id: number;
    ts: string;
    level: LogLevel;
    stage: string | null;
    message: string;
    data_json: string | null;
  };
  const rows = getLogsStmt.all(runId) as Row[];
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    runId,
    level: r.level,
    stage: r.stage ?? undefined,
    message: r.message,
    data: r.data_json ? JSON.parse(r.data_json) : undefined,
  }));
}
