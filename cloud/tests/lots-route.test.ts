import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireAuthenticatedUser: vi.fn(async () => ({ user: { id: "staff-1", email: "staff@example.com" } })),
}));

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServerClient: vi.fn(),
}));

import { DELETE as DELETE_COLLECTION, GET, PATCH as PATCH_COLLECTION, POST } from "@/app/api/lots/route";
import { DELETE, PATCH } from "@/app/api/lots/[id]/route";
import { getSupabaseServerClient } from "@/lib/supabase/server";

function authedRequest(path: string, init?: RequestInit) {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: { Authorization: "Bearer test-token", ...(init?.headers ?? {}) },
  });
}

const MISSING_BUD_COLUMN = { code: "42703", message: 'column "beyond_use_date" of relation "lot" does not exist' };

// V-T28 review follow-up: every fan-out write (POST vaccine_ids, PATCH,
// DELETE) now fetches the `vaccine` table first to confirm the ids all
// exist and resolve to one product (validateOneProductGroup in the
// route). These fixtures/helper back that check across the fan-out
// describe blocks below.
type VaccineRow = { id: string; name: string; ndc: string | null };

const SAME_PRODUCT_VACCINES: VaccineRow[] = [
  { id: "v1", name: "Engerix 20 (age 20+)", ndc: "58160-0821-52" },
  { id: "v2", name: "Engerix 20 (age 20+)", ndc: "58160-0821-52" },
];

const MIXED_PRODUCT_VACCINES: VaccineRow[] = [
  { id: "v1", name: "Engerix 20 (age 20+)", ndc: "58160-0821-52" },
  { id: "v2", name: "Gardasil", ndc: "00006-4121-02" },
];

/** Builds a `from` mock that branches on table name: "vaccine" resolves
 * a select().in() chain to whichever of `vaccineRows` match the
 * requested ids (an id absent from `vaccineRows` simulates "unknown
 * vaccine id", surfacing as validateOneProductGroup's 404); any other
 * table (always "lot" in these tests) delegates to `lotTable`. */
function mockFromWithVaccines(lotTable: Record<string, unknown>, vaccineRows: VaccineRow[] = SAME_PRODUCT_VACCINES) {
  return vi.fn((table: string) => {
    if (table === "vaccine") {
      return {
        select: vi.fn(() => ({
          in: vi.fn(async (_col: string, ids: string[]) => ({
            data: vaccineRows.filter((v) => ids.includes(v.id)),
            error: null,
          })),
        })),
      };
    }
    return lotTable;
  });
}

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

// V-T21 item 5: the data-entry popup's "Update current lots to this lot"
// checkbox deletes every OTHER lot for a vaccine after saving the new one.
describe("DELETE /api/lots/[id]", () => {
  afterEach(() => {
    vi.mocked(getSupabaseServerClient).mockReset();
  });

  function deleteRequest(id: string) {
    return DELETE(authedRequest(`/api/lots/${id}`, { method: "DELETE" }), { params: Promise.resolve({ id }) });
  }

  it("deletes the lot and returns ok: true", async () => {
    const eq = vi.fn(async () => ({ error: null }));
    const del = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ delete: del }));
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from } as never);

    const response = await deleteRequest("l1");

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(from).toHaveBeenCalledWith("lot");
    expect(eq).toHaveBeenCalledWith("id", "l1");
  });

  it("returns 500 on a Supabase error", async () => {
    const eq = vi.fn(async () => ({ error: new Error("boom") }));
    const del = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ delete: del }));
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from } as never);

    const response = await deleteRequest("l1");
    expect(response.status).toBe(500);
  });
});

