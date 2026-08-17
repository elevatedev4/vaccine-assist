import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";

/**
 * Browser-safe Supabase client (anon key only). Backs the /settings
 * sign-in flow (one shared pharmacy login via Supabase Auth,
 * email/password) — the desktop app authenticates directly against
 * Supabase and never touches this client.
 *
 * persistSession/autoRefreshToken are supabase-js's browser defaults,
 * but set explicitly here so a session survives refresh/nav: without
 * this, a page that only tracks the token in component state loses it
 * on every reload with no indication anything changed.
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

  cached = createClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
    },
  });
  return cached;
}
