import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireAuthenticatedUser: vi.fn(async () => ({ user: { id: "staff-1", email: "staff@example.com" } })),
}));

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServerClient: vi.fn(),
}));

import { GET, POST } from "@/app/api/lots/route";
import { PATCH } from "@/app/api/lots/[id]/route";
import { getSupabaseServerClient } from "@/lib/supabase/server";

function authedRequest(path: string, init?: RequestInit) {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: { Authorization: "Bearer test-token", ...(init?.headers ?? {}) },
  });
}

const MISSING_BUD_COLUMN = { code: "42703", message: 'column "beyond_use_date" of relation "lot" does not exist' };

describe("GET /api/lots", () => {
  afterEach(() => {
    vi.mocked(getSupabaseServerClient).mockReset();
  });

  it("returns lots with beyondUseDateSupported: true when the column is present", async () => {
    const order = vi.fn(async () => ({ data: [{ id: "l1", vaccine_id: "v1" }], error: null }));
    const select = vi.fn(() => ({ order }));
    const from = vi.fn(() => ({ select }));
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from } as never);

    const response = await GET(authedRequest("/api/lots"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.lots).toEqual([{ id: "l1", vaccine_id: "v1" }]);
    expect(body.beyondUseDateSupported).toBe(true);
  });

  it("retries without beyond_use_date and flags it unsupported when the column is missing", async () => {
    let orderCallCount = 0;
    const order = vi.fn(async () => {
      orderCallCount += 1;
      if (orderCallCount === 1) return { data: null, error: MISSING_BUD_COLUMN };
      return { data: [{ id: "l1", vaccine_id: "v1" }], error: null };
    });
    const select = vi.fn(() => ({ order }));
    const from = vi.fn(() => ({ select }));
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from } as never);

    const response = await GET(authedRequest("/api/lots"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.beyondUseDateSupported).toBe(false);
    expect(body.lots).toEqual([{ id: "l1", vaccine_id: "v1" }]);
    expect(orderCallCount).toBe(2);
  });

  it("applies vaccineId and status filters, chained after order() the same way the real PostgrestFilterBuilder does", async () => {
    const eqCalls: Array<[string, string]> = [];
    // Mimics supabase-js's real builder shape: .order() and .eq() both
    // return the SAME chainable, thenable builder object (not a Promise
    // directly) — .eq() can keep being chained, and awaiting the builder
    // at any point resolves via its .then().
    type Builder = { eq: (column: string, value: string) => Builder; then: (resolve: (v: { data: unknown[]; error: null }) => void) => void };
    function makeBuilder(): Builder {
      const builder: Builder = {
        eq: vi.fn((column: string, value: string) => {
          eqCalls.push([column, value]);
          return builder;
        }),
        then: (resolve) => resolve({ data: [], error: null }),
      };
      return builder;
    }
    const order = vi.fn(() => makeBuilder());
    const select = vi.fn(() => ({ order }));
    const from = vi.fn(() => ({ select }));
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from } as never);

    await GET(authedRequest("/api/lots?vaccineId=v1&status=active"));
    expect(eqCalls).toEqual([
      ["vaccine_id", "v1"],
      ["status", "active"],
    ]);
  });

  it("returns 500 on a genuine (non-missing-column) error", async () => {
    const order = vi.fn(async () => ({ data: null, error: new Error("boom") }));
    const select = vi.fn(() => ({ order }));
    const from = vi.fn(() => ({ select }));
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from } as never);

    const response = await GET(authedRequest("/api/lots"));
    expect(response.status).toBe(500);
  });
});

