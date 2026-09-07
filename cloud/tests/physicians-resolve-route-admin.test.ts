import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireAuthenticatedUser: vi.fn(async () => ({ user: { id: "staff-1", email: "staff@example.com" } })),
}));

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServerClient: vi.fn(),
}));

import { GET } from "@/app/api/physicians/resolve/route";
import { getSupabaseServerClient } from "@/lib/supabase/server";

function authedRequest(path: string) {
  return new Request(`http://localhost${path}`, { headers: { Authorization: "Bearer test-token" } });
}

const VACCINE_ID = "11111111-1111-1111-1111-111111111111";

/** Builds a `from` mock matching the route's real (post-fix) shape: two
 * separate parameterized calls against physician_rule — .eq("vaccine_id", ...)
 * for the exact-vaccine half and .is("vaccine_id", null) for the wildcard
 * half — plus a plain physician select. See route.ts's SECURITY doc
 * comment for why this replaced a single .or() call.
 *
 * Also mocks the "vaccine" table lookup added for V-cloud-tabs group-rule
 * matching (route.ts fetches the vaccine's name via
 * .eq("id", vaccineId).maybeSingle() to compute its catalog group) —
 * `vaccineRow` defaults to null (vaccine not found / lookup not relevant
 * to a given test), which resolves to vaccineGroup: null, preserving
 * every pre-existing test's behavior exactly. */
function mockFrom(options: {
  vaccineRuleRows?: unknown[];
  vaccineRulesError?: Error | null;
  wildcardRuleRows?: unknown[];
  wildcardRulesError?: Error | null;
  physicianRows?: unknown[];
  physiciansError?: Error | null;
  vaccineRow?: { name: string } | null;
  onEq?: (column: string, value: string) => void;
  onIs?: (column: string, value: unknown) => void;
}) {
  const {
    vaccineRuleRows = [],
    vaccineRulesError = null,
    wildcardRuleRows = [],
    wildcardRulesError = null,
    physicianRows = [],
    physiciansError = null,
    vaccineRow = null,
    onEq,
    onIs,
  } = options;

  return vi.fn((table: string) => {
    if (table === "physician_rule") {
      return {
        select: () => ({
          eq: async (column: string, value: string) => {
            onEq?.(column, value);
            return { data: vaccineRuleRows, error: vaccineRulesError };
          },
          is: async (column: string, value: unknown) => {
            onIs?.(column, value);
            return { data: wildcardRuleRows, error: wildcardRulesError };
          },
        }),
      };
    }
    if (table === "physician") {
      return { select: async () => ({ data: physicianRows, error: physiciansError }) };
    }
    if (table === "vaccine") {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: vaccineRow, error: null }),
          }),
        }),
      };
    }
    throw new Error(`unexpected table ${table}`);
  });
}

