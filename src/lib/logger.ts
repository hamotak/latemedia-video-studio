import "server-only";
import { writeLog, type LogLevel } from "./db";

/**
 * Thin logger that writes structured entries into the `app_logs` SQLite table
 * so the /logs page can show them. Also mirrors to the terminal in dev, which
 * is helpful when the Next dev server is open next to the app.
 *
 * Usage:
 *   log.info("sync", "Channel resolved", { channelId, title })
 *   log.warn("youtube", "Quota near limit", { quotaLeft })
 *   log.error("chat", "Claude request failed", err, { sessionId })
 *
 * `source` is a short, snake-case tag grouping related events. Pick from the
 * existing tags when possible so the logs page filter stays tidy.
 */

export type LogSource =
  | "sync"
  | "comments-sync"
  | "chat"
  | "youtube"
  | "claude"
  | "oauth"
  | "db"
  | "api"
  | "other";

function safeStack(err: unknown): string | null {
  if (err instanceof Error && err.stack) return err.stack;
  return null;
}

function safeContext(ctx: unknown): unknown {
  if (ctx === undefined || ctx === null) return undefined;
  // If the caller passed an Error, normalise it so the structured context
  // keeps the useful fields — a raw Error serialises to {} via JSON.stringify.
  if (ctx instanceof Error) {
    return { name: ctx.name, message: ctx.message };
  }
  return ctx;
}

function emit(
  level: LogLevel,
  source: LogSource | string,
  message: string,
  context?: unknown,
  stack?: string | null
): void {
  try {
    writeLog({ level, source, message, context: safeContext(context), stack: stack ?? null });
  } catch {
    // Never let the logger itself break a request.
  }
  // Mirror errors/warnings to the terminal so `npm run dev` still shows them.
  // Debug/info are silent on the terminal to avoid noise.
  if (level === "error") {
    // eslint-disable-next-line no-console
    console.error(`[${source}] ${message}`, context ?? "", stack ?? "");
  } else if (level === "warn") {
    // eslint-disable-next-line no-console
    console.warn(`[${source}] ${message}`, context ?? "");
  }
}

export const log = {
  debug(source: LogSource | string, message: string, context?: unknown): void {
    emit("debug", source, message, context);
  },
  info(source: LogSource | string, message: string, context?: unknown): void {
    emit("info", source, message, context);
  },
  warn(source: LogSource | string, message: string, context?: unknown): void {
    emit("warn", source, message, context);
  },
  /**
   * Log an error. Accepts either a plain message or a message + Error (the
   * common pattern in catch blocks). Stack + error name/message are preserved
   * automatically so the UI can show them without special handling.
   */
  error(
    source: LogSource | string,
    message: string,
    err?: unknown,
    context?: unknown
  ): void {
    const mergedContext =
      err instanceof Error
        ? { ...(typeof context === "object" && context ? context : {}), error: { name: err.name, message: err.message } }
        : err !== undefined
          ? { ...(typeof context === "object" && context ? context : {}), error: err }
          : context;
    emit("error", source, message, mergedContext, safeStack(err));
  },
};