// V-T28 (Will, 2026-09-09): the /lots page groups per-dose vaccine rows
// into one product row (lib/lots-grouping.ts) — editing that row must
// fan out to every dose's own lot row server-side.
describe("POST /api/lots — fan-out create (vaccine_ids)", () => {
  afterEach(() => {
    vi.mocked(getSupabaseServerClient).mockReset();
  });

  function fanOutPostRequest(body: unknown) {
    return POST(
      authedRequest("/api/lots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    );
  }

  it("inserts the same new lot on every vaccine_id at once", async () => {
    const select = vi.fn(async () => ({
      data: [
        { id: "l1", vaccine_id: "v1", lot_number: "ABC", expiration: "2027-01-01" },
        { id: "l2", vaccine_id: "v2", lot_number: "ABC", expiration: "2027-01-01" },
      ],
      error: null,
    }));
    const insert = vi.fn(() => ({ select }));
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from: mockFromWithVaccines({ insert }) } as never);

    const response = await fanOutPostRequest({
      vaccine_ids: ["v1", "v2"],
      lot_number: "ABC",
      expiration: "2027-01-01",
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.lots).toHaveLength(2);
    expect(insert).toHaveBeenCalledWith([
      { vaccine_id: "v1", lot_number: "ABC", expiration: "2027-01-01", status: "active", note: undefined },
      { vaccine_id: "v2", lot_number: "ABC", expiration: "2027-01-01", status: "active", note: undefined },
    ]);
  });

  it("rejects an empty vaccine_ids array", async () => {
    const response = await fanOutPostRequest({ vaccine_ids: [], lot_number: "ABC", expiration: "2027-01-01" });
    expect(response.status).toBe(400);
  });

  it("requires lot_number and expiration alongside vaccine_ids", async () => {
    const response = await fanOutPostRequest({ vaccine_ids: ["v1"] });
    expect(response.status).toBe(400);
  });

  // V-T28 review follow-up: vaccine_ids are validated server-side against
  // the real vaccine rows before any lot is written.
  it("rejects vaccine_ids spanning more than one product", async () => {
    vi.mocked(getSupabaseServerClient).mockReturnValue(
      { from: mockFromWithVaccines({ insert: vi.fn() }, MIXED_PRODUCT_VACCINES) } as never
    );

    const response = await fanOutPostRequest({ vaccine_ids: ["v1", "v2"], lot_number: "ABC", expiration: "2027-01-01" });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("vaccine_ids must belong to one product");
  });

  it("returns 404 when a vaccine_id doesn't exist", async () => {
    vi.mocked(getSupabaseServerClient).mockReturnValue(
      { from: mockFromWithVaccines({ insert: vi.fn() }, [SAME_PRODUCT_VACCINES[0]]) } as never
    );

    const response = await fanOutPostRequest({ vaccine_ids: ["v1", "v2"], lot_number: "ABC", expiration: "2027-01-01" });

    expect(response.status).toBe(404);
  });

  it("degrades gracefully across the whole fan-out when beyond_use_date is unsupported", async () => {
    let insertCallCount = 0;
    const insert = vi.fn((payload: Record<string, unknown>[]) => {
      insertCallCount += 1;
      if (insertCallCount === 1) {
        return { select: () => ({ data: null, error: { code: "42703", message: 'column "beyond_use_date" of relation "lot" does not exist' } }) } as never;
      }
      return { select: () => ({ data: payload.map((p, i) => ({ id: `l${i}`, ...p })), error: null }) } as never;
    });
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from: mockFromWithVaccines({ insert }) } as never);

    const response = await fanOutPostRequest({
      vaccine_ids: ["v1", "v2"],
      lot_number: "ABC",
      expiration: "2027-01-01",
      beyond_use_date: "2026-12-01",
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.beyondUseDateSupported).toBe(false);
    expect(insertCallCount).toBe(2);
  });
});

