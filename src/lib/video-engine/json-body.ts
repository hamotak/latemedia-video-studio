/**
 * Safe JSON body parsing for route handlers — dependency-free so it can be
 * unit-tested without booting Next or the DB.
 *
 * `await req.json()` THROWS on a malformed body, and an unhandled throw in a
 * route handler surfaces as HTTP 500. For client-supplied input that's wrong:
 * a bad body is a client error (400). Routes use tryParseJson + return 400 on
 * `ok: false` so garbage input never looks like a server crash.
 */
export type JsonParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export function tryParseJson<T = unknown>(text: string): JsonParseResult<T> {
  try {
    return { ok: true, value: JSON.parse(text) as T };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "invalid JSON" };
  }
}

/** True for a parsed value that's a usable JSON object (not null / array / primitive). */
export function isJsonObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
