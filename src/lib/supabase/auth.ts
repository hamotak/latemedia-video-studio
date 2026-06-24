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
 * Standalone build: `createClient()` returns the local single-admin stub, so
 * both claims and user fallback reads are in-memory and never touch the
 * network.
 */
export async function getAuthedUser(): Promise<AuthedUser | null> {
  const client = await createClient();

  try {
    const { data, error } = await client.auth.getClaims();
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
    // fall through to the local user path
  }

  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) return null;
  return {
    id: user.id,
    email: user.email ?? null,
    app_metadata: (user.app_metadata as Record<string, unknown>) ?? {},
    user_metadata: safeUserMetadata(user.user_metadata as Record<string, unknown>),
  };
}
