import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireAuthenticatedUser: vi.fn(async () => ({ user: { id: "staff-1", email: "staff@example.com" } })),
}));

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServerClient: vi.fn(),
}));

// The catalog-matched name path (deriveProductViewFields) is its own
// unit-tested module (lib/product-view.ts's own tests, plus
// lib/lots-display-name.ts's) — stubbed here to a deterministic
// transform so this route's OWN behavior (pivoting/auth/validation)
// doesn't depend on the real static catalog's contents drifting.
vi.mock("@/lib/product-view", () => ({
  deriveProductViewFields: (name: string) => ({ displayName: `Clean: ${name}` }),
}));

import { GET } from "@/app/api/administered/doses-given/route";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { administeredDayKey } from "@/lib/administered/store";

const CATALOG = [{ id: "v-fluad", name: "Fluad Quadrivalent PFS", ndc: null }];

function authedRequest(path: string) {
  return new Request(`http://localhost${path}`, { headers: { Authorization: "Bearer test-token" } });
}

// `days` is keyed by administeredDayKey(date) ("administered:YYYY-MM-DD")
// -> the stored AdministeredDay value. The `.like().order().limit()`
// chain below (added for the `?earliestOnly=1` path — see
// getEarliestAdministeredDate in route.ts) only ever reads the KEYS,
// same "key-only, never the `rows` payload" contract that function
// documents, so it's implemented independently of the `.eq().
// maybeSingle()` chain the normal per-day reads use.
function fakeSupabase(
  days: Record<string, unknown>,
  catalog: unknown[] = CATALOG,
  options: { likeError?: unknown } = {}
) {
  return {
    from: (table: string) => {
      if (table === "vaccine") {
        return { select: async () => ({ data: catalog, error: null }) };
      }
      if (table === "app_setting") {
        return {
          select: () => ({
            eq: (_column: string, key: string) => ({
              maybeSingle: async () => ({ data: key in days ? { value: days[key] } : null, error: null }),
            }),
            like: (_column: string, pattern: string) => ({
              order: () => ({
                limit: async () => {
                  if (options.likeError) return { data: null, error: options.likeError };
                  const prefix = pattern.replace(/%$/, "");
                  const matchingKeys = Object.keys(days)
                    .filter((key) => key.startsWith(prefix))
                    .sort();
                  return { data: matchingKeys.length ? [{ key: matchingKeys[0] }] : [], error: null };
                },
              }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

describe("GET /api/administered/doses-given", () => {
  afterEach(() => {
    vi.mocked(getSupabaseServerClient).mockReset();
  });

  it("requires auth — an unauthenticated GET returns 401", async () => {
    const { requireAuthenticatedUser } = await import("@/lib/auth");
    vi.mocked(requireAuthenticatedUser).mockResolvedValueOnce({
      error: new Response(null, { status: 401 }) as never,
    } as never);

    const response = await GET(
      new Request("http://localhost/api/administered/doses-given?start=2026-09-01&end=2026-09-02")
    );
    expect(response.status).toBe(401);
    expect(getSupabaseServerClient).not.toHaveBeenCalled();
  });

  it("rejects a request missing start/end", async () => {
    const response = await GET(authedRequest("/api/administered/doses-given"));
    expect(response.status).toBe(400);
    expect(getSupabaseServerClient).not.toHaveBeenCalled();
  });

  it("rejects an invalid date format", async () => {
    const response = await GET(authedRequest("/api/administered/doses-given?start=09-01-2026&end=2026-09-02"));
    expect(response.status).toBe(400);
  });

  it("rejects start after end", async () => {
    const response = await GET(authedRequest("/api/administered/doses-given?start=2026-09-05&end=2026-09-01"));
    expect(response.status).toBe(400);
  });

  it("returns a day x product pivot for the requested range", async () => {
    const day = {
      date: "2026-09-01",
      rows: [
        { at: "2026-09-01T20:00:00.000Z", itemName: "FLUAD QUADRIVALENT PFS", vaccineId: "v-fluad", occurrence: 0 },
        { at: "2026-09-01T20:05:00.000Z", itemName: "UNMATCHED ITEM", vaccineId: null, occurrence: 0 },
      ],
      updatedAt: "2026-09-01T20:10:00.000Z",
      sources: ["ses:msg-1"],
    };
    vi.mocked(getSupabaseServerClient).mockReturnValue(
      fakeSupabase({ [administeredDayKey("2026-09-01")]: day }) as never
    );

    const response = await GET(authedRequest("/api/administered/doses-given?start=2026-09-01&end=2026-09-02"));
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.dates).toEqual(["2026-09-01", "2026-09-02"]);
    // The catalog-matched dose resolves through the (stubbed)
    // deriveProductViewFields rather than the raw Pioneer item name;
    // the unmatched dose (vaccineId: null) falls back to its raw name.
    expect(body.products).toContain("Clean: Fluad Quadrivalent PFS");
    expect(body.products).toContain("UNMATCHED ITEM");
    expect(body.totalsByDate["2026-09-01"]).toBe(2);
    expect(body.totalsByDate["2026-09-02"]).toBe(0);
    expect(body.grandTotal).toBe(2);
    expect(body.countsByDateProduct["2026-09-01"]["UNMATCHED ITEM"]).toBe(1);
  });

  it("rejects a range wider than the configured max", async () => {
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase({}) as never);
    const response = await GET(authedRequest("/api/administered/doses-given?start=2020-01-01&end=2026-09-01"));
    expect(response.status).toBe(400);
  });

  it("returns 503 when Supabase is not configured", async () => {
    vi.mocked(getSupabaseServerClient).mockImplementation(() => {
      throw new Error("Supabase is not configured.");
    });
    const response = await GET(authedRequest("/api/administered/doses-given?start=2026-09-01&end=2026-09-02"));
    expect(response.status).toBe(503);
  });

  it("returns 500 when the vaccine catalog query fails", async () => {
    vi.mocked(getSupabaseServerClient).mockReturnValue({
      from: (table: string) => {
        if (table === "vaccine") return { select: async () => ({ data: null, error: new Error("boom") }) };
        return fakeSupabase({}).from(table);
      },
    } as never);
    const response = await GET(authedRequest("/api/administered/doses-given?start=2026-09-01&end=2026-09-02"));
    expect(response.status).toBe(500);
  });
});

// V-doses-given-layout (Will 2026-09-13): the page's default range needs
// the earliest ingested day BEFORE it knows what range to request, so
// this cheap path is checked (and must short-circuit) before start/end
// are even required — see getEarliestAdministeredDate and the `?
// earliestOnly=1` branch in route.ts's own doc comments.
describe("GET /api/administered/doses-given?earliestOnly=1", () => {
  afterEach(() => {
    vi.mocked(getSupabaseServerClient).mockReset();
  });

  it("requires auth just like the normal path", async () => {
    const { requireAuthenticatedUser } = await import("@/lib/auth");
    vi.mocked(requireAuthenticatedUser).mockResolvedValueOnce({
      error: new Response(null, { status: 401 }) as never,
    } as never);

    const response = await GET(authedRequest("/api/administered/doses-given?earliestOnly=1"));
    expect(response.status).toBe(401);
    expect(getSupabaseServerClient).not.toHaveBeenCalled();
  });

  it("never requires start/end", async () => {
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase({}) as never);
    const response = await GET(authedRequest("/api/administered/doses-given?earliestOnly=1"));
    expect(response.status).toBe(200);
  });

  it("returns the earliest administered day across every stored key, regardless of insertion order", async () => {
    vi.mocked(getSupabaseServerClient).mockReturnValue(
      fakeSupabase({
        [administeredDayKey("2026-09-01")]: { date: "2026-09-01", rows: [], updatedAt: "", sources: [] },
        [administeredDayKey("2026-08-04")]: { date: "2026-08-04", rows: [], updatedAt: "", sources: [] },
        [administeredDayKey("2026-08-20")]: { date: "2026-08-20", rows: [], updatedAt: "", sources: [] },
      }) as never
    );

    const response = await GET(authedRequest("/api/administered/doses-given?earliestOnly=1"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ earliestDay: "2026-08-04" });
  });

  it("returns earliestDay: null when nothing has been ingested yet", async () => {
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase({}) as never);
    const response = await GET(authedRequest("/api/administered/doses-given?earliestOnly=1"));
    const body = await response.json();
    expect(body).toEqual({ earliestDay: null });
  });

  it("degrades to earliestDay: null (not an error) when app_setting doesn't exist yet", async () => {
    const missingTableError = { code: "PGRST205", message: "Could not find the table 'app_setting' in the schema cache" };
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase({}, CATALOG, { likeError: missingTableError }) as never);
    const response = await GET(authedRequest("/api/administered/doses-given?earliestOnly=1"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ earliestDay: null });
  });

  it("returns 503 when Supabase is not configured", async () => {
    vi.mocked(getSupabaseServerClient).mockImplementation(() => {
      throw new Error("Supabase is not configured.");
    });
    const response = await GET(authedRequest("/api/administered/doses-given?earliestOnly=1"));
    expect(response.status).toBe(503);
  });
});
