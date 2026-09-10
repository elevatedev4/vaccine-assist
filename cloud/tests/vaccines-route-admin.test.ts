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

import { GET, POST } from "@/app/api/vaccines/route";
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

  // V-cloud-tabs: editable quantity/directions on the Active vaccines page.
  it("updates quantity and directions together", async () => {
    const single = vi.fn(async () => ({
      data: { id: "v1", name: "Flu", quantity: "0.5 mL", directions: "1 dose IM x1" },
      error: null,
    }));
    const select = vi.fn(() => ({ single }));
    const eq = vi.fn(() => ({ select }));
    const update = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ update }));
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from } as never);

    const response = await PATCH(
      authedRequest("/api/vaccines/v1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quantity: "0.5 mL", directions: "1 dose IM x1" }),
      }),
      { params: Promise.resolve({ id: "v1" }) }
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.vaccine).toEqual({ id: "v1", name: "Flu", quantity: "0.5 mL", directions: "1 dose IM x1" });
    expect(body.quantityDirectionsSupported).toBe(true);
    expect(update).toHaveBeenCalledWith({ quantity: "0.5 mL", directions: "1 dose IM x1" });
  });

  it("rejects a non-string, non-null quantity", async () => {
    const response = await PATCH(
      authedRequest("/api/vaccines/v1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quantity: 5 }),
      }),
      { params: Promise.resolve({ id: "v1" }) }
    );
    expect(response.status).toBe(400);
    expect(getSupabaseServerClient).not.toHaveBeenCalled();
  });

  it("degrades gracefully pre-migration: retries without quantity/directions and flags them unsupported", async () => {
    const missingColumnError = { code: "42703", message: 'column "quantity" of relation "vaccine" does not exist' };
    let updateCallCount = 0;
    const single = vi.fn(async () => ({ data: { id: "v1", name: "Flu", active: true }, error: null }));
    const select = vi.fn(() => ({ single }));
    const eq = vi.fn(() => ({ select }));
    const update = vi.fn((payload: Record<string, unknown>) => {
      updateCallCount += 1;
      if (updateCallCount === 1) {
        // First attempt (with quantity/directions) fails.
        return {
          eq: () => ({
            select: () => ({ single: async () => ({ data: null, error: missingColumnError }) }),
          }),
        };
      }
      return { eq };
    });
    const from = vi.fn(() => ({ update }));
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from } as never);

    const response = await PATCH(
      authedRequest("/api/vaccines/v1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: true, quantity: "0.5 mL" }),
      }),
      { params: Promise.resolve({ id: "v1" }) }
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.quantityDirectionsSupported).toBe(false);
    // Retried with only `active` — quantity dropped.
    expect(update).toHaveBeenNthCalledWith(2, { active: true });
  });

  // --- V-onhand-pioneer-ndc-match additions (Will 2026-09-09 4:31pm:
  // "so I can persist the researched package NDCs via the API") --------

  it("persists a valid ndc, dashed 5-4-2, even when it arrives undashed", async () => {
    const single = vi.fn(async () => ({
      data: { id: "v1", name: "Flucelvax PFS", ndc: "70461-0656-03" },
      error: null,
    }));
    const select = vi.fn(() => ({ single }));
    const eq = vi.fn(() => ({ select }));
    const update = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ update }));
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from } as never);

    const response = await PATCH(
      authedRequest("/api/vaccines/v1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ndc: "70461065603" }),
      }),
      { params: Promise.resolve({ id: "v1" }) }
    );

    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalledWith({ ndc: "70461-0656-03" });
  });

  it("left-pads a 10-digit ndc to 11 digits before formatting", async () => {
    const single = vi.fn(async () => ({ data: { id: "v1" }, error: null }));
    const select = vi.fn(() => ({ single }));
    const eq = vi.fn(() => ({ select }));
    const update = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ update }));
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from } as never);

    await PATCH(
      authedRequest("/api/vaccines/v1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ndc: "1234567890" }), // 10 digits
      }),
      { params: Promise.resolve({ id: "v1" }) }
    );

    expect(update).toHaveBeenCalledWith({ ndc: "01234-5678-90" });
  });

  it("clears ndc when given null", async () => {
    const single = vi.fn(async () => ({ data: { id: "v1", ndc: null }, error: null }));
    const select = vi.fn(() => ({ single }));
    const eq = vi.fn(() => ({ select }));
    const update = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ update }));
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from } as never);

    await PATCH(
      authedRequest("/api/vaccines/v1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ndc: null }),
      }),
      { params: Promise.resolve({ id: "v1" }) }
    );

    expect(update).toHaveBeenCalledWith({ ndc: null });
  });

  it("rejects an ndc that isn't 10-11 digits", async () => {
    const response = await PATCH(
      authedRequest("/api/vaccines/v1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ndc: "123" }),
      }),
      { params: Promise.resolve({ id: "v1" }) }
    );
    expect(response.status).toBe(400);
    expect(getSupabaseServerClient).not.toHaveBeenCalled();
  });

  it("rejects a non-string, non-null ndc", async () => {
    const response = await PATCH(
      authedRequest("/api/vaccines/v1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ndc: 12345678901 }),
      }),
      { params: Promise.resolve({ id: "v1" }) }
    );
    expect(response.status).toBe(400);
  });

  it("returns 409 when quantity/directions is the ONLY thing to update and the columns don't exist yet", async () => {
    const missingColumnError = { code: "42703", message: 'column "quantity" of relation "vaccine" does not exist' };
    const update = vi.fn(() => ({
      eq: () => ({
        select: () => ({ single: async () => ({ data: null, error: missingColumnError }) }),
      }),
    }));
    const from = vi.fn(() => ({ update }));
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from } as never);

    const response = await PATCH(
      authedRequest("/api/vaccines/v1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quantity: "0.5 mL" }),
      }),
      { params: Promise.resolve({ id: "v1" }) }
    );

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.quantityDirectionsSupported).toBe(false);
  });
});

