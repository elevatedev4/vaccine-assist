import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireAuthenticatedUser: vi.fn(async () => ({ user: { id: "user-1", email: "staff@example.com" } })),
}));

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServerClient: vi.fn(),
}));

vi.mock("@/lib/chicago-date", () => ({
  todayInChicago: () => "2026-09-25",
}));

import { PUT } from "@/app/api/ordering/ordered-today/route";
import { requireAuthenticatedUser } from "@/lib/auth";
import { getSupabaseServerClient } from "@/lib/supabase/server";

function putRequest(body: unknown) {
  return new Request("http://localhost/api/ordering/ordered-today", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
    body: JSON.stringify(body),
  });
}

function fakeSupabase(options: { upsert?: (row: unknown) => Promise<{ error: unknown }> } = {}) {
  const { upsert = vi.fn(async () => ({ error: null })) } = options;
  return {
    from: (table: string) => {
      if (table !== "ordering_ordered_today") throw new Error(`unexpected table ${table}`);
      return {
        upsert: (row: unknown) => ({ then: (resolve: (v: { error: unknown }) => void) => upsert(row).then(resolve) }),
      };
    },
  };
}

describe("PUT /api/ordering/ordered-today", () => {
  afterEach(() => {
    vi.mocked(getSupabaseServerClient).mockReset();
  });

  it("saves a valid packages-ordered-today count for today's Chicago date", async () => {
    const upsert = vi.fn(async () => ({ error: null }));
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase({ upsert }) as never);

    const response = await PUT(putRequest({ key: "58160084252", orderedToday: 3 }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ key: "58160084252", orderDate: "2026-09-25", orderedToday: 3 });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ key: "58160084252", order_date: "2026-09-25", packages_ordered: 3 })
    );
  });

  it("accepts 0 (nothing ordered yet today — not a clear/delete signal)", async () => {
    const upsert = vi.fn(async () => ({ error: null }));
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase({ upsert }) as never);

    const response = await PUT(putRequest({ key: "58160084252", orderedToday: 0 }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ key: "58160084252", orderDate: "2026-09-25", orderedToday: 0 });
  });

  it("accepts a non-NDC-shaped key (e.g. 'vaccine:<id>' for a no-NDC product) unchanged, just trimmed", async () => {
    const upsert = vi.fn(async () => ({ error: null }));
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase({ upsert }) as never);

    const response = await PUT(putRequest({ key: "  vaccine:v-flu  ", orderedToday: 2 }));
    const body = await response.json();
    expect(body.key).toBe("vaccine:v-flu");
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ key: "vaccine:v-flu" }));
  });

  it("rejects a missing/empty key", async () => {
    const response = await PUT(putRequest({ key: "", orderedToday: 1 }));
    expect(response.status).toBe(400);
  });

  it("rejects a negative orderedToday", async () => {
    const response = await PUT(putRequest({ key: "111", orderedToday: -1 }));
    expect(response.status).toBe(400);
  });

  it("rejects a fractional orderedToday", async () => {
    const response = await PUT(putRequest({ key: "111", orderedToday: 1.5 }));
    expect(response.status).toBe(400);
  });

  it("rejects a non-numeric orderedToday", async () => {
    const response = await PUT(putRequest({ key: "111", orderedToday: "3" }));
    expect(response.status).toBe(400);
  });

  it("rejects a missing orderedToday", async () => {
    const response = await PUT(putRequest({ key: "111" }));
    expect(response.status).toBe(400);
  });

  it("rejects malformed JSON", async () => {
    const response = await PUT(
      new Request("http://localhost/api/ordering/ordered-today", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
        body: "{not json",
      })
    );
    expect(response.status).toBe(400);
  });

  it("returns pending:true (200, not an error) when ordering_ordered_today doesn't exist yet (0015 pending)", async () => {
    const upsert = vi.fn(async () => ({
      error: { code: "42P01", message: 'relation "ordering_ordered_today" does not exist' },
    }));
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase({ upsert }) as never);

    const response = await PUT(putRequest({ key: "111", orderedToday: 1 }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ pending: true });
  });

  it("returns 500 for a non-missing-table Supabase error (never silently swallowed)", async () => {
    const upsert = vi.fn(async () => ({ error: new Error("connection reset") }));
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase({ upsert }) as never);

    const response = await PUT(putRequest({ key: "111", orderedToday: 1 }));
    expect(response.status).toBe(500);
  });

  it("returns 503 for a genuine Supabase misconfiguration", async () => {
    vi.mocked(getSupabaseServerClient).mockImplementation(() => {
      throw new Error("Supabase server client requested but not configured.");
    });
    const response = await PUT(putRequest({ key: "111", orderedToday: 1 }));
    expect(response.status).toBe(503);
  });

  it("returns 401 without a bearer token (real auth, unmocked path exercised elsewhere in this repo's convention)", async () => {
    vi.mocked(requireAuthenticatedUser).mockResolvedValueOnce({
      error: new Response(JSON.stringify({ error: "Missing bearer token." }), { status: 401 }) as never,
    });
    const response = await PUT(putRequest({ key: "111", orderedToday: 1 }));
    expect(response.status).toBe(401);
  });
});