describe("GET /api/physicians/resolve", () => {
  afterEach(() => {
    vi.mocked(getSupabaseServerClient).mockReset();
  });

  it("rejects a missing vaccineId", async () => {
    const response = await GET(authedRequest("/api/physicians/resolve?ageYears=10"));
    expect(response.status).toBe(400);
    expect(getSupabaseServerClient).not.toHaveBeenCalled();
  });

  it("rejects a non-UUID vaccineId", async () => {
    const response = await GET(authedRequest("/api/physicians/resolve?vaccineId=not-a-uuid&ageYears=10"));
    expect(response.status).toBe(400);
    expect(getSupabaseServerClient).not.toHaveBeenCalled();
  });

  // Regression guard (review fix): the route used to interpolate vaccineId
  // raw into a single `.or(`vaccine_id.eq.${vaccineId},vaccine_id.is.null`)`
  // call — PostgREST parses that as a comma-separated filter list, so a
  // vaccineId containing its own comma+operator could append an extra
  // clause and broaden the rule set returned. The UUID format check now
  // rejects any such value before Supabase is ever touched, and the .or()
  // call itself is gone (replaced by two parameterized .eq()/.is() calls).
  it("rejects a comma/operator-bearing vaccineId (PostgREST .or() injection attempt) with 400, never touching Supabase", async () => {
    const injection = `${VACCINE_ID},priority.gt.-999999`;
    const response = await GET(
      authedRequest(`/api/physicians/resolve?vaccineId=${encodeURIComponent(injection)}&ageYears=10`)
    );
    expect(response.status).toBe(400);
    expect(getSupabaseServerClient).not.toHaveBeenCalled();
  });

  it("rejects a missing/non-numeric ageYears", async () => {
    const response = await GET(authedRequest(`/api/physicians/resolve?vaccineId=${VACCINE_ID}`));
    expect(response.status).toBe(400);

    const responseNaN = await GET(
      authedRequest(`/api/physicians/resolve?vaccineId=${VACCINE_ID}&ageYears=abc`)
    );
    expect(responseNaN.status).toBe(400);
  });

  it("resolves the matching physician, querying the exact vaccine and the wildcard as two separate parameterized calls", async () => {
    const eqCalls: Array<[string, string]> = [];
    const isCalls: Array<[string, unknown]> = [];
    const from = mockFrom({
      vaccineRuleRows: [
        { id: "r1", physician_id: "p1", vaccine_id: VACCINE_ID, min_age: 3, max_age: null, priority: 0 },
      ],
      physicianRows: [{ id: "p1", display_name: "Rivera, Ana", alternate_id: "ALTPRIMARY" }],
      onEq: (column, value) => eqCalls.push([column, value]),
      onIs: (column, value) => isCalls.push([column, value]),
    });
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from } as never);

    const response = await GET(authedRequest(`/api/physicians/resolve?vaccineId=${VACCINE_ID}&ageYears=10`));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.physician).toEqual({ id: "p1", display_name: "Rivera, Ana", alternate_id: "ALTPRIMARY" });
    expect(eqCalls).toEqual([["vaccine_id", VACCINE_ID]]);
    expect(isCalls).toEqual([["vaccine_id", null]]);
  });

  it("also resolves via a wildcard (vaccine_id IS NULL) rule when no exact-vaccine rule matches", async () => {
    const from = mockFrom({
      vaccineRuleRows: [], // no rule specific to this vaccine
      wildcardRuleRows: [
        { id: "r2", physician_id: "p2", vaccine_id: null, min_age: 12, max_age: null, priority: 0 },
      ],
      physicianRows: [{ id: "p2", display_name: "Kim, David", alternate_id: "ALTSECOND" }],
    });
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from } as never);

    const response = await GET(authedRequest(`/api/physicians/resolve?vaccineId=${VACCINE_ID}&ageYears=30`));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.physician).toEqual({ id: "p2", display_name: "Kim, David", alternate_id: "ALTSECOND" });
  });

  it("returns physician: null when nothing matches", async () => {
    const from = mockFrom({});
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from } as never);

    const response = await GET(authedRequest(`/api/physicians/resolve?vaccineId=${VACCINE_ID}&ageYears=10`));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.physician).toBeNull();
  });

  it("returns 500 when the exact-vaccine rules call errors", async () => {
    const from = mockFrom({ vaccineRulesError: new Error("boom") });
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from } as never);

    const response = await GET(authedRequest(`/api/physicians/resolve?vaccineId=${VACCINE_ID}&ageYears=10`));
    expect(response.status).toBe(500);
  });

  it("returns 500 when the wildcard rules call errors", async () => {
    const from = mockFrom({ wildcardRulesError: new Error("boom") });
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from } as never);

    const response = await GET(authedRequest(`/api/physicians/resolve?vaccineId=${VACCINE_ID}&ageYears=10`));
    expect(response.status).toBe(500);
  });

  it("returns 500 when the physicians call errors", async () => {
    const from = mockFrom({ physiciansError: new Error("boom") });
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from } as never);

    const response = await GET(authedRequest(`/api/physicians/resolve?vaccineId=${VACCINE_ID}&ageYears=10`));
    expect(response.status).toBe(500);
  });

  // V-cloud-tabs: group-rule matching end to end through the real route.
  it("resolves via a matching vaccine_group rule (fetched through the same wildcard .is() call, distinguished by vaccine_group) when the vaccine's name maps to that group", async () => {
    const from = mockFrom({
      vaccineRuleRows: [],
      wildcardRuleRows: [
        { id: "group-rule", physician_id: "p3", vaccine_id: null, vaccine_group: "Flu", min_age: 6, max_age: null, priority: 0 },
      ],
      physicianRows: [{ id: "p3", display_name: "Ortiz, Maria", alternate_id: "ALTFLU" }],
      vaccineRow: { name: "Fluzone High-Dose" },
    });
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from } as never);

    const response = await GET(authedRequest(`/api/physicians/resolve?vaccineId=${VACCINE_ID}&ageYears=70`));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.physician).toEqual({ id: "p3", display_name: "Ortiz, Maria", alternate_id: "ALTFLU" });
  });

  it("a specific-vaccine rule still outranks a matching group rule end to end", async () => {
    const from = mockFrom({
      vaccineRuleRows: [
        { id: "specific-rule", physician_id: "p1", vaccine_id: VACCINE_ID, min_age: 6, max_age: null, priority: 99 },
      ],
      wildcardRuleRows: [
        { id: "group-rule", physician_id: "p3", vaccine_id: null, vaccine_group: "Flu", min_age: 6, max_age: null, priority: 0 },
      ],
      physicianRows: [
        { id: "p1", display_name: "Rivera, Ana", alternate_id: "ALTPRIMARY" },
        { id: "p3", display_name: "Ortiz, Maria", alternate_id: "ALTFLU" },
      ],
      vaccineRow: { name: "Fluzone High-Dose" },
    });
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from } as never);

    const response = await GET(authedRequest(`/api/physicians/resolve?vaccineId=${VACCINE_ID}&ageYears=70`));
    const body = await response.json();
    expect(body.physician).toEqual({ id: "p1", display_name: "Rivera, Ana", alternate_id: "ALTPRIMARY" });
  });

  it("a group rule for a DIFFERENT group than the vaccine's does not match, falling through to the plain wildcard", async () => {
    const from = mockFrom({
      wildcardRuleRows: [
        { id: "group-rule", physician_id: "p3", vaccine_id: null, vaccine_group: "COVID", min_age: 3, max_age: null, priority: 0 },
        { id: "wildcard", physician_id: "p2", vaccine_id: null, vaccine_group: null, min_age: 3, max_age: null, priority: 0 },
      ],
      physicianRows: [
        { id: "p2", display_name: "Kim, David", alternate_id: "ALTSECOND" },
        { id: "p3", display_name: "Ortiz, Maria", alternate_id: "ALTFLU" },
      ],
      vaccineRow: { name: "Fluzone High-Dose" },
    });
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from } as never);

    const response = await GET(authedRequest(`/api/physicians/resolve?vaccineId=${VACCINE_ID}&ageYears=30`));
    const body = await response.json();
    expect(body.physician).toEqual({ id: "p2", display_name: "Kim, David", alternate_id: "ALTSECOND" });
  });

  it("pre-migration data (no vaccine_group key on the row at all) behaves as a plain wildcard, never crashes", async () => {
    const from = mockFrom({
      wildcardRuleRows: [{ id: "wildcard", physician_id: "p2", vaccine_id: null, min_age: 3, max_age: null, priority: 0 }],
      physicianRows: [{ id: "p2", display_name: "Kim, David", alternate_id: "ALTSECOND" }],
      vaccineRow: { name: "Fluzone High-Dose" },
    });
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from } as never);

    const response = await GET(authedRequest(`/api/physicians/resolve?vaccineId=${VACCINE_ID}&ageYears=30`));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.physician).toEqual({ id: "p2", display_name: "Kim, David", alternate_id: "ALTSECOND" });
  });
});