// --- V-T-ordering-lots-round4: POST /api/vaccines (create one vaccine row,
// used by the manager to create Abrysvo's inactive 1-count product) ------
describe("POST /api/vaccines", () => {
  afterEach(() => {
    vi.mocked(getSupabaseServerClient).mockReset();
  });

  // Two duplicate-checking selects happen before the insert: one for the
  // name (ilike), one for the derived short_code (eq) — see
  // deriveShortCode in the route. Both return no matches here.
  function noExistingMatchesFrom() {
    return {
      select: () => ({
        ilike: async () => ({ data: [], error: null }),
        eq: async () => ({ data: [], error: null }),
      }),
    };
  }

  it("creates a vaccine with just a name, defaulting active to true and ndc to null, and derives short_code from the name", async () => {
    const single = vi.fn(async () => ({
      data: { id: "v1", name: "Abrysvo (1 ct)", ndc: null, active: true, short_code: "abrysvo-1-ct" },
      error: null,
    }));
    const select = vi.fn(() => ({ single }));
    const insert = vi.fn(() => ({ select }));
    let call = 0;
    const from = vi.fn(() => {
      call += 1;
      if (call <= 2) return noExistingMatchesFrom();
      return { insert };
    });
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from } as never);

    const response = await POST(
      authedRequest("/api/vaccines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Abrysvo (1 ct)" }),
      })
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.vaccine).toEqual({ id: "v1", name: "Abrysvo (1 ct)", ndc: null, active: true, short_code: "abrysvo-1-ct" });
    expect(insert).toHaveBeenCalledWith({ name: "Abrysvo (1 ct)", ndc: null, active: true, short_code: "abrysvo-1-ct" });
  });

  it("trims the name and formats a valid ndc via lib/ndc.ts's formatNdcForStorage", async () => {
    const single = vi.fn(async () => ({ data: { id: "v1" }, error: null }));
    const select = vi.fn(() => ({ single }));
    const insert = vi.fn(() => ({ select }));
    let call = 0;
    const from = vi.fn(() => {
      call += 1;
      if (call <= 2) return noExistingMatchesFrom();
      return { insert };
    });
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from } as never);

    await POST(
      authedRequest("/api/vaccines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "  Abrysvo (1 ct)  ", ndc: "00069246501", active: false }),
      })
    );

    expect(insert).toHaveBeenCalledWith({
      name: "Abrysvo (1 ct)",
      ndc: "00069-2465-01",
      active: false,
      short_code: "abrysvo-1-ct",
    });
  });

  it("rejects a duplicate short_code (derived from a different name) with 409, without inserting", async () => {
    let call = 0;
    const from = vi.fn(() => {
      call += 1;
      if (call === 1) {
        // Name check: no match.
        return { select: () => ({ ilike: async () => ({ data: [], error: null }) }) };
      }
      // short_code check: a match.
      return { select: () => ({ eq: async () => ({ data: [{ id: "v0", short_code: "abrysvo-1-ct" }], error: null }) }) };
    });
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from } as never);

    const response = await POST(
      authedRequest("/api/vaccines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Abrysvo, (1 ct)" }),
      })
    );
    expect(response.status).toBe(409);
  });

  it("rejects a missing/empty name without touching Supabase", async () => {
    const response = await POST(
      authedRequest("/api/vaccines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "   " }),
      })
    );
    expect(response.status).toBe(400);
    expect(getSupabaseServerClient).not.toHaveBeenCalled();
  });

  it("rejects a name over 120 characters", async () => {
    const response = await POST(
      authedRequest("/api/vaccines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "x".repeat(121) }),
      })
    );
    expect(response.status).toBe(400);
    expect(getSupabaseServerClient).not.toHaveBeenCalled();
  });

  it("rejects an ndc that isn't 10-11 digits", async () => {
    const response = await POST(
      authedRequest("/api/vaccines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Test Vaccine", ndc: "123" }),
      })
    );
    expect(response.status).toBe(400);
    expect(getSupabaseServerClient).not.toHaveBeenCalled();
  });

  it("rejects a non-boolean active value", async () => {
    const response = await POST(
      authedRequest("/api/vaccines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Test Vaccine", active: "yes" }),
      })
    );
    expect(response.status).toBe(400);
    expect(getSupabaseServerClient).not.toHaveBeenCalled();
  });

  it("rejects a duplicate name (case-insensitive) with 409, without inserting", async () => {
    const from = vi.fn(() => ({
      select: () => ({ ilike: async () => ({ data: [{ id: "v0", name: "abrysvo" }], error: null }) }),
    }));
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from } as never);

    const response = await POST(
      authedRequest("/api/vaccines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Abrysvo" }),
      })
    );
    expect(response.status).toBe(409);
  });

  it("logs the actual Supabase error message and returns 500 when the insert itself fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const insertError = { message: "duplicate key value violates unique constraint", code: "23505" };
    let call = 0;
    const from = vi.fn(() => {
      call += 1;
      if (call <= 2) return noExistingMatchesFrom();
      return {
        insert: () => ({ select: () => ({ single: async () => ({ data: null, error: insertError }) }) }),
      };
    });
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from } as never);

    const response = await POST(
      authedRequest("/api/vaccines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Abrysvo (1 ct)" }),
      })
    );

    expect(response.status).toBe(500);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(insertError.message), insertError);
    errorSpy.mockRestore();
  });

});

