/**
 * Role-based permission matrix (handoff spec — "follow this for now").
 *
 * A user's trusted role lives on their Supabase user: `app_metadata.role`.
 * Only "admin" has global/elevated access;
 * the others are scoped per the matrix below. Channel assignment scoping
 * (who sees which channels) is enforced separately — this module only
 * answers "what may this role edit".
 *
 *   Role      Sees                            Can edit
 *   ──────    ────────────────────────────    ──────────────────────────────
 *   admin     Everything, all channels        Everything, incl. global settings
 *   manager   Assigned channels, full board   Board, Channel Info (per channel)
 *   designer  Assigned channels, thumbnails   Thumbnails, card images/feedback
 *   editor    Assigned channels, video queue  Video editing, card status/notes
 */

export type AppRole = "admin" | "manager" | "designer" | "editor" | (string & {});

export function normalizeRole(role: string | null | undefined): string {
  return (role ?? "").trim().toLowerCase();
}

/**
 * The trusted role for a Supabase user. `app_metadata.role` is the only source
 * of truth because it is writable only by the service role (admin endpoints).
 *
 * Accepts the minimal shape both the server (`@supabase/supabase-js` User)
 * and client (`getUser()` data) expose.
 */
export function extractRole(
  user:
    | { app_metadata?: Record<string, unknown> | null; user_metadata?: Record<string, unknown> | null }
    | null
    | undefined
): string {
  const app = user?.app_metadata?.role;
  return normalizeRole(typeof app === "string" ? app : "");
}

/** True for the global super-role. */
export function isAdmin(role: string | null | undefined): boolean {
  return normalizeRole(role) === "admin";
}

/* ════════════════════════════════════════════════
   Feature × permission-level model
════════════════════════════════════════════════ */

/**
 * The tools/tabs a role can be granted access to. Single source of truth —
 * `channels-store.ts` (CHANNEL_FEATURES) and the per-channel Access panel
 * import this list so the columns always line up.
 */
export const FEATURES = [
  { key: "board", label: "Board" },
  { key: "ideate", label: "Ideate" },
  { key: "image", label: "Image Studio" },
  { key: "thumbnails", label: "Thumbnails" },
  { key: "competitors", label: "Competitors" },
  { key: "channel_info", label: "Channel Info" },
  { key: "video", label: "Video Editing" },
] as const;

export type FeatureKey = (typeof FEATURES)[number]["key"];

export const FEATURE_KEYS = FEATURES.map((f) => f.key) as FeatureKey[];

/** none = hidden, view = read-only, edit = full access. */
export type PermissionLevel = "none" | "view" | "edit";

/** A role's permission level for every feature. */
export type RolePermissions = Record<string, PermissionLevel>;

export function isPermissionLevel(v: unknown): v is PermissionLevel {
  return v === "none" || v === "view" || v === "edit";
}

export function canView(level: PermissionLevel | undefined): boolean {
  return level === "view" || level === "edit";
}

export function canEditLevel(level: PermissionLevel | undefined): boolean {
  return level === "edit";
}

const ALL_EDIT: RolePermissions = Object.fromEntries(FEATURE_KEYS.map((k) => [k, "edit"]));
const ALL_VIEW: RolePermissions = Object.fromEntries(FEATURE_KEYS.map((k) => [k, "view"]));

/**
 * Seed defaults from the handoff matrix. `admin` is always full and never
 * editable. Any role not listed here (a future custom role) starts at
 * view-all — visible but read-only — until an admin tunes it.
 */
export const DEFAULT_ROLE_PERMISSIONS: Record<string, RolePermissions> = {
  admin: { ...ALL_EDIT },
  manager: {
    board: "edit", ideate: "view", image: "view", thumbnails: "view",
    competitors: "view", channel_info: "edit", video: "view",
  },
  designer: {
    board: "view", ideate: "none", image: "edit", thumbnails: "edit",
    competitors: "none", channel_info: "view", video: "none",
  },
  editor: {
    board: "edit", ideate: "none", image: "none", thumbnails: "none",
    competitors: "none", channel_info: "view", video: "edit",
  },
};

/** The default permission map for a role (admin ⇒ full; unknown ⇒ view-all). */
export function defaultPermissionsForRole(role: string | null | undefined): RolePermissions {
  const r = normalizeRole(role);
  if (r === "admin") return { ...ALL_EDIT };
  return { ...(DEFAULT_ROLE_PERMISSIONS[r] ?? ALL_VIEW) };
}

/** Normalize an arbitrary map into a complete RolePermissions (fills gaps with "none"). */
export function completePermissions(partial: Partial<RolePermissions> | undefined): RolePermissions {
  const out: RolePermissions = {};
  for (const k of FEATURE_KEYS) {
    const v = partial?.[k];
    out[k] = isPermissionLevel(v) ? v : "none";
  }
  return out;
}
