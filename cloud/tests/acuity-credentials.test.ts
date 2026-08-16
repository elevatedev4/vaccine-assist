import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAcuityCredentials, getAcuityCredentialsStatus } from "@/lib/acuity-credentials";

// Phase 1: no Supabase project is configured in the test environment
// (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY unset), so getSupabaseServerClient()
// throws and these helpers fall through to the env-var fallback path — same
// behavior real deploys hit before the acuity_credentials table has a row.
// The "database" source path is exercised indirectly by
// tests/settings-acuity-route.test.ts's auth-gate coverage; a full
// Supabase-backed test would require mocking the query builder, which no
// other test in this suite does either (see tests/acuity-poll-route.test.ts).
const ACUITY_ENV_KEYS = ["ACUITY_USER_ID", "ACUITY_API_KEY"] as const;

describe("getAcuityCredentials / getAcuityCredentialsStatus", () => {
  beforeEach(() => {
    for (const key of ACUITY_ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    for (const key of ACUITY_ENV_KEYS) delete process.env[key];
  });

  it("returns null / not-configured when nothing is set", async () => {
    expect(await getAcuityCredentials()).toBeNull();

    const status = await getAcuityCredentialsStatus();
    expect(status).toEqual({
      configured: false,
      source: "none",
      acuityUserId: null,
      last4: null,
      updatedAt: null,
      updatedBy: null,
    });
  });

  it("falls back to env vars when the database is unavailable", async () => {
    process.env.ACUITY_USER_ID = "12345";
    process.env.ACUITY_API_KEY = "test-key-abcd";

    const credentials = await getAcuityCredentials();
    expect(credentials).toEqual({ userId: "12345", apiKey: "test-key-abcd", source: "env" });

    const status = await getAcuityCredentialsStatus();
    expect(status).toEqual({
      configured: true,
      source: "env",
      acuityUserId: "12345",
      last4: "abcd",
      updatedAt: null,
      updatedBy: null,
    });
  });

  it("does not treat a partial env config as configured", async () => {
    process.env.ACUITY_USER_ID = "12345";
    // ACUITY_API_KEY intentionally left unset.

    expect(await getAcuityCredentials()).toBeNull();
    expect((await getAcuityCredentialsStatus()).configured).toBe(false);
  });
});