describe("GET /api/vaccines — quantityDirectionsSupported degradation", () => {
  afterEach(() => {
    vi.mocked(getSupabaseServerClient).mockReset();
  });

  it("flags quantityDirectionsSupported: true when the columns are present", async () => {
    const order = vi.fn(async () => ({ data: [{ id: "v1", name: "Flu" }], error: null }));
    const eq = vi.fn(() => ({ order }));
    const select = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ select }));
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from } as never);

    const response = await GET(authedRequest("/api/vaccines"));
    const body = await response.json();
    expect(body.quantityDirectionsSupported).toBe(true);
  });

  it("retries without quantity/directions and flags false when the columns are missing", async () => {
    const missingColumnError = { code: "42703", message: 'column "quantity" does not exist' };
    let selectCallCount = 0;
    const select = vi.fn(() => {
      selectCallCount += 1;
      if (selectCallCount === 1) {
        return { eq: () => ({ order: async () => ({ data: null, error: missingColumnError }) }) };
      }
      return { eq: () => ({ order: async () => ({ data: [{ id: "v1", name: "Flu" }], error: null }) }) };
    });
    const from = vi.fn(() => ({ select }));
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from } as never);

    const response = await GET(authedRequest("/api/vaccines"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.quantityDirectionsSupported).toBe(false);
    expect(body.vaccines).toEqual([{ id: "v1", name: "Flu" }]);
  });
});
