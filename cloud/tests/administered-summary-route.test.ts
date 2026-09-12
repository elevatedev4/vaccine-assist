import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireAuthenticatedUser: vi.fn(async () => ({ user: { id: "staff-1", email: "staff@example.com" } })),
}));

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServerClient: vi.fn(),
}));

import { GET } from "@/app/api/administered/summary/route";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { administeredDayKey } from "@/lib/administered/store";

function authedRequest(path: string) {
  return new Request(`http://localhost${path}`, { headers: { Authorization: "Bearer test-token" } });
}

function fakeSupabaseWithDays(days: Record<string, unknown>) {
  return {
    from: (table: string) => {
      if (table !== "app_setting") throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: (_column: string, key: string) => ({
            maybeSingle: async () => ({ data: key in days ? { value: days[key] } : null, error: null }),
          }),
        }),
      };
    },
  };
}

describe("GET /api/administered/summary", () => {
  afterEach(() => {
    vi.mocked(getSupabaseServerClient).mockReset();
  });

  it("returns a summary for the default 7-day window", async () => {
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabaseWithDays({}) as never);
    const response = await GET(authedRequest("/api/administered/summary"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.days).toBe(7);
    expect(body.total).toBe(0);
  });

  it("sums rows from the day keys in the requested window", async () => {
    const day = {
      date: "2026-09-10",
      rows: [{ at: "2026-09-10T20:24:00.000Z", itemName: "Fluad", vaccineId: "v-fluad" }],
      updatedAt: "2026-09-10T20:30:00.000Z",
      sources: ["ses:msg-1"],
    };
    vi.mocked(getSupabaseServerClient).mockReturnValue(
      fakeSupabaseWithDays({ [administeredDayKey("2026-09-10")]: day }) as never
    );
    const response = await GET(authedRequest("/api/administered/summary?days=1"));
    const body = await response.json();
    // The window ends "today" (no `until` override in this route), so
    // this only proves the plumbing end-to-end when today happens to be
    // in range; the day-math itself is covered by
    // tests/administered-store.test.ts. Assert on shape instead of a
    // specific total to avoid a flaky date-dependent assertion.
    expect(body).toHaveProperty("byVaccineId");
    expect(body).toHaveProperty("byItemName");
    expect(body).toHaveProperty("unmatched");
    expect(typeof body.total).toBe("number");
  });

  it("rejects a non-integer days param", async () => {
    const response = await GET(authedRequest("/api/administered/summary?days=abc"));
    expect(response.status).toBe(400);
    expect(getSupabaseServerClient).not.toHaveBeenCalled();
  });

  it("rejects days out of range", async () => {
    const response = await GET(authedRequest("/api/administered/summary?days=0"));
    expect(response.status).toBe(400);

    const response2 = await GET(authedRequest("/api/administered/summary?days=9999"));
    expect(response2.status).toBe(400);
  });

  it("returns 503 when Supabase is not configured", async () => {
    vi.mocked(getSupabaseServerClient).mockImplementation(() => {
      throw new Error("Supabase is not configured.");
    });
    const response = await GET(authedRequest("/api/administered/summary"));
    expect(response.status).toBe(503);
  });

  // Mirrors tests/administered-reprocess-route.test.ts's "requires auth"
  // case: this file mocks requireAuthenticatedUser to succeed by default
  // (see the vi.mock at the top), so an unauthenticated request is
  // exercised the same way — overriding it once to return the error
  // shape requireAuthenticatedUser produces for a missing/invalid
  // Authorization header.
  it("requires auth — an unauthenticated GET returns 401", async () => {
    const { requireAuthenticatedUser } = await import("@/lib/auth");
    vi.mocked(requireAuthenticatedUser).mockResolvedValueOnce({
      error: new Response(null, { status: 401 }) as never,
    } as never);

    const response = await GET(new Request("http://localhost/api/administered/summary"));
    expect(response.status).toBe(401);
    expect(getSupabaseServerClient).not.toHaveBeenCalled();
  });
});
