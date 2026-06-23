import { localSupabaseClient } from "@/lib/supabase/local-stub";

/**
 * Standalone build: there is no Supabase server. Return the local single-admin
 * stub so existing `await createClient()` call sites keep working unchanged.
 */
export async function createClient() {
  return localSupabaseClient();
}
