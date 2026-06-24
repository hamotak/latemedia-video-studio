import "server-only";
import {
  defaultPermissionsForRole,
  extractRole,
  normalizeRole,
  type PermissionLevel,
  type RolePermissions,
} from "@/lib/permissions";

/**
 * Standalone build: role permissions are local coded defaults only.
 * The app runs as one built-in admin, so old role-override write APIs are
 * kept as no-ops for route compatibility and never touch a cloud database.
 */

type OverrideMap = Record<string, Partial<RolePermissions>>;

/** All stored overrides — used by the admin GET that needs the full matrix. */
export async function getOverrides(): Promise<OverrideMap> {
  return {};
}

/** Overwrite one role's full permission map (admin is rejected — always full). */
export async function saveRolePermissions(role: string, perms: Partial<RolePermissions>): Promise<void> {
  const r = normalizeRole(role);
  if (!r || r === "admin") return;
  void perms;
}

/** Drop a role's overrides so it falls back to coded defaults. */
export async function resetRolePermissions(role: string): Promise<void> {
  const r = normalizeRole(role);
  if (!r || r === "admin") return;
}

/** Full effective permission map for a role (defaults merged with stored override). */
export async function effectivePermissionsForRole(role: string | null | undefined): Promise<RolePermissions> {
  const r = normalizeRole(role);
  const base = defaultPermissionsForRole(r);
  if (base.board === "view") base.board = "edit";
  return base;
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

/** Convenience gate for API routes: does this local user's role edit `feature`? */
export async function userCanEditFeature(user: MetaUser, feature: string): Promise<boolean> {
  return !!user && (await getRoleFeatureLevel(extractRole(user), feature)) === "edit";
}

/** Convenience gate: does this local user's role at least view `feature`? */
export async function userCanViewFeature(user: MetaUser, feature: string): Promise<boolean> {
  return !!user && (await getRoleFeatureLevel(extractRole(user), feature)) !== "none";
}
