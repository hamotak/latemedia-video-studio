/**
 * Voice-id resolution rules — extracted from tts.ts so the channel→global→
 * provider-default fallback chain is unit-testable without DB/network.
 *
 * Order of precedence (matches the production TTS dispatch):
 *   1. Per-channel `voice_id` (when non-empty, wins).
 *   2. Global `TTS_VOICE_ID` setting (truthy wins).
 *   3. The provider's hardcoded default ("" for MiniMax which then errors,
 *      a concrete voice id for the selected 69labs voice engine).
 *
 * The rule "channel blank → fall back to global" is the safety net for
 * channel runs: any channel without its own voice still picks up a working
 * voice as long as the global voice is configured.
 */
export function pickVoiceId(opts: {
  /** Per-channel override (preset_voice_id). Null/blank → fall through. */
  channel?: string | null;
  /** Global TTS_VOICE_ID setting. Truthy → use it. */
  global?: string | null;
  /** Provider-specific hardcoded default. */
  fallback?: string;
}): string {
  if (opts.channel && opts.channel.trim().length > 0) return opts.channel.trim();
  return opts.global || opts.fallback || "";
}
