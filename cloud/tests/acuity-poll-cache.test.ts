import { describe, expect, it } from "vitest";
import { getCachedCounts, setCachedCounts } from "@/lib/acuity-poll-cache";

// Same phase-1/2 tolerance pattern as tests/acuity-credentials.test.ts: no
// Supabase project is configured in the test environment
// (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY unset), so getSupabaseServerClient()
// throws — both cache functions must fail soft rather than propagate that,
// since a cache is never allowed to be load-bearing for correctness.
describe("acuity poll cache (Supabase unavailable)", () => {
  it("getCachedCounts returns null instead of throwing", async () => {
    await expect(getCachedCounts("2026-08-17", "2026-08-24", 300)).resolves.toBeNull();
  });

  it("setCachedCounts resolves (no-ops) instead of throwing", async () => {
    await expect(
      setCachedCounts("2026-08-17", "2026-08-24", [
        { date: "2026-08-17", appointmentTypeId: 111, appointmentTypeName: "Flu Shot", count: 3 },
      ])
    ).resolves.toBeUndefined();
  });
});