describe("POST /api/lots", () => {
  afterEach(() => {
    vi.mocked(getSupabaseServerClient).mockReset();
  });

  it("requires vaccine_id, lot_number, and expiration", async () => {
    const response = await POST(
      authedRequest("/api/lots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vaccine_id: "v1" }),
      })
    );
    expect(response.status).toBe(400);
  });

  it("creates a lot with beyond_use_date when supported", async () => {
    const single = vi.fn(async () => ({
      data: { id: "l1", vaccine_id: "v1", lot_number: "ABC", expiration: "2027-01-01", beyond_use_date: "2026-12-01" },
      error: null,
    }));
    const select = vi.fn(() => ({ single }));
    const insert = vi.fn(() => ({ select }));
    const from = vi.fn(() => ({ insert }));
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from } as never);

    const response = await POST(
      authedRequest("/api/lots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vaccine_id: "v1",
          lot_number: "ABC",
          expiration: "2027-01-01",
          beyond_use_date: "2026-12-01",
        }),
      })
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.beyondUseDateSupported).toBe(true);
    expect(insert).toHaveBeenCalledWith({
      vaccine_id: "v1",
      lot_number: "ABC",
      expiration: "2027-01-01",
      status: "active",
      note: undefined,
      beyond_use_date: "2026-12-01",
    });
  });

  it("degrades gracefully: retries without beyond_use_date and flags it unsupported", async () => {
    let insertCallCount = 0;
    const insert = vi.fn((payload: Record<string, unknown>) => {
      insertCallCount += 1;
      if (insertCallCount === 1) {
        return { select: () => ({ single: async () => ({ data: null, error: MISSING_BUD_COLUMN }) }) };
      }
      return {
        select: () => ({
          single: async () => ({ data: { id: "l1", ...payload }, error: null }),
        }),
      };
    });
    const from = vi.fn(() => ({ insert }));
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from } as never);

    const response = await POST(
      authedRequest("/api/lots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vaccine_id: "v1",
          lot_number: "ABC",
          expiration: "2027-01-01",
          beyond_use_date: "2026-12-01",
        }),
      })
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.beyondUseDateSupported).toBe(false);
    expect(body.lot.beyond_use_date).toBeUndefined();
    expect(insertCallCount).toBe(2);
  });

  it("rejects a non-string, non-null beyond_use_date", async () => {
    const response = await POST(
      authedRequest("/api/lots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vaccine_id: "v1", lot_number: "ABC", expiration: "2027-01-01", beyond_use_date: 5 }),
      })
    );
    expect(response.status).toBe(400);
  });
});

describe("PATCH /api/lots/[id]", () => {
  afterEach(() => {
    vi.mocked(getSupabaseServerClient).mockReset();
  });

  function patchRequest(id: string, body: unknown) {
    return PATCH(
      authedRequest(`/api/lots/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) }
    );
  }

  it("rejects an empty body", async () => {
    const response = await patchRequest("l1", {});
    expect(response.status).toBe(400);
    expect(getSupabaseServerClient).not.toHaveBeenCalled();
  });

  it("rejects an invalid status", async () => {
    const response = await patchRequest("l1", { status: "expired" });
    expect(response.status).toBe(400);
  });

  it("updates lot_number, expiration, and beyond_use_date together", async () => {
    const single = vi.fn(async () => ({
      data: { id: "l1", lot_number: "XYZ", expiration: "2027-06-01", beyond_use_date: "2027-05-01" },
      error: null,
    }));
    const select = vi.fn(() => ({ single }));
    const eq = vi.fn(() => ({ select }));
    const update = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ update }));
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from } as never);

    const response = await patchRequest("l1", {
      lot_number: "XYZ",
      expiration: "2027-06-01",
      beyond_use_date: "2027-05-01",
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.beyondUseDateSupported).toBe(true);
    expect(update).toHaveBeenCalledWith({
      lot_number: "XYZ",
      expiration: "2027-06-01",
      beyond_use_date: "2027-05-01",
    });
    expect(eq).toHaveBeenCalledWith("id", "l1");
  });

  it("degrades gracefully: retries without beyond_use_date and flags it unsupported", async () => {
    let updateCallCount = 0;
    const update = vi.fn((payload: Record<string, unknown>) => {
      updateCallCount += 1;
      if (updateCallCount === 1) {
        return { eq: () => ({ select: () => ({ single: async () => ({ data: null, error: MISSING_BUD_COLUMN }) }) }) };
      }
      return {
        eq: () => ({
          select: () => ({ single: async () => ({ data: { id: "l1", ...payload }, error: null }) }),
        }),
      };
    });
    const from = vi.fn(() => ({ update }));
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from } as never);

    const response = await patchRequest("l1", { lot_number: "XYZ", beyond_use_date: "2027-05-01" });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.beyondUseDateSupported).toBe(false);
    expect(updateCallCount).toBe(2);
  });

  it("returns 409 when beyond_use_date is the only field and the column doesn't exist yet", async () => {
    const update = vi.fn(() => ({
      eq: () => ({ select: () => ({ single: async () => ({ data: null, error: MISSING_BUD_COLUMN }) }) }),
    }));
    const from = vi.fn(() => ({ update }));
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from } as never);

    const response = await patchRequest("l1", { beyond_use_date: "2027-05-01" });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.beyondUseDateSupported).toBe(false);
  });
});