describe("PATCH /api/lots — fan-out UPSERT edit (vaccineIds + matchLotNumber)", () => {
  afterEach(() => {
    vi.mocked(getSupabaseServerClient).mockReset();
  });

  function fanOutPatchRequest(body: unknown) {
    return PATCH_COLLECTION(
      authedRequest("/api/lots", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    );
  }

  it("updates the matching lot_number on every vaccineId in one batched update", async () => {
    const select = vi.fn(() => ({
      in: vi.fn(async () => ({
        data: [
          { id: "l1", vaccine_id: "v1", lot_number: "ABC" },
          { id: "l2", vaccine_id: "v2", lot_number: "ABC" },
        ],
        error: null,
      })),
    }));
    const updateInCalls: string[][] = [];
    const update = vi.fn(() => ({
      in: vi.fn((_col: string, ids: string[]) => {
        updateInCalls.push(ids);
        return { select: vi.fn(async () => ({ data: ids.map((id) => ({ id, lot_number: "XYZ" })), error: null })) };
      }),
    }));
    const lotTable = { select, update };
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from: mockFromWithVaccines(lotTable) } as never);

    const response = await fanOutPatchRequest({
      vaccineIds: ["v1", "v2"],
      matchLotNumber: "ABC",
      lot_number: "XYZ",
      expiration: "2027-06-01",
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.lots).toHaveLength(2);
    expect(body.updated).toBe(2);
    expect(body.inserted).toBe(0);
    expect(update).toHaveBeenCalledTimes(1); // one batched update, not one per vaccineId
    expect(updateInCalls).toEqual([["l1", "l2"]]);
  });

  // Will's follow-up: "make the collection-level PATCH an upsert ... so
  // the dose rows can never drift apart after an edit."
  it("inserts a fresh lot (in one batched insert) on a dose row that's missing the matched lot", async () => {
    const select = vi.fn(() => ({ in: vi.fn(async () => ({ data: [], error: null })) })); // v2 has no "ABC" lot at all
    const insert = vi.fn((_payloads: Record<string, unknown>[]) => ({
      select: vi.fn(async () => ({
        data: [{ id: "new-l2", vaccine_id: "v2", lot_number: "XYZ", expiration: "2027-06-01" }],
        error: null,
      })),
    }));
    const lotTable = { select, insert };
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from: mockFromWithVaccines(lotTable) } as never);

    const response = await fanOutPatchRequest({
      vaccineIds: ["v2"],
      matchLotNumber: "ABC",
      lot_number: "XYZ",
      expiration: "2027-06-01",
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.lots).toEqual([{ id: "new-l2", vaccine_id: "v2", lot_number: "XYZ", expiration: "2027-06-01" }]);
    expect(body.updated).toBe(0);
    expect(body.inserted).toBe(1);
    expect(insert).toHaveBeenCalledWith([
      { vaccine_id: "v2", lot_number: "XYZ", expiration: "2027-06-01", status: "active", note: undefined },
    ]);
  });

  it("rejects an empty vaccineIds array", async () => {
    const response = await fanOutPatchRequest({
      vaccineIds: [],
      matchLotNumber: "ABC",
      lot_number: "ABC",
      expiration: "2027-06-01",
    });
    expect(response.status).toBe(400);
  });

  it("requires matchLotNumber", async () => {
    const response = await fanOutPatchRequest({ vaccineIds: ["v1"], lot_number: "ABC", expiration: "2027-06-01" });
    expect(response.status).toBe(400);
  });

  it("requires lot_number", async () => {
    const response = await fanOutPatchRequest({ vaccineIds: ["v1"], matchLotNumber: "ABC", expiration: "2027-06-01" });
    expect(response.status).toBe(400);
  });

  it("requires expiration", async () => {
    const response = await fanOutPatchRequest({ vaccineIds: ["v1"], matchLotNumber: "ABC", lot_number: "ABC" });
    expect(response.status).toBe(400);
  });

  // V-T28 review follow-up: vaccineIds are validated server-side against
  // the real vaccine rows before anything is read or written.
  it("rejects vaccineIds spanning more than one product", async () => {
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from: mockFromWithVaccines({}, MIXED_PRODUCT_VACCINES) } as never);

    const response = await fanOutPatchRequest({
      vaccineIds: ["v1", "v2"],
      matchLotNumber: "ABC",
      lot_number: "ABC",
      expiration: "2027-06-01",
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("vaccine_ids must belong to one product");
  });

  it("returns 404 when a vaccineId doesn't exist", async () => {
    vi.mocked(getSupabaseServerClient).mockReturnValue(
      { from: mockFromWithVaccines({}, [SAME_PRODUCT_VACCINES[0]]) } as never
    );

    const response = await fanOutPatchRequest({
      vaccineIds: ["v1", "v2"],
      matchLotNumber: "ABC",
      lot_number: "ABC",
      expiration: "2027-06-01",
    });

    expect(response.status).toBe(404);
  });

  it("returns 500 on a genuine Supabase error while planning", async () => {
    const select = vi.fn(() => ({ in: vi.fn(async () => ({ data: null, error: new Error("boom") })) }));
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from: mockFromWithVaccines({ select }) } as never);

    const response = await fanOutPatchRequest({
      vaccineIds: ["v1"],
      matchLotNumber: "ABC",
      lot_number: "ABC",
      expiration: "2027-06-01",
    });
    expect(response.status).toBe(500);
  });

  it("returns 500 with updated: 0, inserted: 0 when the insert half fails and no update was needed", async () => {
    const select = vi.fn(() => ({ in: vi.fn(async () => ({ data: [], error: null })) }));
    const insert = vi.fn(() => ({ select: vi.fn(async () => ({ data: null, error: new Error("boom") })) }));
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from: mockFromWithVaccines({ select, insert }) } as never);

    const response = await fanOutPatchRequest({
      vaccineIds: ["v1"],
      matchLotNumber: "ABC",
      lot_number: "XYZ",
      expiration: "2027-06-01",
    });

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.updated).toBe(0);
    expect(body.inserted).toBe(0);
    expect(body.failed).toHaveLength(1);
  });

  // Will's review follow-up: "add a test for a mid-plan failure showing
  // the response carries the partial counts and a 500 status."
  it("reports partial counts (updated: 1, inserted: 0) and 500 when the insert half of a mixed update+insert fails", async () => {
    const select = vi.fn(() => ({
      in: vi.fn(async () => ({ data: [{ id: "l1", vaccine_id: "v1", lot_number: "ABC" }], error: null })), // only v1 matches; v2 needs an insert
    }));
    const update = vi.fn(() => ({
      in: vi.fn(() => ({
        select: vi.fn(async () => ({ data: [{ id: "l1", vaccine_id: "v1", lot_number: "XYZ" }], error: null })),
      })),
    }));
    const insert = vi.fn(() => ({ select: vi.fn(async () => ({ data: null, error: new Error("boom") })) }));
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from: mockFromWithVaccines({ select, update, insert }) } as never);

    const response = await fanOutPatchRequest({
      vaccineIds: ["v1", "v2"],
      matchLotNumber: "ABC",
      lot_number: "XYZ",
      expiration: "2027-06-01",
    });

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.updated).toBe(1); // v1's update landed
    expect(body.inserted).toBe(0); // v2's insert did not
    expect(body.failed).toHaveLength(1);
    expect(body.lots).toBeUndefined(); // failure response carries counts/failed, not a lots array
  });
});

