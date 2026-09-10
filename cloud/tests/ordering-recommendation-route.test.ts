import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same pattern as tests/vaccines-route-admin.test.ts / acuity-poll-route.test.ts:
// mock auth to always succeed so the route's OWN logic can be exercised
// directly; the real 401-with-no-header gate is covered separately below
// (unmocked).
vi.mock("@/lib/auth", () => ({
  requireAuthenticatedUser: vi.fn(async () => ({ user: { id: "staff-1", email: "staff@example.com" } })),
}));

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServerClient: vi.fn(),
}));

vi.mock("@/lib/acuity-credentials", () => ({
  getAcuityCredentials: vi.fn(async () => null),
}));

vi.mock("@/lib/acuity-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/acuity-client")>("@/lib/acuity-client");
  return {
    ...actual,
    fetchAppointmentTypes: vi.fn(),
    fetchAppointmentsForRange: vi.fn(),
  };
});

import { GET } from "@/app/api/ordering/recommendation/route";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getAcuityCredentials } from "@/lib/acuity-credentials";
import { fetchAppointmentTypes, fetchAppointmentsForRange, AcuityApiError } from "@/lib/acuity-client";

const CATALOG = [
  { id: "v-flu", name: "Flu Quad 2025-26", short_code: "fluquad", ndc: null, active: true },
  { id: "v-mmr", name: "MMR-II", short_code: "mmrii", ndc: null, active: true },
];

function authedRequest() {
  return new Request("http://localhost/api/ordering/recommendation", {
    headers: { Authorization: "Bearer test-token" },
  });
}

type FakeAddress = { id: string; user_id: string; token: string; enabled: boolean; created_at: string; last_received_at: string | null };
type FakeTargetRow = { scope: string; key: string; target_on_hand: number };

// `address` defaults to "missing-table", which makes the real
// getOrCreateAddressForUser (this route file does NOT mock
// @/lib/on-hand/address — it calls the real implementation against this
// fake supabase client) throw a proper 42P01-shaped error, exactly what
// Postgres/PostgREST returns for a query against a table that doesn't
// exist. That's deliberate: it's how these tests exercise the route's
// graceful-fallback path (V-onhand-account-address, Will 2026-09-08) —
// getOrCreateAddressForUser throws, the route's NARROWED catch (review
// fix item 7) recognizes isMissingTableError and falls back to the
// pre-feature UNSCOPED on_hand_count query, so every existing test below
// keeps passing unchanged. Pass an actual FakeAddress object to exercise
// the new per-account .or() scoping, or "error" to exercise the item-7
// regression test (a non-missing-table failure must 503, never be
// silently swallowed).
//
// `targetRows: null` simulates ordering_target not existing yet (0011
// pending) — the route must degrade to targetsPending:true, not error.
//
// `walkInPct` (V-T26 item 1) defaults to "missing-table" (0012 pending —
// the route falls back to the default 25%/pending:true) so every
// existing test below keeps passing unchanged; pass a number to
// exercise a saved walk-up % setting, or "error" for a genuine
// (non-missing-table) Supabase failure.
function fakeSupabase(
  onHandRows: unknown[] = [],
  catalog: unknown[] = CATALOG,
  address: FakeAddress | "missing-table" | "error" = "missing-table",
  targetRows: FakeTargetRow[] | null = [],
  walkInPct: number | "missing-table" | "error" = "missing-table"
) {
  return {
    from: (table: string) => {
      if (table === "vaccine") {
        return {
          select: () => ({
            order: async () => ({ data: catalog, error: null }),
          }),
        };
      }
      if (table === "on_hand_count") {
        return {
          select: () => ({
            eq: () => ({
              // Real Supabase's .or(...) takes a PostgREST filter string
              // like "inbound_email_address_id.eq.addr-1,inbound_email_address_id.is.null" —
              // this stand-in parses just enough of that shape to filter
              // onHandRows the same way Postgres would.
              or: (filter: string) => {
                const match = filter.match(/inbound_email_address_id\.eq\.([^,]+)/);
                const allowedId = match ? match[1] : null;
                const filtered = (onHandRows as Array<{ inbound_email_address_id?: string | null }>).filter(
                  (row) => row.inbound_email_address_id === allowedId || row.inbound_email_address_id == null
                );
                return { order: async () => ({ data: filtered, error: null }) };
              },
              order: async () => ({ data: onHandRows, error: null }),
            }),
          }),
        };
      }
      if (table === "inbound_email_address") {
        if (typeof address === "object" && address !== null) {
          return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: address, error: null }) }) }) };
        }
        if (address === "error") {
          return {
            select: () => ({
              eq: () => ({ maybeSingle: async () => ({ data: null, error: new Error("connection reset") }) }),
            }),
          };
        }
        // "missing-table" default (0010 pending).
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: null,
                error: { code: "42P01", message: 'relation "inbound_email_address" does not exist' },
              }),
            }),
          }),
        };
      }
      if (table === "ordering_target") {
        if (targetRows === null) {
          return {
            select: async () => ({
              data: null,
              error: { code: "42P01", message: 'relation "ordering_target" does not exist' },
            }),
          };
        }
        return { select: async () => ({ data: targetRows, error: null }) };
      }
      if (table === "app_setting") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => {
                if (walkInPct === "missing-table") {
                  return { data: null, error: { code: "42P01", message: 'relation "app_setting" does not exist' } };
                }
                if (walkInPct === "error") {
                  return { data: null, error: new Error("connection reset") };
                }
                return { data: { value: walkInPct }, error: null };
              },
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

