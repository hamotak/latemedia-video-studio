/**
 * Secret-key detection + mask handling — the single source of truth shared by:
 *   - src/lib/settings.ts          (masks secrets in GET responses)
 *   - src/app/api/settings/route.ts (skips masked values on POST)
 *   - src/app/settings/page.tsx     (client form: skips masked values before POST)
 *
 * Kept dependency-free (no DB import) so the client bundle can use it too. Before
 * this was shared, the route's inline check drifted — it matched KEY/TOKEN but
 * NOT SECRET — so a masked GDRIVE_CLIENT_SECRET POSTed straight back overwrote
 * the real secret with a broken "GOCS…XXXX" value. One helper, no drift.
 */

/** The character the UI shows in place of a secret's middle (U+2026 "…"). */
export const MASK_CHAR = "…";

/** True when a setting key holds a secret (API key / token / client secret). */
export function isSecretKey(key: string): boolean {
  return key.includes("KEY") || key.includes("TOKEN") || key.includes("SECRET");
}

/**
 * True when a value is a masked placeholder that must NOT be persisted — saving
 * it would overwrite the real stored secret with the truncated display string.
 */
export function isMaskedValue(value: string): boolean {
  return value.includes(MASK_CHAR);
}