describe("DELETE /api/lots — fan-out delete (vaccineIds + lot_number)", () => {
  afterEach(() => {
    vi.mocked(getSupabaseServerClient).mockReset();
  });

  function fanOutDeleteRequest(body: unknown) {
    return DELETE_COLLECTION(
      authedRequest("/api/lots", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    );
  }

  it("deletes the matching lot_number on every vaccineId in one batched delete", async () => {
    const select = vi.fn(() => ({
      in: vi.fn(async () => ({
        data: [
          { id: "l1", vaccine_id: "v1", lot_number: "ABC" },
          { id: "l2", vaccine_id: "v2", lot_number: "ABC" },
        ],
        error: null,
      })),
    }));
    const deleteInCalls: string[][] = [];
    const del = vi.fn(() => ({
      in: vi.fn((_col: string, ids: string[]) => {
        deleteInCalls.push(ids);
        return { select: vi.fn(async () => ({ data: ids.map((id) => ({ id })), error: null })) };
      }),
    }));
    const lotTable = { select, delete: del };
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from: mockFromWithVaccines(lotTable) } as never);

    const response = await fanOutDeleteRequest({ vaccineIds: ["v1", "v2"], lot_number: "ABC" });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.deleted).toBe(2);
    expect(del).toHaveBeenCalledTimes(1); // one batched delete, not one per vaccineId
    expect(deleteInCalls).toEqual([["l1", "l2"]]);
  });

  it("returns deleted: 0 without erroring when nothing matches", async () => {
    const select = vi.fn(() => ({ in: vi.fn(async () => ({ data: [], error: null })) }));
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from: mockFromWithVaccines({ select }) } as never);

    const response = await fanOutDeleteRequest({ vaccineIds: ["v1"], lot_number: "ABC" });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.deleted).toBe(0);
  });

  // Normalizes matchLotNumber/lot_number comparisons the same way
  // lib/lots-grouping.ts's dedupeLotsByNumber does (trim + case-fold).
  it("matches lot_number case-insensitively and ignoring surrounding whitespace", async () => {
    const select = vi.fn(() => ({
      in: vi.fn(async () => ({ data: [{ id: "l1", vaccine_id: "v1", lot_number: " abc " }], error: null })),
    }));
    const del = vi.fn(() => ({ in: vi.fn(() => ({ select: vi.fn(async () => ({ data: [{ id: "l1" }], error: null })) })) }));
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from: mockFromWithVaccines({ select, delete: del }) } as never);

    const response = await fanOutDeleteRequest({ vaccineIds: ["v1"], lot_number: "ABC" });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.deleted).toBe(1);
  });

  it("rejects an empty vaccineIds array", async () => {
    const response = await fanOutDeleteRequest({ vaccineIds: [], lot_number: "ABC" });
    expect(response.status).toBe(400);
  });

  it("requires lot_number", async () => {
    const response = await fanOutDeleteRequest({ vaccineIds: ["v1"] });
    expect(response.status).toBe(400);
  });

  it("rejects vaccineIds spanning more than one product", async () => {
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from: mockFromWithVaccines({}, MIXED_PRODUCT_VACCINES) } as never);

    const response = await fanOutDeleteRequest({ vaccineIds: ["v1", "v2"], lot_number: "ABC" });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("vaccine_ids must belong to one product");
  });

  it("returns 404 when a vaccineId doesn't exist", async () => {
    vi.mocked(getSupabaseServerClient).mockReturnValue(
      { from: mockFromWithVaccines({}, [SAME_PRODUCT_VACCINES[0]]) } as never
    );

    const response = await fanOutDeleteRequest({ vaccineIds: ["v1", "v2"], lot_number: "ABC" });

    expect(response.status).toBe(404);
  });

  it("returns 500 with deleted: 0 and failed detail on a genuine Supabase error", async () => {
    const select = vi.fn(() => ({
      in: vi.fn(async () => ({ data: [{ id: "l1", vaccine_id: "v1", lot_number: "ABC" }], error: null })),
    }));
    const del = vi.fn(() => ({ in: () => ({ select: async () => ({ data: null, error: new Error("boom") }) }) }));
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from: mockFromWithVaccines({ select, delete: del }) } as never);

    const response = await fanOutDeleteRequest({ vaccineIds: ["v1"], lot_number: "ABC" });

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.deleted).toBe(0);
    expect(body.failed).toHaveLength(1);
  });
});
