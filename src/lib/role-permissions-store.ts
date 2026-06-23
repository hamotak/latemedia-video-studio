import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import {
  FEATURE_KEYS,
  completePermissions,
  defaultPermissionsForRole,
  extractRole,
  isPermissionLevel,
  normalizeRole,
  type PermissionLevel,
  type RolePermissions,
} from "@/lib/permissions";

/**
 * Persists the admin-tuned role → permission overrides in the Supabase
 * `role_permissions` table (service-role access only; RLS blocks all other
 * keys). Effective permissions = the coded defaults merged with any stored
 * override row. Rows absent ⇒ coded default applies.
 *
 * `admin` is intentionally never stored or merged — it is always full access.
 */

type OverrideMap = Record<string, Partial<RolePermissions>>;

function serviceClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

function parsePermissions(raw: Record<string, unknown>): Partial<RolePermissions> {
  const clean: Partial<RolePermissions> = {};
  for (const k of FEATURE_KEYS) {
    const v = raw[k];
    if (isPermissionLevel(v)) clean[k] = v;
  }
  return clean;
}

/** All stored overrides — used by the admin GET that needs the full matrix. */
export async function getOverrides(): Promise<OverrideMap> {
  const { data, error } = await serviceClient()
    .from("role_permissions")
    .select("role, permissions");
  if (error || !data) return {};
  const out: OverrideMap = {};
  for (const row of data) {
    const r = normalizeRole(row.role as string);
    if (!r || r === "admin") continue;
    if (!row.permissions || typeof row.permissions !== "object") continue;
    out[r] = parsePermissions(row.permissions as Record<string, unknown>);
  }
  return out;
}

/** Overwrite one role's full permission map (admin is rejected — always full). */
export async function saveRolePermissions(role: string, perms: Partial<RolePermissions>): Promise<void> {
  const r = normalizeRole(role);
  if (!r || r === "admin") return;
  await serviceClient()
    .from("role_permissions")
    .upsert(
      { role: r, permissions: completePermissions(perms), updated_at: new Date().toISOString() },
      { onConflict: "role" }
    );
}

/** Drop a role's overrides so it falls back to coded defaults. */
export async function resetRolePermissions(role: string): Promise<void> {
  const r = normalizeRole(role);
  if (!r || r === "admin") return;
  await serviceClient()
    .from("role_permissions")
    .delete()
    .eq("role", r);
}

/** Full effective permission map for a role (defaults merged with stored override). */
export async function effectivePermissionsForRole(role: string | null | undefined): Promise<RolePermissions> {
  const r = normalizeRole(role);
  const base = defaultPermissionsForRole(r);
  if (base.board === "view") base.board = "edit";
  if (r === "admin") return base;
  const { data } = await serviceClient()
    .from("role_permissions")
    .select("permissions")
    .eq("role", r)
    .maybeSingle();
  if (!data?.permissions) return base;
  const override = parsePermissions(data.permissions as Record<string, unknown>);
  const merged = { ...base, ...override } as RolePermissions;
  if (merged.board === "view") merged.board = "edit";
  return merged;
}

/** A role's effective level for one feature. */
export async function getRoleFeatureLevel(
  role: string | null | undefined,
  feature: string
): Promise<PermissionLevel> {
  return (await effectivePermissionsForRole(role))[feature] ?? "none";
}

type MetaUser =
  | { app_metadata?: Record<string, unknown> | null; user_metadata?: Record<string, unknown> | null }
  | null
  | undefined;

/** Convenience gate for API routes: does this Supabase user's role edit `feature`? */
export async function userCanEditFeature(user: MetaUser, feature: string): Promise<boolean> {
  return !!user && (await getRoleFeatureLevel(extractRole(user), feature)) === "edit";
}

/** Convenience gate: does this user's role at least view `feature`? */
export async function userCanViewFeature(user: MetaUser, feature: string): Promise<boolean> {
  return !!user && (await getRoleFeatureLevel(extractRole(user), feature)) !== "none";
}
