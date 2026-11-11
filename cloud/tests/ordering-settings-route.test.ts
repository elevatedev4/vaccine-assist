import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireAuthenticatedUser: vi.fn(async () => ({ user: { id: "user-1", email: "staff@example.com" } })),
}));

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServerClient: vi.fn(),
}));

import { GET, PUT } from "@/app/api/ordering/settings/route";
import { requireAuthenticatedUser } from "@/lib/auth";
import { getSupabaseServerClient } from "@/lib/supabase/server";

function authedRequest(url = "http://localhost/api/ordering/settings") {
  return new Request(url, { headers: { Authorization: "Bearer test-token" } });
}

function putRequest(body: unknown) {
  return new Request("http://localhost/api/ordering/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
    body: JSON.stringify(body),
  });
}

function fakeSupabase(options: {
  storedValue?: unknown;
  /** per-key stored values (takes precedence over storedValue for that key) */
  storedByKey?: Record<string, unknown>;
  selectError?: unknown;
  upsert?: (row: unknown) => Promise<{ error: unknown }>;
}) {
  const { storedValue, storedByKey = {}, selectError = null, upsert = vi.fn(async () => ({ error: null })) } = options;
  return {
    from: (table: string) => {
      if (table !== "app_setting") throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: (_col: string, key: string) => ({
            maybeSingle: async () => {
              if (selectError) return { data: null, error: selectError };
              if (key in storedByKey) return { data: { value: storedByKey[key] }, error: null };
              if (key === "ordering.mflusiva_pct" || storedValue === undefined) return { data: null, error: null };
              return { data: { value: storedValue }, error: null };
            },
          }),
        }),
        upsert: (row: unknown) => ({ then: (resolve: (v: { error: unknown }) => void) => upsert(row).then(resolve) }),
      };
    },
  };
}

describe("GET /api/ordering/settings", () => {
  afterEach(() => {
    vi.mocked(getSupabaseServerClient).mockReset();
  });

  it("returns the saved walk-up pct", async () => {
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase({ storedValue: 30 }) as never);

    const response = await GET(authedRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ walkInPct: 30, mflusivaPct: 40, pending: false });
  });

  it("returns the default (25) when no row has been saved yet", async () => {
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase({}) as never);

    const response = await GET(authedRequest());
    const body = await response.json();
    expect(body).toEqual({ walkInPct: 25, mflusivaPct: 40, pending: false });
  });

  it("returns the default (25) with pending:true when app_setting doesn't exist yet (0012 pending)", async () => {
    vi.mocked(getSupabaseServerClient).mockReturnValue(
      fakeSupabase({ selectError: { code: "42P01", message: 'relation "app_setting" does not exist' } }) as never
    );

    const response = await GET(authedRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ walkInPct: 25, mflusivaPct: 40, pending: true });
  });

  it("returns the saved 50-64 mFLUSIVA share", async () => {
    vi.mocked(getSupabaseServerClient).mockReturnValue(
      fakeSupabase({ storedByKey: { "ordering.walk_in_pct": 30, "ordering.mflusiva_pct": 75 } }) as never
    );
    const body = await (await GET(authedRequest())).json();
    expect(body).toEqual({ walkInPct: 30, mflusivaPct: 75, pending: false });
  });

  it("reads 40 for the mFLUSIVA share when the stored value is not a valid pct", async () => {
    vi.mocked(getSupabaseServerClient).mockReturnValue(
      fakeSupabase({ storedByKey: { "ordering.mflusiva_pct": 140 } }) as never
    );
    const body = await (await GET(authedRequest())).json();
    expect(body.mflusivaPct).toBe(40);
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

  it("returns 500 for a non-missing-table Supabase error (never silently swallowed)", async () => {
    vi.mocked(getSupabaseServerClient).mockReturnValue(
      fakeSupabase({ selectError: new Error("connection reset") }) as never
    );
    const response = await GET(authedRequest());
    expect(response.status).toBe(500);
  });
});

describe("PUT /api/ordering/settings", () => {
  afterEach(() => {
    vi.mocked(getSupabaseServerClient).mockReset();
  });

  it("saves a valid walk-up pct", async () => {
    const upsert = vi.fn(async () => ({ error: null }));
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase({ upsert }) as never);

    const response = await PUT(putRequest({ walkInPct: 40 }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ walkInPct: 40 });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ key: "ordering.walk_in_pct", value: 40 })
    );
  });

  it("accepts the boundary values 0 and 100", async () => {
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase({}) as never);
    expect((await PUT(putRequest({ walkInPct: 0 }))).status).toBe(200);
    expect((await PUT(putRequest({ walkInPct: 100 }))).status).toBe(200);
  });

  it("rejects a fractional pct", async () => {
    const response = await PUT(putRequest({ walkInPct: 25.5 }));
    expect(response.status).toBe(400);
  });

  it("rejects a negative pct", async () => {
    const response = await PUT(putRequest({ walkInPct: -1 }));
    expect(response.status).toBe(400);
  });

  it("rejects a pct over 100", async () => {
    const response = await PUT(putRequest({ walkInPct: 101 }));
    expect(response.status).toBe(400);
  });

  it("rejects a non-numeric pct", async () => {
    const response = await PUT(putRequest({ walkInPct: "25" }));
    expect(response.status).toBe(400);
  });

  it("saves a valid mFLUSIVA share under its own key, without touching walk-up %", async () => {
    const upsert = vi.fn(async () => ({ error: null }));
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase({ upsert }) as never);

    const response = await PUT(putRequest({ mflusivaPct: 55 }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ mflusivaPct: 55 });
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ key: "ordering.mflusiva_pct", value: 55 }));
  });

  it("accepts mFLUSIVA share boundaries 0 and 100", async () => {
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase({}) as never);
    expect((await PUT(putRequest({ mflusivaPct: 0 }))).status).toBe(200);
    expect((await PUT(putRequest({ mflusivaPct: 100 }))).status).toBe(200);
  });

  it.each([[-1], [101], [40.5], ["40"], [null]])("rejects mflusivaPct %s", async (bad) => {
    const upsert = vi.fn(async () => ({ error: null }));
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase({ upsert }) as never);
    const response = await PUT(putRequest({ mflusivaPct: bad }));
    expect(response.status).toBe(400);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("rejects a body with neither setting", async () => {
    const response = await PUT(putRequest({}));
    expect(response.status).toBe(400);
  });

  it("returns pending:true when saving the mFLUSIVA share before app_setting exists", async () => {
    const upsert = vi.fn(async () => ({
      error: { code: "42P01", message: 'relation "app_setting" does not exist' },
    }));
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase({ upsert }) as never);
    const response = await PUT(putRequest({ mflusivaPct: 30 }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pending: true });
  });

  it("rejects malformed JSON", async () => {
    const response = await PUT(
      new Request("http://localhost/api/ordering/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
        body: "{not json",
      })
    );
    expect(response.status).toBe(400);
  });

  it("returns pending:true (200, not an error) when app_setting doesn't exist yet (0012 pending)", async () => {
    const upsert = vi.fn(async () => ({
      error: { code: "42P01", message: 'relation "app_setting" does not exist' },
    }));
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase({ upsert }) as never);

    const response = await PUT(putRequest({ walkInPct: 30 }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ pending: true });
  });

  it("returns 503 for a genuine Supabase misconfiguration", async () => {
    vi.mocked(getSupabaseServerClient).mockImplementation(() => {
      throw new Error("Supabase server client requested but not configured.");
    });
    const response = await PUT(putRequest({ walkInPct: 30 }));
    expect(response.status).toBe(503);
  });
});
