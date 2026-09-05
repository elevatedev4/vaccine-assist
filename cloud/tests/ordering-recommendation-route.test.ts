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

function fakeSupabase(onHandRows: unknown[] = []) {
  return {
    from: (table: string) => {
      if (table === "vaccine") {
        return {
          select: () => ({
            eq: () => ({
              order: async () => ({ data: CATALOG, error: null }),
            }),
          }),
        };
      }
      if (table === "on_hand_count") {
        return {
          select: () => ({
            eq: () => ({
              order: async () => ({ data: onHandRows, error: null }),
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
          vaccineNames: ["Flu Quad 2025-26"],
          covidBrand: "any",
          covidAgeBucket: "unknown",
        },
        {
          date: "2026-08-20",
          appointmentTypeId: 1,
          vaccineNames: ["Flu Quad 2025-26"],
          covidBrand: "any",
          covidAgeBucket: "unknown",
        },
        {
          date: "2026-08-20",
          appointmentTypeId: 1,
          vaccineNames: ["Some Unmatched Vaccine"],
          covidBrand: "any",
          covidAgeBucket: "unknown",
        },
      ],
      possiblyTruncated: false,
    });

    const response = await GET(authedRequest());
    expect(response.status).toBe(200);
    const body = await response.json();

    const fluRow = body.rows.find((r: { vaccineId: string }) => r.vaccineId === "v-flu");
    expect(fluRow.upcoming7d).toBe(2);
    // recommendedOrder for upcoming7d=2: buffer = max(1, ceil(2*0.25)) = 1 -> 2+1-0 = 3
    expect(fluRow.recommendedOrder).toBe(3);

    const mmrRow = body.rows.find((r: { vaccineId: string }) => r.vaccineId === "v-mmr");
    expect(mmrRow.upcoming7d).toBe(0);
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
