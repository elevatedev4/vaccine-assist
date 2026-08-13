/**
 * Typed access to environment variables, with placeholder-safe reads.
 *
 * Phase 1: the Supabase project for this app doesn't exist yet, so these
 * accessors deliberately never throw when a value is missing — callers
 * that need a real value (the Supabase clients) surface a clear runtime
 * error only at the moment they'd actually make a network call, not at
 * import/build time. This keeps `next build` green from .env.example
 * placeholders alone.
 */

function readOptional(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value : undefined;
}

export const env = {
  supabaseUrl: () => readOptional("SUPABASE_URL"),
  supabaseAnonKey: () => readOptional("SUPABASE_ANON_KEY"),
  supabaseServiceRoleKey: () => readOptional("SUPABASE_SERVICE_ROLE_KEY"),
  publicSupabaseUrl: () => readOptional("NEXT_PUBLIC_SUPABASE_URL"),
  publicSupabaseAnonKey: () => readOptional("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  acuityUserId: () => readOptional("ACUITY_USER_ID"),
  acuityApiKey: () => readOptional("ACUITY_API_KEY"),
  acuityPollCacheSeconds: () => {
    const raw = readOptional("ACUITY_POLL_CACHE_SECONDS");
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 300;
  },
  sesWebhookSecret: () => readOptional("SES_WEBHOOK_SECRET"),
};
