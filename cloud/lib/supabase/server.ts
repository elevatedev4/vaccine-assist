import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";

/**
 * Server-side Supabase client using the service-role key. Only ever
 * import this from route handlers / server components — never from
 * anything that ships to the browser.
 *
 * Phase 1: no Supabase project exists yet, so this throws lazily (only
 * when a caller actually tries to use it) rather than at module load,
 * which would break `next build`.
 */
let cached: SupabaseClient | null = null;

export function getSupabaseServerClient(): SupabaseClient {
  if (cached) return cached;

  const url = env.supabaseUrl();
  const serviceRoleKey = env.supabaseServiceRoleKey();

  if (!url || !serviceRoleKey) {
    throw new Error(
      "Supabase server client requested but SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY " +
        "are not configured. This is expected in phase 1 (no Supabase project exists " +
        "yet) — set both once the project is provisioned."
    );
  }

  cached = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}
