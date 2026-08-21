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

// Same trim/empty->undefined semantics as readOptional, but takes the value
// directly instead of a dynamic process.env[name] lookup. Next.js's client
// bundler only inlines NEXT_PUBLIC_* vars when it sees a literal
// `process.env.NEXT_PUBLIC_X` member expression at build time — a dynamic
// `process.env[name]` (what readOptional does) is invisible to that static
// replacement, so in the browser it's always undefined even when the var is
// set in Vercel. publicSupabaseUrl/publicSupabaseAnonKey are the only two of
// these accessors ever called from client code (lib/supabase/client.ts), so
// they're the only two that need the literal-access form.
function readValue(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined;
}

export const env = {
  supabaseUrl: () => readOptional("SUPABASE_URL"),
  supabaseAnonKey: () => readOptional("SUPABASE_ANON_KEY"),
  supabaseServiceRoleKey: () => readOptional("SUPABASE_SERVICE_ROLE_KEY"),
  publicSupabaseUrl: () => readValue(process.env.NEXT_PUBLIC_SUPABASE_URL),
  publicSupabaseAnonKey: () => readValue(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
  acuityUserId: () => readOptional("ACUITY_USER_ID"),
  acuityApiKey: () => readOptional("ACUITY_API_KEY"),
  acuityPollCacheSeconds: () => {
    const raw = readOptional("ACUITY_POLL_CACHE_SECONDS");
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 300;
  },
  sesWebhookSecret: () => readOptional("SES_WEBHOOK_SECRET"),
  // --- Outbound email (SES) — see lib/email.ts. Same pattern as
  // ~/claude/elevate and ~/claude/clarify's lib/email.ts (Will, V-T3 item
  // 5: "Use amazon SES for email like we use in other apps"), but reading
  // through this file's existing readOptional (already trims — Vercel CLI
  // env vars can carry trailing whitespace, see
  // reference_vercel_env_newline_headers) instead of a second ad hoc
  // trim helper duplicating that logic.
  awsRegion: () => readOptional("AWS_REGION") ?? "us-east-1",
  awsAccessKeyId: () => readOptional("AWS_ACCESS_KEY_ID"),
  awsSecretAccessKey: () => readOptional("AWS_SECRET_ACCESS_KEY"),
  sesFromAddress: () => readOptional("SES_FROM") ?? "noreply@orchardsdrug.com",
};