describe("GET /api/ordering/recommendation", () => {
  beforeEach(() => {
    vi.mocked(getAcuityCredentials).mockResolvedValue(null);
  });

  afterEach(() => {
    vi.mocked(getSupabaseServerClient).mockReset();
    vi.mocked(getAcuityCredentials).mockReset();
    vi.mocked(fetchAppointmentTypes).mockReset();
    vi.mocked(fetchAppointmentsForRange).mockReset();
  });

  it("returns rows for every active vaccine with upcoming7d=0 when Acuity isn't configured, and null on-hand when none received yet", async () => {
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase([]) as never);

    const response = await GET(authedRequest());
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.onHandLastReceivedAt).toBeNull();
    expect(body.targetsPending).toBe(false);
    expect(body.rows).toHaveLength(2);
    const fluRow = body.rows.find((r: { key: string }) => r.key === "vaccine:v-flu");
    expect(fluRow).toMatchObject({
      vaccineName: "Flu Quad 2025-26",
      ndc: null,
      active: true,
      upcoming7d: 0,
      onHand: null,
      onHandAsOf: null,
      recommendedTarget: 0,
      targetOnHand: null,
      effectiveTarget: 0,
      targetSource: "recommended",
      order: 0,
    });
  });

  it("picks the latest matched on-hand row per vaccine and computes order from the recommended target", async () => {
    const onHandRows = [
      { vaccine_id: "v-flu", quantity: 8, received_at: "2026-08-19T13:00:00.000Z" },
      { vaccine_id: "v-flu", quantity: 100, received_at: "2026-08-10T09:00:00.000Z" }, // older, must be ignored
      { vaccine_id: "v-mmr", quantity: 2, received_at: "2026-08-18T08:00:00.000Z" },
    ];
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase(onHandRows) as never);

    const response = await GET(authedRequest());
    const body = await response.json();

    expect(body.onHandLastReceivedAt).toBe("2026-08-19T13:00:00.000Z");
    const fluRow = body.rows.find((r: { key: string }) => r.key === "vaccine:v-flu");
    expect(fluRow).toMatchObject({
      vaccineName: "Flu Quad 2025-26",
      upcoming7d: 0,
      onHand: 8,
      onHandAsOf: "2026-08-19T13:00:00.000Z",
      recommendedTarget: 0,
      order: 0, // recommended 0, onHand 8, clamped at 0
    });
  });

  // --- V-onhand-ndc-units (Will 2026-09-09/10): "display unit size for
  // each item, new column, after NDC" ---
  describe("unitSize", () => {
    it("combines stock_size + the unit recovered from raw_line's 4th field", async () => {
      const onHandRows = [
        {
          vaccine_id: "v-flu",
          quantity: 8,
          received_at: "2026-08-19T13:00:00.000Z",
          stock_size: 1,
          raw_line: "Flu Quad Vial | 00000000000 | 8 EA | 1 EA",
        },
      ];
      vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase(onHandRows) as never);

      const response = await GET(authedRequest());
      const body = await response.json();
      const fluRow = body.rows.find((r: { key: string }) => r.key === "vaccine:v-flu");
      expect(fluRow.unitSize).toBe("1 EA");
    });

    it("falls back to the bare numeric stock_size when raw_line carries no recognizable unit", async () => {
      const onHandRows = [
        {
          vaccine_id: "v-flu",
          quantity: 8,
          received_at: "2026-08-19T13:00:00.000Z",
          stock_size: 0.5,
          raw_line: "Flu Quad Vial, 8",
        },
      ];
      vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase(onHandRows) as never);

      const response = await GET(authedRequest());
      const body = await response.json();
      const fluRow = body.rows.find((r: { key: string }) => r.key === "vaccine:v-flu");
      expect(fluRow.unitSize).toBe("0.5");
    });

    it("is null when there is no on-hand row for the product at all", async () => {
      vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase([]) as never);

      const response = await GET(authedRequest());
      const body = await response.json();
      const fluRow = body.rows.find((r: { key: string }) => r.key === "vaccine:v-flu");
      expect(fluRow.unitSize).toBeNull();
    });

    it("is null when stock_size itself is null (0011 applied, but this particular batch line had no stock size)", async () => {
      const onHandRows = [
        {
          vaccine_id: "v-flu",
          quantity: 8,
          received_at: "2026-08-19T13:00:00.000Z",
          stock_size: null,
          raw_line: "Flu Quad Vial | 00000000000 | 8 EA |",
        },
      ];
      vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase(onHandRows) as never);

      const response = await GET(authedRequest());
      const body = await response.json();
      const fluRow = body.rows.find((r: { key: string }) => r.key === "vaccine:v-flu");
      expect(fluRow.unitSize).toBeNull();
    });
  });

  it("sums Acuity upcoming appointment counts per matched vaccine into upcoming7d", async () => {
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase([]) as never);
    vi.mocked(getAcuityCredentials).mockResolvedValue({ userId: "u", apiKey: "k", source: "env" });
    vi.mocked(fetchAppointmentTypes).mockResolvedValue([]);
    vi.mocked(fetchAppointmentsForRange).mockResolvedValue({
      appointments: [
        {
          date: "2026-08-19",
          appointmentTypeId: 1,
          hourOfDay: 10,
          vaccineNames: ["Flu Quad 2025-26"],
          testNames: [],
          covidBrand: "any",
          covidAgeBucket: "unknown",
          fluAgeBucket: "unknown",
          createdDate: "2026-08-10",
        },
        {
          date: "2026-08-20",
          appointmentTypeId: 1,
          hourOfDay: 10,
          vaccineNames: ["Flu Quad 2025-26"],
          testNames: [],
          covidBrand: "any",
          covidAgeBucket: "unknown",
          fluAgeBucket: "unknown",
          createdDate: "2026-08-10",
        },
        {
          date: "2026-08-20",
          appointmentTypeId: 1,
          hourOfDay: 10,
          vaccineNames: ["Some Unmatched Vaccine"],
          testNames: [],
          covidBrand: "any",
          covidAgeBucket: "unknown",
          fluAgeBucket: "unknown",
          createdDate: "2026-08-10",
        },
      ],
      possiblyTruncated: false,
    });

    const response = await GET(authedRequest());
    expect(response.status).toBe(200);
    const body = await response.json();

    // "Flu Quad 2025-26" contains "flu" (V-T-schedule-table ROUND 2), so
    // aggregateAppointmentCounts rewrites it to the "Flu · Unknown"
    // composite before this route ever sees it. This test IS the
    // regression the follow-up fix addresses: without
    // compositeNameToMatchableBase stripping that composite back down to
    // "Flu" before matchVaccineName runs, upcoming7d silently drops to 0
    // (the "Flu · Unknown" string doesn't resemble any catalog name).
    const fluRow = body.rows.find((r: { key: string }) => r.key === "vaccine:v-flu");
    expect(fluRow.upcoming7d).toBe(2);
    // recommendedTarget for upcoming7d=2: buffer = max(1, ceil(2*0.25)) = 1 -> 2+1 = 3; order = 3-0
    expect(fluRow.recommendedTarget).toBe(3);
    expect(fluRow.order).toBe(3);

    const mmrRow = body.rows.find((r: { key: string }) => r.key === "vaccine:v-mmr");
    expect(mmrRow.upcoming7d).toBe(0);
  });

  // Regression test for the LATENT gap this same fix closes for COVID —
  // present since ROUND 1's brand/age composite shipped, but never
  // exercised by a test until now (Will, V-T-schedule-table ROUND 2
  // follow-up, 2026-09-05): a COVID appointment's aggregated vaccineName
  // is always a "COVID · {Brand} · {Age}" composite (see
  // covidCompositeName in lib/acuity-client.ts), which never resembled
  // any catalog name either — so upcoming7d silently stayed 0 for every
  // COVID appointment, brand notwithstanding, until this fix.
  it("sums COVID composite appointment counts into upcoming7d, keeping Pfizer and Moderna on separate catalog rows", async () => {
    const covidCatalog = [
      { id: "v-comirnaty", name: "Comirnaty 2025-26 12+", short_code: "comirnaty12", ndc: null, active: true },
      { id: "v-mnexspike", name: "mNEXSPIKE", short_code: "mnexspike", ndc: null, active: true },
    ];
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase([], covidCatalog) as never);
    vi.mocked(getAcuityCredentials).mockResolvedValue({ userId: "u", apiKey: "k", source: "env" });
    vi.mocked(fetchAppointmentTypes).mockResolvedValue([]);
    vi.mocked(fetchAppointmentsForRange).mockResolvedValue({
      appointments: [
        {
          date: "2026-08-19",
          appointmentTypeId: 1,
          hourOfDay: 10,
          vaccineNames: ["COVID-Pfizer"],
          testNames: [],
          covidBrand: "pfizer",
          covidAgeBucket: "65+",
          fluAgeBucket: "unknown",
          createdDate: "2026-08-10",
        },
        {
          date: "2026-08-20",
          appointmentTypeId: 1,
          hourOfDay: 10,
          vaccineNames: ["COVID-Pfizer"],
          testNames: [],
          covidBrand: "pfizer",
          covidAgeBucket: "12-64",
          fluAgeBucket: "unknown",
          createdDate: "2026-08-10",
        },
        {
          date: "2026-08-20",
          appointmentTypeId: 1,
          hourOfDay: 10,
          vaccineNames: ["COVID-Moderna"],
          testNames: [],
          covidBrand: "moderna",
          covidAgeBucket: "12-64",
          fluAgeBucket: "unknown",
          createdDate: "2026-08-10",
        },
      ],
      possiblyTruncated: false,
    });

    const response = await GET(authedRequest());
    expect(response.status).toBe(200);
    const body = await response.json();

    const pfizerRow = body.rows.find((r: { key: string }) => r.key === "vaccine:v-comirnaty");
    expect(pfizerRow.upcoming7d).toBe(2);
    const modernaRow = body.rows.find((r: { key: string }) => r.key === "vaccine:v-mnexspike");
    expect(modernaRow.upcoming7d).toBe(1);
  });

  // V-covid-season-agnostic-match (review follow-up, live bug after
  // d7e123f): the lot-list apply renamed the on-file DB rows mid-season
  // ("Comirnaty 2025-26 12+" -> "Comirnaty 2026-27 12+", "mNEXSPIKE" ->
  // "mNEXSPIKE 2026-27"), which silently zeroed upcoming7d for BOTH
  // COVID products under the old EXACT-string match in
  // COMPOSITE_BASE_TO_CATALOG_NAME. Same scenario as the test above, but
  // against the renamed catalog names.
  it("still attributes COVID composite counts correctly after the DB rows are renamed with a season suffix", async () => {
    const renamedCovidCatalog = [
      { id: "v-comirnaty", name: "Comirnaty 2026-27 12+", short_code: "comirnaty12", ndc: null, active: true },
      { id: "v-mnexspike", name: "mNEXSPIKE 2026-27", short_code: "mnexspike", ndc: null, active: true },
    ];
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase([], renamedCovidCatalog) as never);
    vi.mocked(getAcuityCredentials).mockResolvedValue({ userId: "u", apiKey: "k", source: "env" });
    vi.mocked(fetchAppointmentTypes).mockResolvedValue([]);
    vi.mocked(fetchAppointmentsForRange).mockResolvedValue({
      appointments: [
        {
          date: "2026-08-19",
          appointmentTypeId: 1,
          hourOfDay: 10,
          vaccineNames: ["COVID-NEW Booster (age 12+ 2026-27 version)"],
          testNames: [],
          covidBrand: "pfizer",
          covidAgeBucket: "65+",
          fluAgeBucket: "unknown",
          createdDate: "2026-08-10",
        },
        {
          date: "2026-08-20",
          appointmentTypeId: 1,
          hourOfDay: 10,
          vaccineNames: ["COVID-NEW Booster (age 12+ 2026-27 version)"],
          testNames: [],
          covidBrand: "pfizer",
          covidAgeBucket: "12-64",
          fluAgeBucket: "unknown",
          createdDate: "2026-08-10",
        },
        {
          date: "2026-08-20",
          appointmentTypeId: 1,
          hourOfDay: 10,
          vaccineNames: ["COVID-NEW Booster (age 12+ 2026-27 version)"],
          testNames: [],
          covidBrand: "moderna",
          covidAgeBucket: "12-64",
          fluAgeBucket: "unknown",
          createdDate: "2026-08-10",
        },
        {
          date: "2026-08-20",
          appointmentTypeId: 1,
          hourOfDay: 10,
          vaccineNames: ["COVID-NEW Booster (age 12+ 2026-27 version)"],
          testNames: [],
          covidBrand: "any",
          covidAgeBucket: "12-64",
          fluAgeBucket: "unknown",
          createdDate: "2026-08-10",
        },
      ],
      possiblyTruncated: false,
    });

    const response = await GET(authedRequest());
    expect(response.status).toBe(200);
    const body = await response.json();

    // "any" merges into Pfizer (mergeAnyIntoPfizer in
    // lib/appointment-table.ts) — so Comirnaty gets 3 (65+, 12-64, and
    // the "any" one), Moderna gets 1.
    const pfizerRow = body.rows.find((r: { key: string }) => r.key === "vaccine:v-comirnaty");
    expect(pfizerRow.upcoming7d).toBe(3);
    const modernaRow = body.rows.find((r: { key: string }) => r.key === "vaccine:v-mnexspike");
    expect(modernaRow.upcoming7d).toBe(1);
  });

  it("scopes on-hand rows to this user's inbound address plus legacy null-address rows (V-onhand-account-address)", async () => {
    const address: FakeAddress = {
      id: "addr-1",
      user_id: "staff-1", // matches the mocked requireAuthenticatedUser's user.id above
      token: "0123456789abcdef0123456789abcdef",
      enabled: true,
      created_at: "2026-09-01T00:00:00.000Z",
      last_received_at: null,
    };
    const onHandRows = [
      { vaccine_id: "v-flu", quantity: 8, received_at: "2026-08-19T13:00:00.000Z", inbound_email_address_id: "addr-1" }, // this account
      { vaccine_id: "v-mmr", quantity: 2, received_at: "2026-08-18T08:00:00.000Z", inbound_email_address_id: null }, // legacy, pre-feature
      { vaccine_id: "v-flu", quantity: 999, received_at: "2026-08-20T00:00:00.000Z", inbound_email_address_id: "addr-2" }, // a DIFFERENT account — must be excluded
    ];
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase(onHandRows, CATALOG, address) as never);

    const response = await GET(authedRequest());
    const body = await response.json();

    const fluRow = body.rows.find((r: { key: string }) => r.key === "vaccine:v-flu");
    // The addr-2 row (quantity 999) must be excluded — onHand stays 8, not 999.
    expect(fluRow.onHand).toBe(8);
    const mmrRow = body.rows.find((r: { key: string }) => r.key === "vaccine:v-mmr");
    expect(mmrRow.onHand).toBe(2);
  });

  it("returns 502 when the Acuity fetch fails", async () => {
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase([]) as never);
    vi.mocked(getAcuityCredentials).mockResolvedValue({ userId: "u", apiKey: "k", source: "env" });
    vi.mocked(fetchAppointmentTypes).mockRejectedValue(new AcuityApiError("Acuity rejected these credentials."));

    const response = await GET(authedRequest());
    expect(response.status).toBe(502);
  });

  it("returns 503 instead of throwing when Supabase is unconfigured", async () => {
    vi.mocked(getSupabaseServerClient).mockImplementation(() => {
      throw new Error("Supabase server client requested but not configured.");
    });

    const response = await GET(authedRequest());
    expect(response.status).toBe(503);
  });

  // --- V-ordering-targets additions ---------------------------------

  it("collapses a 3-row NDC series (Gardasil doses 1/2/3) into ONE row with summed upcoming7d", async () => {
    const catalog = [
      { id: "v-gard1", name: "Gardasil", short_code: "gardasil1", ndc: "00006-4121-02", active: true },
      { id: "v-gard2", name: "Gardasil", short_code: "gardasil2", ndc: "00006-4121-02", active: true },
      { id: "v-gard3", name: "Gardasil", short_code: "gardasil3", ndc: "00006-4121-02", active: true },
    ];
    const onHandRows = [{ vaccine_id: "v-gard1", ndc: "00006412102", quantity: 40, received_at: "2026-08-19T13:00:00.000Z" }];
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase(onHandRows, catalog) as never);
    vi.mocked(getAcuityCredentials).mockResolvedValue({ userId: "u", apiKey: "k", source: "env" });
    vi.mocked(fetchAppointmentTypes).mockResolvedValue([]);
    vi.mocked(fetchAppointmentsForRange).mockResolvedValue({ appointments: [], possiblyTruncated: false });

    const response = await GET(authedRequest());
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({
      key: "00006412102",
      ndc: "00006412102",
      vaccineName: "Gardasil",
      active: true,
      onHand: 40,
    });
  });

  it("flags an inactive vaccine (still collapsed by NDC) with active:false", async () => {
    const catalog = [
      { id: "v-active", name: "Fluad", short_code: "fluad", ndc: "70461-0123-03", active: true },
      { id: "v-inactive", name: "Discontinued Shot", short_code: "discontinued", ndc: null, active: false },
    ];
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase([], catalog) as never);

    const response = await GET(authedRequest());
    const body = await response.json();

    const inactiveRow = body.rows.find((r: { key: string }) => r.key === "vaccine:v-inactive");
    expect(inactiveRow.active).toBe(false);
    const activeRow = body.rows.find((r: { key: string }) => r.key === "70461012303");
    expect(activeRow.active).toBe(true);
  });

  it("applies an NDC-scoped target override to compute a non-default order", async () => {
    const catalog = [{ id: "v-flu", name: "Flu Quad 2025-26", short_code: "fluquad", ndc: "12345-6789-01", active: true }];
    const onHandRows = [{ vaccine_id: "v-flu", ndc: "12345678901", quantity: 5, received_at: "2026-08-19T13:00:00.000Z" }];
    const targetRows: FakeTargetRow[] = [{ scope: "ndc", key: "12345678901", target_on_hand: 50 }];
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase(onHandRows, catalog, "missing-table", targetRows) as never);

    const response = await GET(authedRequest());
    const body = await response.json();

    expect(body.rows[0]).toMatchObject({
      targetOnHand: 50,
      effectiveTarget: 50,
      targetSource: "ndc",
      order: 45, // 50 - 5
    });
  });

  it("returns targetsPending:true (never an error) before 0011 has been applied", async () => {
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase([], CATALOG, "missing-table", null) as never);

    const response = await GET(authedRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.targetsPending).toBe(true);
    // Falls back to the plain recommendation with no overrides applied.
    const fluRow = body.rows.find((r: { key: string }) => r.key === "vaccine:v-flu");
    expect(fluRow.targetSource).toBe("recommended");
  });

  it("(review fix, item 7) returns 503 when the address lookup fails with something OTHER than a missing-table error", async () => {
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase([], CATALOG, "error") as never);

    const response = await GET(authedRequest());
    // A generic Supabase failure ("connection reset") is NOT a
    // recognizable missing-table shape, so the narrowed catch (item 7)
    // must NOT swallow it and fall back to the unscoped query — it must
    // 503 instead.
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toBe("on-hand lookup failed");
  });

  it("(review fix, item 7) still falls back to the unscoped on-hand query when the address lookup fails with a genuine missing-TABLE error", async () => {
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase([], CATALOG, "missing-table") as never);

    const response = await GET(authedRequest());
    expect(response.status).toBe(200);
  });

  // --- V-T26 additions (Will 2026-09-09) -----------------------------

  describe("walk-up % setting (item 1)", () => {
    it("defaults to 25% with walkInPctPending:true before 0012 has been applied", async () => {
      vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase([], CATALOG) as never);

      const response = await GET(authedRequest());
      const body = await response.json();
      expect(body.walkInPct).toBe(25);
      expect(body.walkInPctPending).toBe(true);
    });

    it("uses a saved walk-up % to compute recommendedTarget/order instead of the 25% default", async () => {
      const catalog = [{ id: "v-flu", name: "Flu Quad 2025-26", short_code: "fluquad", ndc: null, active: true }];
      vi.mocked(getSupabaseServerClient).mockReturnValue(
        fakeSupabase([], catalog, "missing-table", [], 50) as never
      );
      vi.mocked(getAcuityCredentials).mockResolvedValue({ userId: "u", apiKey: "k", source: "env" });
      vi.mocked(fetchAppointmentTypes).mockResolvedValue([]);
      const appointment = (date: string) => ({
        date,
        appointmentTypeId: 1,
        hourOfDay: 10,
        vaccineNames: ["Flu Quad 2025-26"],
        testNames: [],
        covidBrand: "any" as const,
        covidAgeBucket: "unknown" as const,
        fluAgeBucket: "unknown" as const,
        createdDate: "2026-08-10",
      });
      vi.mocked(fetchAppointmentsForRange).mockResolvedValue({
        appointments: [
          appointment("2026-08-19"),
          appointment("2026-08-19"),
          appointment("2026-08-20"),
          appointment("2026-08-20"),
        ],
        possiblyTruncated: false,
      });

      const response = await GET(authedRequest());
      const body = await response.json();
      expect(body.walkInPct).toBe(50);
      expect(body.walkInPctPending).toBe(false);
      // upcoming7d=4: at the 25% default, buffer=ceil(4*0.25)=1 ->
      // recommendedTarget=5; at the saved 50%, buffer=ceil(4*0.5)=2 ->
      // recommendedTarget=6 — this IS the divergence proving the route
      // is actually using the saved pct, not silently keeping 25%.
      const fluRow = body.rows.find((r: { key: string }) => r.key === "vaccine:v-flu");
      expect(fluRow.upcoming7d).toBe(4);
      expect(fluRow.recommendedTarget).toBe(6);
      expect(fluRow.order).toBe(6);
    });

    it("returns 500 for a non-missing-table walk-in-pct Supabase error (never silently swallowed)", async () => {
      vi.mocked(getSupabaseServerClient).mockReturnValue(
        fakeSupabase([], CATALOG, "missing-table", [], "error") as never
      );

      const response = await GET(authedRequest());
      expect(response.status).toBe(500);
    });
  });

  describe("COVID/Flu/Other regrouping (item 5) and the Pfizer child-row exclusion (item 8)", () => {
    it("collapses fine-grained groups to COVID/Flu/Other only", async () => {
      const catalog = [
        { id: "v-comirnaty", name: "Comirnaty 2025-26 12+", short_code: "comirnaty12", ndc: null, active: true },
        { id: "v-flu", name: "Fluzone PFS", short_code: "fluzonepfs", ndc: null, active: true },
        { id: "v-hpv", name: "Gardasil", short_code: "gardasil1", ndc: null, active: true },
        { id: "v-shingles", name: "Shingrix", short_code: "shingrix1", ndc: null, active: true },
      ];
      vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase([], catalog) as never);

      const response = await GET(authedRequest());
      const body = await response.json();

      const byName = new Map(body.rows.map((r: { vaccineName: string; group: string }) => [r.vaccineName, r.group]));
      expect(byName.get("Comirnaty 2025-26 12+")).toBe("COVID");
      expect(byName.get("Fluzone PFS")).toBe("Flu");
      expect(byName.get("Gardasil")).toBe("Other"); // fine-grained "HPV" collapses to Other
      expect(byName.get("Shingrix")).toBe("Other"); // fine-grained "Shingles" collapses to Other

      // Every row's group is one of exactly the three buckets — no
      // fine-grained name (HPV, Shingles, Pneumonia, ...) leaks through.
      for (const row of body.rows) {
        expect(["COVID", "Flu", "Other"]).toContain(row.group);
      }
    });

    it("excludes 'Pfizer 3-4' and 'Pfizer 5-11' catalog rows entirely, active or inactive", async () => {
      const catalog = [
        { id: "v-flu", name: "Flu Quad 2025-26", short_code: "fluquad", ndc: null, active: true },
        { id: "v-pfizer34", name: "Pfizer 3-4", short_code: "pfizer34", ndc: null, active: true },
        { id: "v-pfizer511", name: "Pfizer 5-11", short_code: "pfizer511", ndc: null, active: true },
        { id: "v-pfizer34-inactive", name: "Pfizer 3-4 (old)", short_code: "pfizer34old", ndc: null, active: false },
      ];
      vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase([], catalog) as never);

      const response = await GET(authedRequest());
      const body = await response.json();

      const names = body.rows.map((r: { vaccineName: string }) => r.vaccineName);
      expect(names).not.toContain("Pfizer 3-4");
      expect(names).not.toContain("Pfizer 5-11");
      expect(names).not.toContain("Pfizer 3-4 (old)");
      expect(names).toContain("Flu Quad 2025-26");
    });

    it("the 'Other' group can never appear more than once worth of rows (regression guard for the double-render bug)", async () => {
      // The bug lived in the OLD page.tsx's own group-display-order
      // array ([...GROUP_DISPLAY_ORDER, OTHER_GROUP] double-counting
      // OTHER_GROUP), not in this route — but this test locks down the
      // route's `group` field shape (exactly one of COVID/Flu/Other per
      // row, never a duplicate group STRING variant) so a future regression
      // in getOrderingGroup can't reintroduce a similar bug here.
      const catalog = [
        { id: "v-pfizer34", name: "Pfizer 3-4", short_code: "pfizer34", ndc: null, active: true },
        { id: "v-pfizer511", name: "Pfizer 5-11", short_code: "pfizer511", ndc: null, active: true },
      ];
      vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase([], catalog) as never);

      const response = await GET(authedRequest());
      const body = await response.json();
      // Both Pfizer child rows are excluded (item 8), so no rows at all
      // remain — and therefore no "Other" group section either.
      expect(body.rows).toHaveLength(0);
    });
  });

  // --- V-T-flu-map additions (Will 2026-09-09) -----------------------

  describe("flu age-band product mapping", () => {
    const fluCatalog = [
      { id: "v-flucelvax-pfs", name: "Flucelvax PFS", short_code: "flucelvaxpfs", ndc: null, active: true },
      { id: "v-fluad", name: "Fluad", short_code: "fluad", ndc: "70461-0123-03", active: true },
    ];

    function fluAppointment(fluAgeBucket: "3-64" | "65+" | "unknown") {
      return {
        date: "2026-08-19",
        appointmentTypeId: 1,
        hourOfDay: 10,
        vaccineNames: ["Flu Shot"],
        testNames: [],
        covidBrand: "any" as const,
        covidAgeBucket: "unknown" as const,
        fluAgeBucket,
        createdDate: "2026-08-10",
      };
    }

    it("routes a 3-64 flu appointment's upcoming7d onto the active Flucelvax PFS product", async () => {
      vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase([], fluCatalog) as never);
      vi.mocked(getAcuityCredentials).mockResolvedValue({ userId: "u", apiKey: "k", source: "env" });
      vi.mocked(fetchAppointmentTypes).mockResolvedValue([]);
      vi.mocked(fetchAppointmentsForRange).mockResolvedValue({
        appointments: [fluAppointment("3-64"), fluAppointment("3-64")],
        possiblyTruncated: false,
      });

      const response = await GET(authedRequest());
      const body = await response.json();

      const flucelvaxRow = body.rows.find((r: { key: string }) => r.key === "vaccine:v-flucelvax-pfs");
      expect(flucelvaxRow.upcoming7d).toBe(2);
      const fluadRow = body.rows.find((r: { key: string }) => r.key === "70461012303");
      expect(fluadRow.upcoming7d).toBe(0);
    });

    it("routes a 65+ flu appointment's upcoming7d onto Fluad", async () => {
      vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase([], fluCatalog) as never);
      vi.mocked(getAcuityCredentials).mockResolvedValue({ userId: "u", apiKey: "k", source: "env" });
      vi.mocked(fetchAppointmentTypes).mockResolvedValue([]);
      vi.mocked(fetchAppointmentsForRange).mockResolvedValue({
        appointments: [fluAppointment("65+"), fluAppointment("65+"), fluAppointment("65+")],
        possiblyTruncated: false,
      });

      const response = await GET(authedRequest());
      const body = await response.json();

      const fluadRow = body.rows.find((r: { key: string }) => r.key === "70461012303");
      expect(fluadRow.upcoming7d).toBe(3);
      const flucelvaxRow = body.rows.find((r: { key: string }) => r.key === "vaccine:v-flucelvax-pfs");
      expect(flucelvaxRow.upcoming7d).toBe(0);
    });

    it("falls back to any active non-Fluad flu product for a 3-64 count when Flucelvax PFS is inactive", async () => {
      const catalog = [
        { id: "v-flucelvax-pfs", name: "Flucelvax PFS", short_code: "flucelvaxpfs", ndc: null, active: false },
        { id: "v-flucelvax-mdv", name: "Flucelvax MDV", short_code: "flucelvaxmdv", ndc: "70461-0323-03", active: true },
        { id: "v-fluad", name: "Fluad", short_code: "fluad", ndc: "70461-0123-03", active: true },
      ];
      vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase([], catalog) as never);
      vi.mocked(getAcuityCredentials).mockResolvedValue({ userId: "u", apiKey: "k", source: "env" });
      vi.mocked(fetchAppointmentTypes).mockResolvedValue([]);
      vi.mocked(fetchAppointmentsForRange).mockResolvedValue({
        appointments: [fluAppointment("3-64")],
        possiblyTruncated: false,
      });

      const response = await GET(authedRequest());
      const body = await response.json();

      const mdvRow = body.rows.find((r: { key: string }) => r.key === "70461032303");
      expect(mdvRow.upcoming7d).toBe(1);
    });

    it("an 'unknown'-band flu appointment still falls through to the generic matcher unchanged", async () => {
      const catalog = [{ id: "v-flu", name: "Flu Quad 2025-26", short_code: "fluquad", ndc: null, active: true }];
      vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase([], catalog) as never);
      vi.mocked(getAcuityCredentials).mockResolvedValue({ userId: "u", apiKey: "k", source: "env" });
      vi.mocked(fetchAppointmentTypes).mockResolvedValue([]);
      vi.mocked(fetchAppointmentsForRange).mockResolvedValue({
        appointments: [fluAppointment("unknown")],
        possiblyTruncated: false,
      });

      const response = await GET(authedRequest());
      const body = await response.json();

      const fluRow = body.rows.find((r: { key: string }) => r.key === "vaccine:v-flu");
      expect(fluRow.upcoming7d).toBe(1);
    });
  });

  // --- V-onhand-batch-sum additions (Will 2026-09-09 4:31pm) ----------

  describe("on-hand: sums a TIME-WINDOWED batch (120s, same source), replaces an older/different-source batch", () => {
    it("sums two lines for one product whose received_at are only milliseconds apart (real Pioneer insert timing)", async () => {
      const catalog = [{ id: "v-abrysvo", name: "Abrysvo", short_code: "abrysvo", ndc: null, active: true }];
      const onHandRows = [
        { vaccine_id: "v-abrysvo", quantity: 0, received_at: "2026-09-09T21:31:05.413Z", source: "email" },
        { vaccine_id: "v-abrysvo", quantity: 0, received_at: "2026-09-09T21:31:05.430Z", source: "email" },
        { vaccine_id: "v-abrysvo", quantity: 9, received_at: "2026-09-09T21:31:05.457Z", source: "email" },
      ];
      vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase(onHandRows, catalog) as never);

      const response = await GET(authedRequest());
      const body = await response.json();

      const row = body.rows.find((r: { key: string }) => r.key === "vaccine:v-abrysvo");
      expect(row.onHand).toBe(9);
    });

    it("a batch 4.5 hours later REPLACES an older same-day batch — only the newer batch is summed", async () => {
      const catalog = [{ id: "v-mnexspike", name: "mNEXSPIKE", short_code: "mnexspike", ndc: null, active: true }];
      const onHandRows = [
        // 16:31 batch (newest first, matching real received_at DESC
        // query order) — the one that should win.
        { vaccine_id: "v-mnexspike", quantity: 1114, received_at: "2026-09-09T16:31:05.457Z", source: "email" },
        { vaccine_id: "v-mnexspike", quantity: 0, received_at: "2026-09-09T16:31:05.413Z", source: "email" },
        // 12:00 batch — outside the 120s window around 16:31, must be excluded.
        { vaccine_id: "v-mnexspike", quantity: 500, received_at: "2026-09-09T12:00:00.000Z", source: "email" },
      ];
      vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase(onHandRows, catalog) as never);

      const response = await GET(authedRequest());
      const body = await response.json();

      const row = body.rows.find((r: { key: string }) => r.key === "vaccine:v-mnexspike");
      expect(row.onHand).toBe(1114);
    });

    it("an upload batch at 16:20 and an email batch at 16:31 — the email (newer) batch wins, upload isn't summed in", async () => {
      const catalog = [{ id: "v-spikevax", name: "Spikevax", short_code: "spikevax", ndc: null, active: true }];
      const onHandRows = [
        { vaccine_id: "v-spikevax", quantity: 0, received_at: "2026-09-09T16:31:05.457Z", source: "email" },
        { vaccine_id: "v-spikevax", quantity: 0, received_at: "2026-09-09T16:31:05.430Z", source: "email" },
        { vaccine_id: "v-spikevax", quantity: 11, received_at: "2026-09-09T16:31:05.413Z", source: "email" },
        { vaccine_id: "v-spikevax", quantity: 200, received_at: "2026-09-09T16:20:00.000Z", source: "upload" },
      ];
      vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase(onHandRows, catalog) as never);

      const response = await GET(authedRequest());
      const body = await response.json();

      const row = body.rows.find((r: { key: string }) => r.key === "vaccine:v-spikevax");
      expect(row.onHand).toBe(11);
    });

    it("a product present only in an OLDER global batch still shows its own latest-batch value (not 0/dropped)", async () => {
      const catalog = [
        { id: "v-mnexspike", name: "mNEXSPIKE", short_code: "mnexspike", ndc: null, active: true },
        { id: "v-prevnar", name: "Prevnar 20", short_code: "prevnar20", ndc: null, active: true },
      ];
      const onHandRows = [
        // The "global latest" batch (16:31) only reports mNEXSPIKE.
        { vaccine_id: "v-mnexspike", quantity: 1114, received_at: "2026-09-09T16:31:05.413Z", source: "email" },
        // Prevnar's own latest batch was earlier (12:00) — still its own
        // most-recent value, computed independently per product key.
        { vaccine_id: "v-prevnar", quantity: 8, received_at: "2026-09-09T12:00:00.050Z", source: "email" },
        { vaccine_id: "v-prevnar", quantity: 0, received_at: "2026-09-09T12:00:00.000Z", source: "email" },
      ];
      vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase(onHandRows, catalog) as never);

      const response = await GET(authedRequest());
      const body = await response.json();

      const prevnarRow = body.rows.find((r: { key: string }) => r.key === "vaccine:v-prevnar");
      expect(prevnarRow.onHand).toBe(8);
      const mnexspikeRow = body.rows.find((r: { key: string }) => r.key === "vaccine:v-mnexspike");
      expect(mnexspikeRow.onHand).toBe(1114);
    });
  });

  // --- V-onhand-attribution additions (live bug after d7e123f) --------
  describe("on-hand attribution: a MATCHED row's vaccine_id wins over its own (possibly foreign) ndc", () => {
    it("an email row with vaccine_id set and an ndc that DIFFERS from the product's DB ndc still lands on the product", async () => {
      const catalog = [{ id: "v-fluad", name: "Fluad", short_code: "fluad", ndc: "70461-0123-03", active: true }];
      const onHandRows = [
        // Pioneer's PACKAGE ndc (70461-0026-03), not the DB's own ndc
        // (70461-0123-03) — matched to v-fluad by vaccine_id regardless.
        {
          vaccine_id: "v-fluad",
          ndc: "70461002603",
          quantity: 189,
          received_at: "2026-09-09T21:31:05.413Z",
          source: "email",
        },
      ];
      vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase(onHandRows, catalog) as never);

      const response = await GET(authedRequest());
      const body = await response.json();

      const row = body.rows.find((r: { key: string }) => r.key === "70461012303");
      expect(row.onHand).toBe(189);
    });

    it("the real Fluad regression: a STALE upload batch (ndc happens to match the DB ndc) at T0 is REPLACED by a FRESHER email batch (foreign package ndc) at T1 — 189, not 115", async () => {
      const catalog = [{ id: "v-fluad", name: "Fluad", short_code: "fluad", ndc: "70461-0123-03", active: true }];
      const onHandRows = [
        // T1 (4:31pm) email batch, matched by vaccine_id — ndc is
        // Pioneer's foreign package ndc, never equal to the DB ndc.
        // 0/189/0 across three Pioneer lines, summed to 189.
        {
          vaccine_id: "v-fluad",
          ndc: "70461002603",
          quantity: 0,
          received_at: "2026-09-09T16:31:05.413Z",
          source: "email",
        },
        {
          vaccine_id: "v-fluad",
          ndc: "70461002603",
          quantity: 189,
          received_at: "2026-09-09T16:31:05.430Z",
          source: "email",
        },
        {
          vaccine_id: "v-fluad",
          ndc: "70461002603",
          quantity: 0,
          received_at: "2026-09-09T16:31:05.457Z",
          source: "email",
        },
        // T0 (04:52Z) STALE xlsx upload — its ndc happens to equal the
        // DB ndc, which is exactly what let it win under the OLD
        // (ndc-first) attribution logic despite being older.
        {
          vaccine_id: "v-fluad",
          ndc: "70461012303",
          quantity: 115,
          received_at: "2026-09-09T04:52:00.000Z",
          source: "upload",
        },
      ];
      vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase(onHandRows, catalog) as never);

      const response = await GET(authedRequest());
      const body = await response.json();

      const row = body.rows.find((r: { key: string }) => r.key === "70461012303");
      expect(row.onHand).toBe(189);
    });

    it("an UNMATCHED row (vaccine_id null) still falls back to matching by ndc against the product's DB ndc", async () => {
      const catalog = [{ id: "v-fluad", name: "Fluad", short_code: "fluad", ndc: "70461-0123-03", active: true }];
      const onHandRows = [
        { vaccine_id: null, ndc: "70461012303", quantity: 42, received_at: "2026-09-09T21:31:05.413Z", source: "email" },
      ];
      vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase(onHandRows, catalog) as never);

      const response = await GET(authedRequest());
      const body = await response.json();

      const row = body.rows.find((r: { key: string }) => r.key === "70461012303");
      expect(row.onHand).toBe(42);
    });

    it("an UNMATCHED row whose ndc matches no product's DB ndc is not attributed anywhere (never falls back to vaccine_id — it has none)", async () => {
      const catalog = [{ id: "v-fluad", name: "Fluad", short_code: "fluad", ndc: "70461-0123-03", active: true }];
      const onHandRows = [
        { vaccine_id: null, ndc: "99999999999", quantity: 42, received_at: "2026-09-09T21:31:05.413Z", source: "email" },
      ];
      vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase(onHandRows, catalog) as never);

      const response = await GET(authedRequest());
      const body = await response.json();

      const row = body.rows.find((r: { key: string }) => r.key === "70461012303");
      expect(row.onHand).toBeNull();
    });
  });

  describe("group targets are ignored in the effective-target computation (item 6)", () => {
    it("a stale scope='group' override in ordering_target no longer apportions across the group's rows", async () => {
      const catalog = [
        { id: "v-flu1", name: "Flu Quad 2025-26", short_code: "fluquad", ndc: "11111111111", active: true },
        { id: "v-flu2", name: "Fluad", short_code: "fluad", ndc: "22222222222", active: true },
      ];
      // A group-scoped override for "Flu" — this table row is left on
      // file (Will's brief: "don't delete them") but must have NO effect
      // on any row's effectiveTarget/order below.
      const targetRows: FakeTargetRow[] = [{ scope: "group", key: "Flu", target_on_hand: 500 }];
      vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase([], catalog, "missing-table", targetRows) as never);

      const response = await GET(authedRequest());
      const body = await response.json();

      // groupTargets still reflects the DB row (API/lib left intact)...
      expect(body.groupTargets).toEqual({ Flu: 500 });
      // ...but neither Flu row's targetSource is "group", and neither
      // row's effectiveTarget/order was apportioned from the 500 total —
      // both fall back to their own plain recommendedTarget (0 upcoming
      // -> recommendedTarget 0, not some slice of 500).
      for (const row of body.rows) {
        expect(row.targetSource).toBe("recommended");
        expect(row.effectiveTarget).toBe(0);
        expect(row.order).toBe(0);
      }
    });
  });
});
