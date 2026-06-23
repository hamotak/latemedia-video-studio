import { localSupabaseClient } from "@/lib/supabase/local-stub";

/**
 * Standalone build: there is no Supabase project. Return the local
 * single-admin stub so browser components that read `createClient().auth.*`
 * keep working without any network calls or login.
 */
export function createClient() {
  return localSupabaseClient();
}
