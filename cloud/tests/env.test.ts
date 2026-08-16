import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "@/lib/env";

// publicSupabaseUrl/publicSupabaseAnonKey must read process.env via a
// literal `process.env.NEXT_PUBLIC_X` member expression, not a dynamic
// `process.env[name]` lookup — Next.js's client bundler only statically
// inlines the literal form into browser bundles. A dynamic lookup reads
// fine under plain Node/vitest (this test would pass either way) but is
// always undefined in the actual browser bundle, which is what broke the
// /settings sign-in form in production even though the vars were set in
// Vercel. See lib/env.ts for the full explanation.
const PUBLIC_ENV_KEYS = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"] as const;

describe("env.publicSupabaseUrl / env.publicSupabaseAnonKey", () => {
  beforeEach(() => {
    for (const key of PUBLIC_ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    for (const key of PUBLIC_ENV_KEYS) delete process.env[key];
  });

  it("returns undefined when unset", () => {
    expect(env.publicSupabaseUrl()).toBeUndefined();
    expect(env.publicSupabaseAnonKey()).toBeUndefined();
  });

  it("returns the value as-is when set (matches readOptional: only the emptiness check is trimmed, not the return value)", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key-abc";

    expect(env.publicSupabaseUrl()).toBe("https://example.supabase.co");
    expect(env.publicSupabaseAnonKey()).toBe("anon-key-abc");
  });

  it("treats an empty/whitespace-only value as unset", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "   ";

    expect(env.publicSupabaseUrl()).toBeUndefined();
  });
});
