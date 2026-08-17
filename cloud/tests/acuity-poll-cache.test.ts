import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServerClient: vi.fn(),
}));

import { getCachedCounts, setCachedCounts } from "@/lib/acuity-poll-cache";
import { getSupabaseServerClient } from "@/lib/supabase/server";

// Minimal stand-in for the subset of the Supabase query builder that
// lib/acuity-poll-cache.ts actually calls: .from().select().eq().maybeSingle()
// for reads, .from().upsert() for writes.
function fakeSupabaseClient(row: unknown, upsert = vi.fn(async () => ({ error: null }))) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: row, error: null }),
        }),
      }),
      upsert,
    }),
  };
}

describe("acuity poll cache", () => {
  afterEach(() => {
    vi.mocked(getSupabaseServerClient).mockReset();
  });

  // Same phase-1/2 tolerance pattern as tests/acuity-credentials.test.ts —
  // a cache is never allowed to be load-bearing for correctness.
  it("getCachedCounts returns null instead of throwing when Supabase is unavailable", async () => {
    vi.mocked(getSupabaseServerClient).mockImplementation(() => {
      throw new Error("Supabase server client requested but not configured.");
    });

    await expect(getCachedCounts("2026-08-17", "2026-08-24", 300)).resolves.toBeNull();
  });

  it("setCachedCounts resolves (no-ops) instead of throwing when Supabase is unavailable", async () => {
    vi.mocked(getSupabaseServerClient).mockImplementation(() => {
      throw new Error("Supabase server client requested but not configured.");
    });

    await expect(
      setCachedCounts(
        "2026-08-17",
        "2026-08-24",
        [{ date: "2026-08-17", appointmentTypeId: 111, appointmentTypeName: "Flu Shot", count: 3 }],
        false
      )
    ).resolves.toBeUndefined();
  });

  it("returns null when the cached row's computed_at is older than ttlSeconds (TTL expiry)", async () => {
    const staleComputedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago
    vi.mocked(getSupabaseServerClient).mockReturnValue(
      fakeSupabaseClient({ counts: [], computed_at: staleComputedAt, possibly_truncated: false }) as never
    );

    // 300s (5 min) ttl — a 10-minute-old row is stale.
    await expect(getCachedCounts("2026-08-17", "2026-08-24", 300)).resolves.toBeNull();
  });

  it("returns the cached payload, including possiblyTruncated, when still within ttlSeconds", async () => {
    const freshComputedAt = new Date(Date.now() - 60 * 1000).toISOString(); // 1 min ago
    const counts = [{ date: "2026-08-17", appointmentTypeId: 111, appointmentTypeName: "Flu Shot", count: 5 }];
    vi.mocked(getSupabaseServerClient).mockReturnValue(
      fakeSupabaseClient({ counts, computed_at: freshComputedAt, possibly_truncated: true }) as never
    );

    const result = await getCachedCounts("2026-08-17", "2026-08-24", 300);

    expect(result).toEqual({ counts, possiblyTruncated: true, computedAt: freshComputedAt });
  });

  it("setCachedCounts upserts range_key and possibly_truncated", async () => {
    const upsert = vi.fn(async () => ({ error: null }));
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from: () => ({ upsert }) } as never);

    await setCachedCounts("2026-08-17", "2026-08-24", [], true);

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        range_key: "2026-08-17_2026-08-24",
        range_start: "2026-08-17",
        range_end: "2026-08-24",
        possibly_truncated: true,
      })
    );
  });
});
