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

// Mocked (ROUND 4) so the "?afterToday=1" tests below can force the cache
// -hit branch on demand — default behavior (always a miss) matches the
// real fail-soft module's behavior with no Supabase configured in this
// test environment (see tests/acuity-poll-cache.test.ts), so every
// PRE-EXISTING test in this file that doesn't override these mocks still
// exercises the same cache-miss path it always has.
vi.mock("@/lib/acuity-poll-cache", () => ({
  getCachedCounts: vi.fn(async () => null),
  setCachedCounts: vi.fn(async () => undefined),
}));

import { GET } from "@/app/api/acuity/poll/route";
import { getCachedCounts } from "@/lib/acuity-poll-cache";
import { todayInChicago } from "@/lib/chicago-date";

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

  afterEach(() => {
    vi.mocked(getCachedCounts).mockReset();
    vi.mocked(getCachedCounts).mockResolvedValue(null);
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
      // `table` now always renders the full fixed 19-column set
      // (V-T-schedule-table ROUND 2, regrouped to 19 columns in ROUND 4's
      // Any->Pfizer merge — see FIXED_COLUMN_IDS in
      // tests/appointment-table.test.ts) — the composite above resolves
      // onto the fixed "flu_unknown" column rather than creating a new one.
      expect(body.table.days).toEqual(["2026-08-17", "2026-08-18"]);
      expect(body.table.columns).toHaveLength(19);
      expect(body.table.rows).toHaveLength(19);
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
      // ROUND 4: opt-in only — this request never passed ?afterToday=1,
      // so the (much heavier, 13-window) extended fetch never ran and
      // this field is simply absent, exactly like before this round.
      expect(body.afterToday).toBeUndefined();
      expect(body.afterTodayError).toBeUndefined();
    });
  });

  // ROUND 4 (V-T9 answer): "add a 'total vaccines remaining after today'
  // row that sums up all the future appointments too" — app/appointments
  // /page.tsx is the one caller that passes ?afterToday=1 (see that
  // route's doc comment for why this is opt-in).
  describe("afterToday field (ROUND 4 — ?afterToday=1)", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      for (const key of ACUITY_ENV_KEYS) delete process.env[key];
    });

    function acuityAppointmentFixture(overrides: Record<string, unknown> = {}) {
      return {
        id: 1,
        appointmentTypeID: 111,
        forms: [{ id: 1, name: "Intake", values: [{ fieldID: 9, name: "Vaccine", value: "Flu" }] }],
        ...overrides,
      };
    }

    it("is absent when ?afterToday=1 is not passed, even with credentials configured", async () => {
      process.env.ACUITY_USER_ID = "12345";
      process.env.ACUITY_API_KEY = "test-key";
      const fetchMock = vi.fn(async (url: string | URL) => {
        if (url.toString().includes("appointment-types")) {
          return new Response(JSON.stringify([{ id: 111, name: "Vaccine Appointment" }]), { status: 200 });
        }
        return new Response(JSON.stringify([]), { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);

      const response = await GET(pollRequest("?start=2026-08-17&end=2026-08-18"));
      const body = await response.json();

      expect(body.afterToday).toBeUndefined();
      // Only the main range's fetch happened — no 13-window extended
      // fetch was triggered.
      expect(fetchMock.mock.calls.filter((call) => !call[0].toString().includes("appointment-types"))).toHaveLength(
        1
      );
    });

    it("computes afterToday alongside the main table when ?afterToday=1 is passed (fresh, cache-miss path)", async () => {
      process.env.ACUITY_USER_ID = "12345";
      process.env.ACUITY_API_KEY = "test-key";
      const today = todayInChicago();

      const fetchMock = vi.fn(async (url: string | URL) => {
        const urlStr = url.toString();
        if (urlStr.includes("appointment-types")) {
          return new Response(JSON.stringify([{ id: 111, name: "Vaccine Appointment" }]), { status: 200 });
        }
        const minDate = new URL(urlStr).searchParams.get("minDate");
        if (minDate === today) {
          // The main today..+7 range request.
          return new Response(
            JSON.stringify([acuityAppointmentFixture({ datetime: `${today}T10:00:00-0500` })]),
            { status: 200 }
          );
        }
        // Every one of the 13 further-out windows contributes exactly 1
        // Flu (unknown-age) appointment.
        return new Response(
          JSON.stringify([acuityAppointmentFixture({ id: 2, datetime: `${minDate}T10:00:00-0500` })]),
          { status: 200 }
        );
      });
      vi.stubGlobal("fetch", fetchMock);

      const response = await GET(pollRequest(`?start=${today}&end=${today}&afterToday=1`));
      expect(response.status).toBe(200);
      const body = await response.json();

      expect(body.configured).toBe(true);
      // Main table is unaffected by the extended fetch running alongside it.
      expect(body.table.dailyTotals[today]).toBe(1);
      expect(body.afterTodayError).toBeUndefined();
      expect(body.afterToday.total).toBe(13); // 1 per window x 13 windows
      expect(body.afterToday.byColumnId["flu_unknown"]).toBe(13);
      expect(body.afterToday.truncatedWindows).toEqual([]);
    });

    it("degrades to afterToday: null with afterTodayError, WITHOUT failing the whole response, when the extended fetch errors", async () => {
      process.env.ACUITY_USER_ID = "12345";
      process.env.ACUITY_API_KEY = "test-key";
      const today = todayInChicago();

      const fetchMock = vi.fn(async (url: string | URL) => {
        const urlStr = url.toString();
        if (urlStr.includes("appointment-types")) {
          return new Response(JSON.stringify([{ id: 111, name: "Vaccine Appointment" }]), { status: 200 });
        }
        const minDate = new URL(urlStr).searchParams.get("minDate");
        if (minDate === today) {
          return new Response(JSON.stringify([acuityAppointmentFixture({ datetime: `${today}T10:00:00-0500` })]), {
            status: 200,
          });
        }
        // Every further-out window fails.
        return new Response("", { status: 500 });
      });
      vi.stubGlobal("fetch", fetchMock);

      const response = await GET(pollRequest(`?start=${today}&end=${today}&afterToday=1`));
      expect(response.status).toBe(200);
      const body = await response.json();

      expect(body.configured).toBe(true);
      // Main table still came through fine.
      expect(body.table.dailyTotals[today]).toBe(1);
      expect(body.afterToday).toBeNull();
      expect(body.afterTodayError).toEqual(expect.stringMatching(/unexpected status/i));
    });

    it("still computes afterToday when the main range is served from cache (cacheHit: true)", async () => {
      process.env.ACUITY_USER_ID = "12345";
      process.env.ACUITY_API_KEY = "test-key";
      const today = todayInChicago();

      vi.mocked(getCachedCounts).mockImplementation(async (minDate) => {
        if (minDate === today) {
          return {
            counts: [{ date: today, vaccineName: "Flu · Unknown", count: 7 }],
            possiblyTruncated: false,
            computedAt: new Date().toISOString(),
          };
        }
        return null; // every extended window still misses and hits Acuity
      });

      const fetchMock = vi.fn(async (url: string | URL) => {
        const urlStr = url.toString();
        if (urlStr.includes("appointment-types")) {
          return new Response(JSON.stringify([{ id: 111, name: "Vaccine Appointment" }]), { status: 200 });
        }
        return new Response(JSON.stringify([]), { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);

      const response = await GET(pollRequest(`?start=${today}&end=${today}&afterToday=1`));
      const body = await response.json();

      expect(body.cacheHit).toBe(true);
      expect(body.table.dailyTotals[today]).toBe(7);
      // afterToday still computed (all-zero here since every window's
      // Acuity response was empty), NOT skipped just because the main
      // range came from cache.
      expect(body.afterToday).toEqual({ byColumnId: {}, total: 0, truncatedWindows: [] });
    });
  });
});
