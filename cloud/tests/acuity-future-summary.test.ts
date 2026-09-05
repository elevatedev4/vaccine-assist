import { afterEach, describe, expect, it, vi } from "vitest";

// Same mocking approach as tests/acuity-poll-route-validation.test.ts's
// "table field" describe block — this module also depends on
// lib/acuity-poll-cache.ts (Supabase-backed), which we control directly
// here rather than letting it fail-soft to "always a cache miss" (its
// real behavior with no Supabase configured — see
// tests/acuity-poll-cache.test.ts) so the "every window is a cache hit"
// test below can assert Acuity is never actually called.
vi.mock("@/lib/acuity-poll-cache", () => ({
  getCachedCounts: vi.fn(async () => null),
  setCachedCounts: vi.fn(async () => undefined),
}));

import {
  AFTER_TODAY_WINDOW_COUNT,
  AFTER_TODAY_WINDOW_DAYS,
  buildAfterTodayWindows,
  fetchAfterTodaySummary,
} from "@/lib/acuity-future-summary";
import { getCachedCounts, setCachedCounts } from "@/lib/acuity-poll-cache";

function acuityAppointmentFixture(
  datetime: string,
  vaccineName: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    id: 1,
    datetime,
    appointmentTypeID: 111,
    forms: [{ id: 1, name: "Intake", values: [{ fieldID: 9, name: "Vaccine", value: vaccineName }] }],
    ...overrides,
  };
}

function daySpan(start: string, end: string): number {
  const startMs = new Date(`${start}T00:00:00Z`).getTime();
  const endMs = new Date(`${end}T00:00:00Z`).getTime();
  return Math.round((endMs - startMs) / 86_400_000) + 1;
}

describe("buildAfterTodayWindows", () => {
  it("returns AFTER_TODAY_WINDOW_COUNT windows, each spanning AFTER_TODAY_WINDOW_DAYS calendar days", () => {
    const windows = buildAfterTodayWindows("2026-09-05");
    expect(windows).toHaveLength(AFTER_TODAY_WINDOW_COUNT);
    for (const { start, end } of windows) {
      expect(daySpan(start, end)).toBe(AFTER_TODAY_WINDOW_DAYS);
    }
  });

  it("excludes today itself — the first window starts the day AFTER today", () => {
    const windows = buildAfterTodayWindows("2026-09-05");
    expect(windows[0]).toEqual({ start: "2026-09-06", end: "2026-09-12" });
  });

  it("windows are contiguous and non-overlapping (each starts the day after the previous ends)", () => {
    const windows = buildAfterTodayWindows("2026-09-05");
    for (let i = 1; i < windows.length; i++) {
      const gapDays = daySpan(windows[i - 1].end, windows[i].start) - 1;
      expect(gapDays).toBe(1);
    }
  });

  it("the last window reaches at least +90 days out from today", () => {
    const windows = buildAfterTodayWindows("2026-09-05");
    const last = windows[windows.length - 1];
    // today (2026-09-05) + 90 days = 2026-12-04.
    expect(last.end >= "2026-12-04").toBe(true);
  });
});

describe("fetchAfterTodaySummary", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(getCachedCounts).mockReset();
    vi.mocked(getCachedCounts).mockResolvedValue(null);
    vi.mocked(setCachedCounts).mockReset();
    vi.mocked(setCachedCounts).mockResolvedValue(undefined);
  });

  it("aggregates counts across every window into one ColumnTotals, fetching appointment types only ONCE across all 13 windows", async () => {
    const typesCalls: string[] = [];
    const appointmentsCalls: string[] = [];

    const fetchMock = vi.fn(async (url: string | URL) => {
      const urlStr = url.toString();
      if (urlStr.includes("appointment-types")) {
        typesCalls.push(urlStr);
        return new Response(JSON.stringify([{ id: 111, name: "Vaccine Appointment" }]), { status: 200 });
      }
      appointmentsCalls.push(urlStr);
      const minDate = new URL(urlStr).searchParams.get("minDate");
      if (minDate === "2026-09-06") {
        return new Response(
          JSON.stringify([
            acuityAppointmentFixture("2026-09-06T10:00:00-0500", "RSV Vaccine", { id: 1 }),
            acuityAppointmentFixture("2026-09-07T10:00:00-0500", "RSV Vaccine", { id: 2 }),
          ]),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify([]), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const summary = await fetchAfterTodaySummary("user-1", "key-1", "2026-09-05", 300);

    expect(summary.byColumnId["rsv"]).toBe(2);
    expect(summary.total).toBe(2);
    expect(summary.truncatedWindows).toEqual([]);
    expect(typesCalls).toHaveLength(1);
    expect(appointmentsCalls).toHaveLength(AFTER_TODAY_WINDOW_COUNT);
    // Every cache-miss window is written back through setCachedCounts —
    // per-window cache reuse (the brief's "your call" steer), not a
    // separate "extended blob" cache.
    expect(vi.mocked(setCachedCounts)).toHaveBeenCalledTimes(AFTER_TODAY_WINDOW_COUNT);
  });

  it("never touches Acuity at all when every window is already cached", async () => {
    vi.mocked(getCachedCounts).mockResolvedValue({
      counts: [{ date: "2026-09-06", vaccineName: "RSV Vaccine", count: 5 }],
      possiblyTruncated: false,
      computedAt: new Date().toISOString(),
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const summary = await fetchAfterTodaySummary("user-1", "key-1", "2026-09-05", 300);

    expect(fetchMock).not.toHaveBeenCalled();
    // Every one of the 13 windows "hits" this same cached row in this
    // test, so they all sum together.
    expect(summary.byColumnId["rsv"]).toBe(5 * AFTER_TODAY_WINDOW_COUNT);
    expect(summary.total).toBe(5 * AFTER_TODAY_WINDOW_COUNT);
  });

  it("marks a window as truncated (and names its range) when it hits the 100-appointment cap", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const urlStr = url.toString();
      if (urlStr.includes("appointment-types")) {
        return new Response(JSON.stringify([{ id: 111, name: "Vaccine Appointment" }]), { status: 200 });
      }
      const minDate = new URL(urlStr).searchParams.get("minDate");
      if (minDate === "2026-09-06") {
        const hundred = Array.from({ length: 100 }, (_, i) =>
          acuityAppointmentFixture("2026-09-06T10:00:00-0500", "RSV Vaccine", { id: i })
        );
        return new Response(JSON.stringify(hundred), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const summary = await fetchAfterTodaySummary("user-1", "key-1", "2026-09-05", 300);

    expect(summary.truncatedWindows).toEqual(["2026-09-06..2026-09-12"]);
    expect(summary.byColumnId["rsv"]).toBe(100);
  });

  it("propagates an AcuityApiError from a window's fetch instead of swallowing it", async () => {
    // fetchAppointmentTypes (the lazy, once-only lookup) hits this same
    // 401 first — its own error message differs from
    // fetchAppointmentsForRange's ("unexpected status" vs. "rejected these
    // credentials"), but either way this must reject rather than resolve
    // with a partial/empty summary.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })));

    await expect(fetchAfterTodaySummary("user-1", "key-1", "2026-09-05", 300)).rejects.toThrow(
      /unexpected status \(401\)/i
    );
  });
});
