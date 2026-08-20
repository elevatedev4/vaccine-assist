import { afterEach, describe, expect, it, vi } from "vitest";

// Same pattern as tests/acuity-poll-route-validation.test.ts: mock
// requireAuthenticatedUser to always succeed so the route's OWN logic
// (includeInactive filtering, hasActiveLot join, PATCH body validation
// and the actual Supabase update) can be exercised directly. The real
// 401-with-no-header auth gate is covered separately in
// tests/vaccines-route.test.ts (unmocked, so it hits the real check).
vi.mock("@/lib/auth", () => ({
  requireAuthenticatedUser: vi.fn(async () => ({ user: { id: "staff-1", email: "staff@example.com" } })),
}));

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServerClient: vi.fn(),
}));

import { GET } from "@/app/api/vaccines/route";
import { PATCH } from "@/app/api/vaccines/[id]/route";
import { getSupabaseServerClient } from "@/lib/supabase/server";

function authedRequest(path: string, init?: RequestInit) {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: { Authorization: "Bearer test-token", ...(init?.headers ?? {}) },
  });
}

describe("GET /api/vaccines", () => {
  afterEach(() => {
    vi.mocked(getSupabaseServerClient).mockReset();
  });

  it("default (no query param) returns only active vaccines — regression guard for the Lots and Data-entry dropdowns, which rely on this staying unfiltered by query param", async () => {
    const order = vi.fn(async () => ({
      data: [{ id: "v1", name: "Flu", active: true }],
      error: null,
    }));
    const eq = vi.fn(() => ({ order }));
    const select = vi.fn(() => ({ eq }));
    const from = vi.fn((table: string) => {
      if (table !== "vaccine") throw new Error(`unexpected table ${table} on default GET`);
      return { select };
    });
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from } as never);

    const response = await GET(authedRequest("/api/vaccines"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.vaccines).toEqual([{ id: "v1", name: "Flu", active: true }]);
    // Regression guard: the default path must still filter on active=true
    // and must never touch the `lot` table (that join only runs for
    // includeInactive=true, see the other test below).
    expect(eq).toHaveBeenCalledWith("active", true);
    expect(from).not.toHaveBeenCalledWith("lot");
    expect(body.vaccines[0].hasActiveLot).toBeUndefined();
  });

  it("?includeInactive=true returns both active and inactive vaccines with hasActiveLot populated from the lot table", async () => {
    const vaccines = [
      { id: "v1", name: "Flu", active: true },
      { id: "v2", name: "COVID", active: false },
      { id: "v3", name: "Shingles", active: true },
    ];
    const activeLots = [{ vaccine_id: "v1" }, { vaccine_id: "v3" }];

    const from = vi.fn((table: string) => {
      if (table === "vaccine") {
        return {
          select: () => ({
            order: async () => ({ data: vaccines, error: null }),
          }),
        };
      }
      if (table === "lot") {
        return {
          select: () => ({
            eq: async (column: string, value: string) => {
              expect(column).toBe("status");
              expect(value).toBe("active");
              return { data: activeLots, error: null };
            },
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    });
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from } as never);

    const response = await GET(authedRequest("/api/vaccines?includeInactive=true"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.vaccines).toEqual([
      { id: "v1", name: "Flu", active: true, hasActiveLot: true },
      { id: "v2", name: "COVID", active: false, hasActiveLot: false },
      { id: "v3", name: "Shingles", active: true, hasActiveLot: true },
    ]);
  });

  it("returns 500 when the includeInactive lot lookup errors", async () => {
    const from = vi.fn((table: string) => {
      if (table === "vaccine") {
        return { select: () => ({ order: async () => ({ data: [], error: null }) }) };
      }
      return { select: () => ({ eq: async () => ({ data: null, error: new Error("boom") }) }) };
    });
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from } as never);

    const response = await GET(authedRequest("/api/vaccines?includeInactive=true"));
    expect(response.status).toBe(500);
  });
});

describe("PATCH /api/vaccines/[id]", () => {
  afterEach(() => {
    vi.mocked(getSupabaseServerClient).mockReset();
  });

  it("updates active and returns the updated row", async () => {
    const single = vi.fn(async () => ({
      data: { id: "v1", name: "Flu", active: false },
      error: null,
    }));
    const select = vi.fn(() => ({ single }));
    const eq = vi.fn(() => ({ select }));
    const update = vi.fn(() => ({ eq }));
    const from = vi.fn((table: string) => {
      if (table !== "vaccine") throw new Error(`unexpected table ${table}`);
      return { update };
    });
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from } as never);

    const response = await PATCH(
      authedRequest("/api/vaccines/v1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: false }),
      }),
      { params: Promise.resolve({ id: "v1" }) }
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.vaccine).toEqual({ id: "v1", name: "Flu", active: false });
    expect(update).toHaveBeenCalledWith({ active: false });
    expect(eq).toHaveBeenCalledWith("id", "v1");
  });

  it("rejects a non-boolean active value", async () => {
    const response = await PATCH(
      authedRequest("/api/vaccines/v1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: "yes" }),
      }),
      { params: Promise.resolve({ id: "v1" }) }
    );

    expect(response.status).toBe(400);
    // Supabase must never be touched once body validation fails.
    expect(getSupabaseServerClient).not.toHaveBeenCalled();
  });

  it("rejects a missing active field", async () => {
    const response = await PATCH(
      authedRequest("/api/vaccines/v1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ id: "v1" }) }
    );

    expect(response.status).toBe(400);
  });
});
