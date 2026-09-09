import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireAuthenticatedUser: vi.fn(async () => ({ user: { id: "staff-1", email: "staff@example.com" } })),
}));

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServerClient: vi.fn(),
}));

import { GET, PUT } from "@/app/api/lots/settings/route";
import { getSupabaseServerClient } from "@/lib/supabase/server";

const VACCINES = [
  { id: "v-fluad", name: "Fluad", ndc: "70461-0123-03", active: true },
  { id: "v-mnexspike", name: "mNEXSPIKE", ndc: null, active: true },
];

function authedRequest(url = "http://localhost/api/lots/settings") {
  return new Request(url, { headers: { Authorization: "Bearer test-token" } });
}

function putRequest(body: unknown) {
  return new Request("http://localhost/api/lots/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
    body: JSON.stringify(body),
  });
}

function fakeSupabase(options: {
  vaccines?: unknown[];
  vaccinesError?: unknown;
  storedValue?: unknown;
  selectError?: unknown;
  upsert?: (row: unknown) => Promise<{ error: unknown }>;
}) {
  const {
    vaccines = VACCINES,
    vaccinesError = null,
    storedValue,
    selectError = null,
    upsert = vi.fn(async () => ({ error: null })),
  } = options;
  return {
    from: (table: string) => {
      if (table === "vaccine") {
        return { select: () => ({ order: async () => ({ data: vaccines, error: vaccinesError }) }) };
      }
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

describe("GET /api/lots/settings", () => {
  afterEach(() => {
    vi.mocked(getSupabaseServerClient).mockReset();
  });

  it("defaults to mNEXSPIKE's productKey when nothing has been saved yet", async () => {
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase({}) as never);

    const response = await GET(authedRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.budEnabledProductKeys).toEqual(["name:mnexspike"]);
    expect(body.pending).toBe(false);
  });

  it("defaults to mNEXSPIKE with pending:true before 0012 has been applied", async () => {
    vi.mocked(getSupabaseServerClient).mockReturnValue(
      fakeSupabase({ selectError: { code: "42P01", message: 'relation "app_setting" does not exist' } }) as never
    );

    const response = await GET(authedRequest());
    const body = await response.json();
    expect(body.budEnabledProductKeys).toEqual(["name:mnexspike"]);
    expect(body.pending).toBe(true);
  });

  it("returns a saved value when present", async () => {
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase({ storedValue: ["70461012303"] }) as never);

    const response = await GET(authedRequest());
    const body = await response.json();
    expect(body.budEnabledProductKeys).toEqual(["70461012303"]);
    expect(body.pending).toBe(false);
  });

  it("returns 500 when the vaccine catalog fails to load", async () => {
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase({ vaccinesError: new Error("boom") }) as never);

    const response = await GET(authedRequest());
    expect(response.status).toBe(500);
  });

  it("returns 500 for a non-missing-table app_setting error", async () => {
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase({ selectError: new Error("connection reset") }) as never);

    const response = await GET(authedRequest());
    expect(response.status).toBe(500);
  });
});

describe("PUT /api/lots/settings", () => {
  afterEach(() => {
    vi.mocked(getSupabaseServerClient).mockReset();
  });

  it("saves a valid productKey list", async () => {
    const upsert = vi.fn(async (row: unknown) => {
      expect(row).toMatchObject({ key: "lots.bud_enabled_products", value: ["name:mnexspike", "70461012303"] });
      return { error: null };
    });
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase({ upsert }) as never);

    const response = await PUT(putRequest({ budEnabledProductKeys: ["name:mnexspike", "70461012303"] }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.budEnabledProductKeys).toEqual(["name:mnexspike", "70461012303"]);
    expect(upsert).toHaveBeenCalled();
  });

  it("accepts an empty array (disable BUD for every product)", async () => {
    const upsert = vi.fn(async () => ({ error: null }));
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase({ upsert }) as never);

    const response = await PUT(putRequest({ budEnabledProductKeys: [] }));
    expect(response.status).toBe(200);
  });

  it("rejects a non-array body", async () => {
    const response = await PUT(putRequest({ budEnabledProductKeys: "name:mnexspike" }));
    expect(response.status).toBe(400);
    expect(getSupabaseServerClient).not.toHaveBeenCalled();
  });

  it("returns { pending: true } (200) before 0012 has been applied", async () => {
    const upsert = vi.fn(async () => ({ error: { code: "42P01", message: 'relation "app_setting" does not exist' } }));
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase({ upsert }) as never);

    const response = await PUT(putRequest({ budEnabledProductKeys: ["name:mnexspike"] }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.pending).toBe(true);
  });

  it("returns 500 for a genuine (non-missing-table) upsert error", async () => {
    const upsert = vi.fn(async () => ({ error: new Error("connection reset") }));
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase({ upsert }) as never);

    const response = await PUT(putRequest({ budEnabledProductKeys: ["name:mnexspike"] }));
    expect(response.status).toBe(500);
  });
});
