import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireAuthenticatedUser: vi.fn(async () => ({ user: { id: "staff-1", email: "staff@example.com" } })),
}));

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServerClient: vi.fn(),
}));

import { GET, PUT } from "@/app/api/macro-codes/settings/route";
import { getSupabaseServerClient } from "@/lib/supabase/server";

function authedRequest(url = "http://localhost/api/macro-codes/settings") {
  return new Request(url, { headers: { Authorization: "Bearer test-token" } });
}

function putRequest(body: unknown) {
  return new Request("http://localhost/api/macro-codes/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
    body: JSON.stringify(body),
  });
}

function fakeSupabase(options: {
  storedValue?: unknown;
  selectError?: unknown;
  upsert?: (row: unknown) => Promise<{ error: unknown }>;
}) {
  const { storedValue, selectError = null, upsert = vi.fn(async () => ({ error: null })) } = options;
  return {
    from: (table: string) => {
      if (table === "app_setting") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => {
                if (selectError) return { data: null, error: selectError };
                if (storedValue === undefined) return { data: null, error: null };
                return { data: { value: storedValue }, error: null };
              },
            }),
          }),
          upsert,
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

describe("GET /api/macro-codes/settings", () => {
  afterEach(() => {
    vi.mocked(getSupabaseServerClient).mockReset();
  });

  it("defaults to an empty override map when nothing has been saved yet", async () => {
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase({}) as never);

    const response = await GET(authedRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.doseCounts).toEqual({});
    expect(body.pending).toBe(false);
  });

  it("returns pending:true before app_setting has been created", async () => {
    vi.mocked(getSupabaseServerClient).mockReturnValue(
      fakeSupabase({ selectError: { code: "42P01", message: 'relation "app_setting" does not exist' } }) as never
    );

    const response = await GET(authedRequest());
    const body = await response.json();
    expect(body.doseCounts).toEqual({});
    expect(body.pending).toBe(true);
  });

  it("returns a saved override map", async () => {
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase({ storedValue: { "ndc:shingrix": 3 } }) as never);

    const response = await GET(authedRequest());
    const body = await response.json();
    expect(body.doseCounts).toEqual({ "ndc:shingrix": 3 });
  });

  it("returns 500 for a genuine (non-missing-table) select error", async () => {
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase({ selectError: new Error("connection reset") }) as never);

    const response = await GET(authedRequest());
    expect(response.status).toBe(500);
  });
});

describe("PUT /api/macro-codes/settings", () => {
  afterEach(() => {
    vi.mocked(getSupabaseServerClient).mockReset();
  });

  it("saves a valid doseCounts map when nothing was previously saved", async () => {
    const upsert = vi.fn(async (row: unknown) => {
      expect(row).toMatchObject({ key: "macro_dose_counts", value: { "ndc:shingrix": 3 } });
      return { error: null };
    });
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase({ upsert }) as never);

    const response = await PUT(putRequest({ doseCounts: { "ndc:shingrix": 3 } }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.doseCounts).toEqual({ "ndc:shingrix": 3 });
    expect(upsert).toHaveBeenCalled();
  });

  it("merges a partial patch onto the existing saved map instead of replacing it (race-safety: two devices editing different products)", async () => {
    const upsert = vi.fn(async (row: unknown) => {
      expect(row).toMatchObject({ key: "macro_dose_counts", value: { "ndc:shingrix": 3, "ndc:gardasil": 2 } });
      return { error: null };
    });
    // Another device already saved shingrix's count; this PUT only
    // carries gardasil's change.
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase({ storedValue: { "ndc:shingrix": 3 }, upsert }) as never);

    const response = await PUT(putRequest({ doseCounts: { "ndc:gardasil": 2 } }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.doseCounts).toEqual({ "ndc:shingrix": 3, "ndc:gardasil": 2 });
    expect(upsert).toHaveBeenCalled();
  });

  it("a patch overwriting an already-saved key's value wins for that key only, leaving other keys untouched", async () => {
    const upsert = vi.fn(async () => ({ error: null }));
    vi.mocked(getSupabaseServerClient).mockReturnValue(
      fakeSupabase({ storedValue: { "ndc:shingrix": 2, "ndc:gardasil": 3 }, upsert }) as never
    );

    const response = await PUT(putRequest({ doseCounts: { "ndc:shingrix": 4 } }));
    const body = await response.json();
    expect(body.doseCounts).toEqual({ "ndc:shingrix": 4, "ndc:gardasil": 3 });
  });

  it("returns 500 when reading the existing map fails for a genuine (non-missing-table) reason", async () => {
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase({ selectError: new Error("connection reset") }) as never);

    const response = await PUT(putRequest({ doseCounts: { "ndc:shingrix": 3 } }));
    expect(response.status).toBe(500);
  });

  it("rejects an out-of-range dose count", async () => {
    const response = await PUT(putRequest({ doseCounts: { "ndc:shingrix": 5 } }));
    expect(response.status).toBe(400);
    expect(getSupabaseServerClient).not.toHaveBeenCalled();
  });

  it("rejects a non-object body", async () => {
    const response = await PUT(putRequest({ doseCounts: ["ndc:shingrix"] }));
    expect(response.status).toBe(400);
  });

  it("returns { pending: true } (200) before app_setting has been created", async () => {
    const upsert = vi.fn(async () => ({ error: { code: "42P01", message: 'relation "app_setting" does not exist' } }));
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase({ upsert }) as never);

    const response = await PUT(putRequest({ doseCounts: { "ndc:shingrix": 3 } }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.pending).toBe(true);
  });

  it("returns 500 for a genuine (non-missing-table) upsert error", async () => {
    const upsert = vi.fn(async () => ({ error: new Error("connection reset") }));
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase({ upsert }) as never);

    const response = await PUT(putRequest({ doseCounts: { "ndc:shingrix": 3 } }));
    expect(response.status).toBe(500);
  });
});
