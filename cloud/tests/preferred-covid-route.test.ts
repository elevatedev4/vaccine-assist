import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireAuthenticatedUser: vi.fn(async () => ({ user: { id: "user-1", email: "staff@example.com" } })),
}));

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServerClient: vi.fn(),
}));

import { GET, PUT } from "@/app/api/settings/preferred-covid/route";
import { requireAuthenticatedUser } from "@/lib/auth";
import { getSupabaseServerClient } from "@/lib/supabase/server";

function authedRequest() {
  return new Request("http://localhost/api/settings/preferred-covid", { headers: { Authorization: "Bearer test-token" } });
}

function putRequest(body: unknown) {
  return new Request("http://localhost/api/settings/preferred-covid", {
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
      if (table !== "app_setting") throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: (_column: string, key: string) => ({
            maybeSingle: async () => {
              expect(key).toBe("macro.preferred_covid");
              if (selectError) return { data: null, error: selectError };
              if (storedValue === undefined) return { data: null, error: null };
              return { data: { value: storedValue }, error: null };
            },
          }),
        }),
        upsert: (row: unknown) => ({ then: (resolve: (v: { error: unknown }) => void) => upsert(row).then(resolve) }),
      };
    },
  };
}

afterEach(() => {
  vi.mocked(getSupabaseServerClient).mockReset();
  vi.mocked(requireAuthenticatedUser).mockClear();
});

describe("GET /api/settings/preferred-covid", () => {
  it("returns the defaults (Pfizer 12+, Moderna 3-11) when nothing is saved", async () => {
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase({}) as never);
    const response = await GET(authedRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ adult: "pfizer", kids: "moderna", pending: false });
  });

  it("returns the saved choice", async () => {
    vi.mocked(getSupabaseServerClient).mockReturnValue(
      fakeSupabase({ storedValue: { adult: "moderna", kids: "moderna" } }) as never
    );
    const response = await GET(authedRequest());
    expect(await response.json()).toEqual({ adult: "moderna", kids: "moderna", pending: false });
  });

  it("falls back to the defaults for a malformed stored value", async () => {
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase({ storedValue: { adult: "novavax" } }) as never);
    const response = await GET(authedRequest());
    expect(await response.json()).toEqual({ adult: "pfizer", kids: "moderna", pending: false });
  });

  it("degrades to the defaults with pending:true before app_setting exists", async () => {
    vi.mocked(getSupabaseServerClient).mockReturnValue(
      fakeSupabase({ selectError: { code: "42P01", message: 'relation "app_setting" does not exist' } }) as never
    );
    const response = await GET(authedRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ adult: "pfizer", kids: "moderna", pending: true });
  });

  it("500s on any other database error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(getSupabaseServerClient).mockReturnValue(
      fakeSupabase({ selectError: { code: "XX000", message: "boom" } }) as never
    );
    const response = await GET(authedRequest());
    expect(response.status).toBe(500);
  });

  it("returns the auth error untouched when unauthenticated", async () => {
    const { NextResponse } = await import("next/server");
    vi.mocked(requireAuthenticatedUser).mockResolvedValueOnce({
      error: NextResponse.json({ error: "Missing bearer token." }, { status: 401 }),
    });
    const response = await GET(new Request("http://localhost/api/settings/preferred-covid"));
    expect(response.status).toBe(401);
  });
});

describe("PUT /api/settings/preferred-covid", () => {
  it("saves a valid choice under macro.preferred_covid", async () => {
    const upsert = vi.fn(async () => ({ error: null }));
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase({ upsert }) as never);

    const response = await PUT(putRequest({ adult: "moderna", kids: "moderna", extra: "ignored" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ adult: "moderna", kids: "moderna" });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ key: "macro.preferred_covid", value: { adult: "moderna", kids: "moderna" } })
    );
  });

  it.each([
    [{ adult: "novavax", kids: "moderna" }],
    [{ adult: "pfizer", kids: "pfizer" }],
    [{ adult: "pfizer" }],
    [{}],
    [null],
    ["pfizer"],
  ])("rejects %j with 400 and writes nothing", async (body) => {
    const upsert = vi.fn(async () => ({ error: null }));
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase({ upsert }) as never);
    const response = await PUT(putRequest(body));
    expect(response.status).toBe(400);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("returns { pending: true } (200) before app_setting exists", async () => {
    const upsert = vi.fn(async () => ({ error: { code: "42P01", message: 'relation "app_setting" does not exist' } }));
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase({ upsert }) as never);
    const response = await PUT(putRequest({ adult: "pfizer", kids: "moderna" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pending: true });
  });

  it("400s a malformed JSON body", async () => {
    const response = await PUT(
      new Request("http://localhost/api/settings/preferred-covid", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token" },
        body: "{not json",
      })
    );
    expect(response.status).toBe(400);
  });
});
