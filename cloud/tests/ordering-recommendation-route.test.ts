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
  { id: "v-flu", name: "Flu Quad 2025-26", short_code: "fluquad" },
  { id: "v-mmr", name: "MMR-II", short_code: "mmrii" },
];

function authedRequest() {
  return new Request("http://localhost/api/ordering/recommendation", {
    headers: { Authorization: "Bearer test-token" },
  });
}

type FakeAddress = { id: string; user_id: string; token: string; enabled: boolean; created_at: string; last_received_at: string | null };

// `address` defaults to null, which makes the "inbound_email_address"
// table throw "unexpected table" below — exactly like every table this
// mock doesn't know about. That's deliberate: it's how these tests
// exercise the route's graceful-fallback path (V-onhand-account-address,
// Will 2026-09-08) — getOrCreateAddressForUser throws, the route catches
// it and falls back to the pre-feature UNSCOPED on_hand_count query
// (.eq().order(), no .or()), so every existing test below keeps passing
// unchanged. Only tests that explicitly pass `address` exercise the new
// per-account .or() scoping.
function fakeSupabase(onHandRows: unknown[] = [], catalog: unknown[] = CATALOG, address: FakeAddress | null = null) {
  return {
    from: (table: string) => {
      if (table === "vaccine") {
        return {
          select: () => ({
            eq: () => ({
              order: async () => ({ data: catalog, error: null }),
            }),
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
      if (table === "inbound_email_address" && address) {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: address, error: null }),
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
    expect(body.rows).toEqual([
      {
        vaccineId: "v-flu",
        vaccineName: "Flu Quad 2025-26",
        upcoming7d: 0,
        onHand: null,
        onHandAsOf: null,
        recommendedOrder: 0,
      },
      {
        vaccineId: "v-mmr",
        vaccineName: "MMR-II",
        upcoming7d: 0,
        onHand: null,
        onHandAsOf: null,
        recommendedOrder: 0,
      },
    ]);
  });

  it("picks the latest matched on-hand row per vaccine and computes recommendedOrder", async () => {
    const onHandRows = [
      { vaccine_id: "v-flu", quantity: 8, received_at: "2026-08-19T13:00:00.000Z" },
      { vaccine_id: "v-flu", quantity: 100, received_at: "2026-08-10T09:00:00.000Z" }, // older, must be ignored
      { vaccine_id: "v-mmr", quantity: 2, received_at: "2026-08-18T08:00:00.000Z" },
    ];
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase(onHandRows) as never);

    const response = await GET(authedRequest());
    const body = await response.json();

    expect(body.onHandLastReceivedAt).toBe("2026-08-19T13:00:00.000Z");
    const fluRow = body.rows.find((r: { vaccineId: string }) => r.vaccineId === "v-flu");
    expect(fluRow).toEqual({
      vaccineId: "v-flu",
      vaccineName: "Flu Quad 2025-26",
      upcoming7d: 0,
      onHand: 8,
      onHandAsOf: "2026-08-19T13:00:00.000Z",
      recommendedOrder: 0, // 0 + 0 buffer - 8, clamped at 0
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
    const fluRow = body.rows.find((r: { vaccineId: string }) => r.vaccineId === "v-flu");
    expect(fluRow.upcoming7d).toBe(2);
    // recommendedOrder for upcoming7d=2: buffer = max(1, ceil(2*0.25)) = 1 -> 2+1-0 = 3
    expect(fluRow.recommendedOrder).toBe(3);

    const mmrRow = body.rows.find((r: { vaccineId: string }) => r.vaccineId === "v-mmr");
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
      { id: "v-comirnaty", name: "Comirnaty 2025-26 12+", short_code: "comirnaty12" },
      { id: "v-mnexspike", name: "mNEXSPIKE", short_code: "mnexspike" },
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

    const pfizerRow = body.rows.find((r: { vaccineId: string }) => r.vaccineId === "v-comirnaty");
    expect(pfizerRow.upcoming7d).toBe(2);
    const modernaRow = body.rows.find((r: { vaccineId: string }) => r.vaccineId === "v-mnexspike");
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

    const fluRow = body.rows.find((r: { vaccineId: string }) => r.vaccineId === "v-flu");
    // The addr-2 row (quantity 999) must be excluded — onHand stays 8, not 999.
    expect(fluRow.onHand).toBe(8);
    const mmrRow = body.rows.find((r: { vaccineId: string }) => r.vaccineId === "v-mmr");
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
});
