import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireAuthenticatedUser: vi.fn(async () => ({ user: { id: "user-1", email: "staff@example.com" } })),
}));

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServerClient: vi.fn(),
}));

import { GET, PUT } from "@/app/api/ordering/targets/route";
import { requireAuthenticatedUser } from "@/lib/auth";
import { getSupabaseServerClient } from "@/lib/supabase/server";

function authedRequest(url = "http://localhost/api/ordering/targets") {
  return new Request(url, { headers: { Authorization: "Bearer test-token" } });
}

function putRequest(body: unknown) {
  return new Request("http://localhost/api/ordering/targets", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
    body: JSON.stringify(body),
  });
}

type Row = { scope: string; key: string; target_on_hand: number };

function fakeSupabase(options: {
  rows?: Row[];
  selectError?: unknown;
  upsert?: (row: unknown) => Promise<{ error: unknown }>;
  del?: () => Promise<{ error: unknown }>;
}) {
  const { rows = [], selectError = null, upsert = vi.fn(async () => ({ error: null })), del = vi.fn(async () => ({ error: null })) } = options;
  return {
    from: (table: string) => {
      if (table !== "ordering_target") throw new Error(`unexpected table ${table}`);
      return {
        select: async () => ({ data: selectError ? null : rows, error: selectError }),
        upsert: (row: unknown) => ({ then: (resolve: (v: { error: unknown }) => void) => upsert(row).then(resolve) }),
        delete: () => ({
          eq: () => ({
            eq: async () => del(),
          }),
        }),
      };
    },
  };
}

describe("GET /api/ordering/targets", () => {
  afterEach(() => {
    vi.mocked(getSupabaseServerClient).mockReset();
  });

  it("returns the current targets", async () => {
    vi.mocked(getSupabaseServerClient).mockReturnValue(
      fakeSupabase({ rows: [{ scope: "ndc", key: "12345678901", target_on_hand: 20 }] }) as never
    );

    const response = await GET(authedRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ targets: [{ scope: "ndc", key: "12345678901", targetOnHand: 20 }] });
  });

  it("returns an empty pending response when ordering_target doesn't exist yet (0011 pending)", async () => {
    vi.mocked(getSupabaseServerClient).mockReturnValue(
      fakeSupabase({ selectError: { code: "42P01", message: 'relation "ordering_target" does not exist' } }) as never
    );

    const response = await GET(authedRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ targets: [], pending: true });
  });

  it("returns 401 without a bearer token (real auth, unmocked path exercised elsewhere in this repo's convention)", async () => {
    vi.mocked(requireAuthenticatedUser).mockResolvedValueOnce({
      error: new Response(JSON.stringify({ error: "Missing bearer token." }), { status: 401 }) as never,
    });
    const response = await GET(authedRequest());
    expect(response.status).toBe(401);
  });

  it("returns 503 for a genuine Supabase misconfiguration", async () => {
    vi.mocked(getSupabaseServerClient).mockImplementation(() => {
      throw new Error("Supabase server client requested but not configured.");
    });
    const response = await GET(authedRequest());
    expect(response.status).toBe(503);
  });
});

describe("PUT /api/ordering/targets", () => {
  afterEach(() => {
    vi.mocked(getSupabaseServerClient).mockReset();
  });

  it("upserts a valid ndc-scoped target", async () => {
    const upsert = vi.fn(async () => ({ error: null }));
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase({ upsert }) as never);

    const response = await PUT(putRequest({ scope: "ndc", key: "12345678901", targetOnHand: 30 }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ scope: "ndc", key: "12345678901", targetOnHand: 30 });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "ndc", key: "12345678901", target_on_hand: 30 })
    );
  });

  it("normalizes a dashed NDC key to digits-only before persisting (review fix)", async () => {
    const upsert = vi.fn(async () => ({ error: null }));
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase({ upsert }) as never);

    const response = await PUT(putRequest({ scope: "ndc", key: "70461-0123-03", targetOnHand: 20 }));
    expect(response.status).toBe(200);
    const body = await response.json();
    // Echoed back normalized, not the dashed form that was sent — this is
    // what makes the SAME key match lib/ordering-targets.ts's
    // ndcOverrides[row.ndc] lookup, which is always digits-only.
    expect(body).toEqual({ scope: "ndc", key: "70461012303", targetOnHand: 20 });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "ndc", key: "70461012303", target_on_hand: 20 })
    );
  });

  it("rejects an ndc-scoped key with no digits at all", async () => {
    const response = await PUT(putRequest({ scope: "ndc", key: "n/a", targetOnHand: 20 }));
    expect(response.status).toBe(400);
  });

  it("trims (but doesn't otherwise alter) a group-scoped key", async () => {
    const upsert = vi.fn(async () => ({ error: null }));
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase({ upsert }) as never);

    const response = await PUT(putRequest({ scope: "group", key: "  Flu  ", targetOnHand: 100 }));
    const body = await response.json();
    expect(body).toEqual({ scope: "group", key: "Flu", targetOnHand: 100 });
  });

  it("deletes the override when targetOnHand is null", async () => {
    const del = vi.fn(async () => ({ error: null }));
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase({ del }) as never);

    const response = await PUT(putRequest({ scope: "group", key: "Flu", targetOnHand: null }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ scope: "group", key: "Flu", targetOnHand: null });
    expect(del).toHaveBeenCalled();
  });

  it("rejects an invalid scope", async () => {
    const response = await PUT(putRequest({ scope: "bogus", key: "x", targetOnHand: 5 }));
    expect(response.status).toBe(400);
  });

  it("rejects a missing/empty key", async () => {
    const response = await PUT(putRequest({ scope: "ndc", key: "", targetOnHand: 5 }));
    expect(response.status).toBe(400);
  });

  it("rejects a negative targetOnHand", async () => {
    const response = await PUT(putRequest({ scope: "ndc", key: "111", targetOnHand: -1 }));
    expect(response.status).toBe(400);
  });

  it("rejects a non-integer (NaN-producing) targetOnHand", async () => {
    const response = await PUT(putRequest({ scope: "ndc", key: "111", targetOnHand: "not-a-number" }));
    expect(response.status).toBe(400);
  });

  it("rejects a fractional targetOnHand", async () => {
    const response = await PUT(putRequest({ scope: "ndc", key: "111", targetOnHand: 1.5 }));
    expect(response.status).toBe(400);
  });

  it("rejects malformed JSON", async () => {
    const response = await PUT(
      new Request("http://localhost/api/ordering/targets", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
        body: "{not json",
      })
    );
    expect(response.status).toBe(400);
  });

  it("returns pending:true when ordering_target doesn't exist yet (0011 pending)", async () => {
    const upsert = vi.fn(async () => ({
      error: { code: "42P01", message: 'relation "ordering_target" does not exist' },
    }));
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase({ upsert }) as never);

    const response = await PUT(putRequest({ scope: "ndc", key: "111", targetOnHand: 10 }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ pending: true });
  });
});
