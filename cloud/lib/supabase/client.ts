import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";

/**
 * Browser-safe Supabase client (anon key only). Used by the future
 * reporting UI (skipped in phase 1) — kept here so the desktop app and
 * cloud app share the same auth model (one shared pharmacy login via
 * Supabase Auth, email/password) without duplicating client setup logic.
 */
let cached: SupabaseClient | null = null;

export function getSupabaseBrowserClient(): SupabaseClient {
  if (cached) return cached;

  const url = env.publicSupabaseUrl();
  const anonKey = env.publicSupabaseAnonKey();

  if (!url || !anonKey) {
    throw new Error(
      "Supabase browser client requested but NEXT_PUBLIC_SUPABASE_URL / " +
        "NEXT_PUBLIC_SUPABASE_ANON_KEY are not configured."
    );
  }

  cached = createClient(url, anonKey);
  return cached;
}
