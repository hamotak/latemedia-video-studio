import "server-only";
import { createClient } from "@/lib/supabase/server";

/**
 * The signed-in user, normalized to the same shape route code already reads
 * (`user.id`, `user.app_metadata.role`, `user.user_metadata.*`).
 */
export type AuthedUser = {
  id: string;
  email: string | null;
  app_metadata: Record<string, unknown>;
  user_metadata: Record<string, unknown>;
};

function safeUserMetadata(metadata: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const safe = { ...(metadata ?? {}) };
  delete safe.role;
  return safe;
}

/**
 * Resolve the signed-in user for an API route.
 *
 * Fast path: `auth.getClaims()` verifies the request's JWT LOCALLY using the
 * project's asymmetric signing keys (ES256) — no network round-trip. This
 * replaces `auth.getUser()`, which validates against the Supabase auth server
 * on every call and was being invoked on ~44 routes (a major source of the
 * "app feels slow" complaint).
 *
 * Safety: if local verification is unavailable for any reason, we fall back to
 * the network-validated `getUser()` — so behavior is never worse than before.
 */
export async function getAuthedUser(): Promise<AuthedUser | null> {
  const supabase = await createClient();

  try {
    const { data, error } = await supabase.auth.getClaims();
    const claims = data?.claims as Record<string, unknown> | undefined;
    const sub = claims?.sub;
    if (!error && typeof sub === "string" && sub.length > 0) {
      return {
        id: sub,
        email: (claims!.email as string) ?? null,
        app_metadata: (claims!.app_metadata as Record<string, unknown>) ?? {},
        user_metadata: safeUserMetadata(claims!.user_metadata as Record<string, unknown>),
      };
    }
  } catch {
    // fall through to the network-validated path
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  return {
    id: user.id,
    email: user.email ?? null,
    app_metadata: (user.app_metadata as Record<string, unknown>) ?? {},
    user_metadata: safeUserMetadata(user.user_metadata as Record<string, unknown>),
  };
}
