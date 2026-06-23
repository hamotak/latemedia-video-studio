/**
 * Local single-admin stub that stands in for the Supabase client.
 *
 * This standalone build has no accounts, no login and no cloud database — it
 * runs as one built-in admin on the user's own machine. Every place that used
 * to ask Supabase "who is signed in?" now gets this fixed admin identity, and
 * any leftover `.from(...)` data call resolves to an empty result instead of
 * hitting the network. Real data lives in the local SQLite database.
 */

export const LOCAL_ADMIN_USER = {
  id: "local-admin",
  email: "admin@localhost",
  app_metadata: { role: "admin", provider: "local" },
  user_metadata: { username: "admin", nickname: "Admin", role: "admin" },
  aud: "authenticated",
  created_at: new Date(0).toISOString(),
} as const;

export const LOCAL_ADMIN_CLAIMS = {
  sub: LOCAL_ADMIN_USER.id,
  email: LOCAL_ADMIN_USER.email,
  app_metadata: { role: "admin" },
  user_metadata: { username: "admin", nickname: "Admin", role: "admin" },
  role: "authenticated",
} as const;

/**
 * A chainable, awaitable no-op query builder. Mirrors the shape of the
 * Supabase query builder closely enough that any residual call degrades to an
 * empty result rather than throwing. Kept code reads real data from SQLite, so
 * this should rarely (if ever) be exercised.
 */
function makeQuery(): unknown {
  const emptyList = { data: [] as unknown[], error: null };
  const emptyOne = { data: null as unknown, error: null };
  const builder: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") {
          return (resolve: (v: unknown) => unknown) => resolve(emptyList);
        }
        if (prop === "maybeSingle" || prop === "single") {
          return () => Promise.resolve(emptyOne);
        }
        // Every other method (select/insert/update/delete/upsert/eq/in/order/…)
        // is a chain step that returns the same builder.
        return () => builder;
      },
    }
  );
  return builder;
}

export function localSupabaseClient() {
  return {
    auth: {
      async getUser() {
        return { data: { user: LOCAL_ADMIN_USER }, error: null };
      },
      async getClaims() {
        return { data: { claims: LOCAL_ADMIN_CLAIMS }, error: null };
      },
      async getSession() {
        return {
          data: { session: { user: LOCAL_ADMIN_USER } },
          error: null,
        };
      },
      async updateUser() {
        return { data: { user: LOCAL_ADMIN_USER }, error: null };
      },
      async signOut() {
        return { error: null };
      },
    },
    from() {
      return makeQuery();
    },
  };
}
