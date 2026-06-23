export function isNonRetriableMediaConfigError(message: string): boolean {
  return /\b(?:LABS69_API_KEY|GOOGLE_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY)\b.*\bis not set\b/i.test(message);
}

const SECRET_FIELD_RE =
  /\b(api[_-]?key|apikey|authorization|bearer|token|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password)\b/i;

export function sanitizeMediaErrorMessage(message: string): string {
  return message
    .replace(/(Authorization\s*[:=]\s*Bearer\s+)[^\s"'`,}]+/gi, "$1[redacted]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[redacted]")
    .replace(
      /([?&](?:key|api[_-]?key|token|access[_-]?token|refresh[_-]?token|client[_-]?secret)=)[^&\s"'`]+/gi,
      "$1[redacted]"
    )
    .replace(
      /((?:api[_-]?key|apikey|token|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password)["']?\s*[:=]\s*["']?)[^"',}\s]+/gi,
      "$1[redacted]"
    );
}

export function sanitizeMediaLogData(value: unknown): unknown {
  return sanitizeMediaLogDataInner(value, new WeakSet<object>());
}

function sanitizeMediaLogDataInner(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return sanitizeMediaErrorMessage(value);
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeMediaLogDataInner(item, seen));

  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_FIELD_RE.test(key)
      ? "[redacted]"
      : sanitizeMediaLogDataInner(raw, seen);
  }
  return out;
}
