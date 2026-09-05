import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// tests/acuity-poll-route.test.ts covers the real auth gate (401 with no
// Authorization header). This file mocks requireAuthenticatedUser to
// always succeed so the route's OWN validation logic (date format,
// start>end, the 31-day range cap, and the unconfigured-credentials JSON
// shape) can be exercised directly — those all run after the auth check,
// and there's no Supabase available in this test environment to make a
// real auth call succeed (see tests/acuity-credentials.test.ts).
vi.mock("@/lib/auth", () => ({
  requireAuthenticatedUser: vi.fn(async () => ({ user: { id: "staff-1", email: "staff@example.com" } })),
}));

import { GET } from "@/app/api/acuity/poll/route";

const ACUITY_ENV_KEYS = ["ACUITY_USER_ID", "ACUITY_API_KEY"] as const;

function pollRequest(query: string) {
  return new Request(`http://localhost/api/acuity/poll${query}`, {
    headers: { Authorization: "Bearer test-token" },
  });
}

describe("GET /api/acuity/poll — validation", () => {
  beforeEach(() => {
    for (const key of ACUITY_ENV_KEYS) delete process.env[key];
  });

  it("rejects a malformed date", async () => {
    const response = await GET(pollRequest("?start=not-a-date&end=2026-08-24"));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/YYYY-MM-DD/);
  });

  it("rejects start after end", async () => {
    const response = await GET(pollRequest("?start=2026-08-24&end=2026-08-17"));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/start must not be after end/i);
  });

  it("rejects a range spanning more than 31 days", async () => {
    const response = await GET(pollRequest("?start=2026-01-01&end=2026-12-31"));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/31 days/i);
  });

  it("rejects a wide-open unbounded range (e.g. year 0000 to year 2999)", async () => {
    const response = await GET(pollRequest("?start=0000-01-01&end=2999-12-31"));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/31 days/i);
  });

  it("accepts a range exactly at the 31-day cap", async () => {
    // 2026-08-01..2026-08-31 inclusive = 31 days.
    const response = await GET(pollRequest("?start=2026-08-01&end=2026-08-31"));
    expect(response.status).toBe(200);
  });

  it("returns the unconfigured-credentials JSON shape when no Acuity credentials exist", async () => {
    const response = await GET(pollRequest("?start=2026-08-17&end=2026-08-18"));
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toEqual({
      configured: false,
      message: expect.stringMatching(/not configured/i),
      settingsUrl: "/settings",
      range: { start: "2026-08-17", end: "2026-08-18" },
      counts: [],
      possiblyTruncated: false,
      cacheHit: false,
      asOf: null,
    });
    // No `table` field yet — nothing to pivot without credentials, same
    // as the empty `counts` array (see route.ts's RESPONSE CONTRACT doc).
    expect(body.table).toBeUndefined();
  });

  // Task 2 (V-scheduling-tab): the desktop app's Scheduling tab reads
  // `table` off this same route instead of hitting Acuity directly.
  describe("table field (Task 2 — desktop Scheduling tab contract)", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      for (const key of ACUITY_ENV_KEYS) delete process.env[key];
    });

    function acuityAppointmentFixture(overrides: Record<string, unknown> = {}) {
      return {
        id: 1,
        datetime: "2026-08-17T10:00:00-0500",
        appointmentTypeID: 111,
        forms: [{ id: 1, name: "Intake", values: [{ fieldID: 9, name: "Vaccine", value: "Flu" }] }],
        ...overrides,
      };
    }

    it("includes a days x vaccine-name pivoted table alongside counts when configured", async () => {
      process.env.ACUITY_USER_ID = "12345";
      process.env.ACUITY_API_KEY = "test-key";

      const fetchMock = vi.fn(async (url: string | URL) => {
        const urlStr = url.toString();
        if (urlStr.includes("appointment-types")) {
          return new Response(JSON.stringify([{ id: 111, name: "Vaccine Appointment" }]), { status: 200 });
        }
        return new Response(JSON.stringify([acuityAppointmentFixture()]), { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);

      const response = await GET(pollRequest("?start=2026-08-17&end=2026-08-18"));
      expect(response.status).toBe(200);
      const body = await response.json();

      expect(body.configured).toBe(true);
      // "Flu" has no age-question form field in this fixture, so
      // aggregateAppointmentCounts rewrites it to the "Flu · Unknown"
      // composite (V-T-schedule-table ROUND 2) — same trick as COVID's
      // brand/age composite, riding the (here, unknown) age bucket
      // through the cache/API shape unchanged.
      expect(body.counts).toEqual([{ date: "2026-08-17", vaccineName: "Flu · Unknown", count: 1 }]);
      // `table` now always renders the full fixed 21-column set
      // (V-T-schedule-table ROUND 2) — the composite above resolves onto
      // the fixed "flu_unknown" column rather than creating a new one.
      expect(body.table.days).toEqual(["2026-08-17", "2026-08-18"]);
      expect(body.table.columns).toHaveLength(21);
      expect(body.table.rows).toHaveLength(21);
      const fluRow = body.table.rows.find((r: { vaccineName: string }) => r.vaccineName === "flu_unknown");
      expect(fluRow).toEqual({
        vaccineName: "flu_unknown",
        countsByDay: { "2026-08-17": 1, "2026-08-18": 0 },
        total: 1,
      });
      const fluColumn = body.table.columns.find((c: { vaccineName: string }) => c.vaccineName === "flu_unknown");
      expect(fluColumn).toEqual({ vaccineName: "flu_unknown", group: "Flu", subgroup: null, label: "Unk" });
      expect(body.table.dailyTotals).toEqual({ "2026-08-17": 1, "2026-08-18": 0 });
      expect(body.table.grandTotal).toBe(1);
    });
  });
});
