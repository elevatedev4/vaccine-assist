import { afterEach, describe, expect, it, vi } from "vitest";

// This module does NOT depend on lib/acuity-poll-cache.ts at all (unlike
// lib/acuity-future-summary.ts) — see its own doc comment for why
// per-window caching of a createdDate-keyed aggregation would be wrong.
// No cache mock needed here.

import {
  BOOKING_ACTIVITY_FETCH_CONCURRENCY,
  BOOKING_ACTIVITY_FETCH_WINDOW_DAYS,
  BOOKING_ACTIVITY_FUTURE_DAYS,
  bookingActivityCreatedRange,
  buildBookingActivityFetchWindows,
  fetchBookingActivityCounts,
} from "@/lib/acuity-booking-activity";
import { BOOKING_ACTIVITY_LOOKBACK_DAYS } from "@/lib/appointment-table";

function acuityAppointmentFixture(
  datetime: string,
  datetimeCreated: string,
  vaccineName: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    id: 1,
    datetime,
    datetimeCreated,
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

describe("bookingActivityCreatedRange", () => {
  it("returns [today - LOOKBACK_DAYS, today] inclusive", () => {
    const { minCreated, maxCreated } = bookingActivityCreatedRange("2026-09-07");
    expect(maxCreated).toBe("2026-09-07");
    expect(daySpan(minCreated, maxCreated)).toBe(BOOKING_ACTIVITY_LOOKBACK_DAYS + 1);
  });
});

describe("buildBookingActivityFetchWindows", () => {
  it("covers [today - LOOKBACK_DAYS, today + FUTURE_DAYS] with no gaps and no overlaps", () => {
    const today = "2026-09-07";
    const windows = buildBookingActivityFetchWindows(today);

    const expectedStart = bookingActivityCreatedRange(today).minCreated;
    expect(windows[0].start).toBe(expectedStart);

    for (let i = 1; i < windows.length; i++) {
      // Contiguous: each window starts the day right after the previous ends.
      expect(daySpan(windows[i - 1].end, windows[i].start)).toBe(2);
    }

    const last = windows[windows.length - 1];
    const expectedEnd = new Date(`${today}T00:00:00Z`);
    expectedEnd.setUTCDate(expectedEnd.getUTCDate() + BOOKING_ACTIVITY_FUTURE_DAYS);
    expect(last.end).toBe(expectedEnd.toISOString().slice(0, 10));
  });

  it("every window except possibly the last spans exactly BOOKING_ACTIVITY_FETCH_WINDOW_DAYS days", () => {
    const windows = buildBookingActivityFetchWindows("2026-09-07");
    for (const window of windows.slice(0, -1)) {
      expect(daySpan(window.start, window.end)).toBe(BOOKING_ACTIVITY_FETCH_WINDOW_DAYS);
    }
    // The last window is clipped to the range end rather than
    // overshooting it, so it may be shorter than a full window.
    const last = windows[windows.length - 1];
    expect(daySpan(last.start, last.end)).toBeLessThanOrEqual(BOOKING_ACTIVITY_FETCH_WINDOW_DAYS);
    expect(daySpan(last.start, last.end)).toBeGreaterThan(0);
  });
});

describe("fetchBookingActivityCounts", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("aggregates counts by createdDate (booking date), not appointment date", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const urlStr = url.toString();
      if (urlStr.includes("appointment-types")) {
        return new Response(JSON.stringify([{ id: 111, name: "Vaccine Appointment" }]), { status: 200 });
      }
      const minDate = new URL(urlStr).searchParams.get("minDate");
      // One window (whichever covers 2026-09-05) returns a booking made
      // on 2026-09-05 for a visit far in the future (2026-11-01) — this
      // IS the "booked today, appointment months out" case this feature
      // exists for.
      if (minDate && minDate <= "2026-09-05" && "2026-09-05" <= new URL(urlStr).searchParams.get("maxDate")!) {
        return new Response(
          JSON.stringify([
            acuityAppointmentFixture("2026-11-01T10:00:00-0500", "2026-09-05T09:00:00-0500", "RSV Vaccine"),
          ]),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify([]), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchBookingActivityCounts("user-1", "key-1", "2026-09-07");

    // Grouped under 2026-09-05 (the booking date), never 2026-11-01 (the
    // appointment date).
    expect(result.counts).toEqual([{ date: "2026-09-05", vaccineName: "RSV Vaccine", count: 1 }]);
    expect(result.truncatedWindows).toEqual([]);
  });

  it("drops appointments whose createdDate falls outside the lookback window", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const urlStr = url.toString();
      if (urlStr.includes("appointment-types")) {
        return new Response(JSON.stringify([{ id: 111, name: "Vaccine Appointment" }]), { status: 200 });
      }
      const minDate = new URL(urlStr).searchParams.get("minDate")!;
      // Every window returns one appointment created WAY before the
      // lookback window even starts (2020) — none of these should ever
      // surface in the final counts.
      return new Response(
        JSON.stringify([acuityAppointmentFixture(`${minDate}T10:00:00-0500`, "2020-01-01T09:00:00-0500", "Flu")]),
        { status: 200 }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchBookingActivityCounts("user-1", "key-1", "2026-09-07");

    expect(result.counts).toEqual([]);
  });

  it("drops appointments with a missing/unparseable datetimeCreated (the '' sentinel never matches a real range)", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const urlStr = url.toString();
      if (urlStr.includes("appointment-types")) {
        return new Response(JSON.stringify([{ id: 111, name: "Vaccine Appointment" }]), { status: 200 });
      }
      const minDate = new URL(urlStr).searchParams.get("minDate")!;
      return new Response(
        JSON.stringify([
          acuityAppointmentFixture(`${minDate}T10:00:00-0500`, "not-a-real-datetime", "Flu"),
        ]),
        { status: 200 }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchBookingActivityCounts("user-1", "key-1", "2026-09-07");

    expect(result.counts).toEqual([]);
  });

  it("fetches appointment types exactly once regardless of window count", async () => {
    const typesCalls: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL) => {
      const urlStr = url.toString();
      if (urlStr.includes("appointment-types")) {
        typesCalls.push(urlStr);
        return new Response(JSON.stringify([{ id: 111, name: "Vaccine Appointment" }]), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await fetchBookingActivityCounts("user-1", "key-1", "2026-09-07");

    expect(typesCalls).toHaveLength(1);
  });

  it("marks a window as truncated (and names its range) when it hits the 100-appointment cap", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const urlStr = url.toString();
      if (urlStr.includes("appointment-types")) {
        return new Response(JSON.stringify([{ id: 111, name: "Vaccine Appointment" }]), { status: 200 });
      }
      const minDate = new URL(urlStr).searchParams.get("minDate")!;
      const maxDate = new URL(urlStr).searchParams.get("maxDate")!;
      if (minDate <= "2026-09-05" && "2026-09-05" <= maxDate) {
        const hundred = Array.from({ length: 100 }, (_, i) =>
          acuityAppointmentFixture(`${minDate}T10:00:00-0500`, "2026-09-05T09:00:00-0500", "Flu", { id: i })
        );
        return new Response(JSON.stringify(hundred), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchBookingActivityCounts("user-1", "key-1", "2026-09-07");

    expect(result.truncatedWindows).toHaveLength(1);
    expect(result.truncatedWindows[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}$/);
  });

  it("fetches windows with limited concurrency — more than 1 in flight, never more than BOOKING_ACTIVITY_FETCH_CONCURRENCY", async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    const fetchMock = vi.fn(async (url: string | URL) => {
      const urlStr = url.toString();
      if (urlStr.includes("appointment-types")) {
        return new Response(JSON.stringify([{ id: 111, name: "Vaccine Appointment" }]), { status: 200 });
      }
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight--;
      return new Response(JSON.stringify([]), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await fetchBookingActivityCounts("user-1", "key-1", "2026-09-07");

    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(BOOKING_ACTIVITY_FETCH_CONCURRENCY);
  });

  it("propagates an AcuityApiError from a window's fetch instead of swallowing it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })));

    await expect(fetchBookingActivityCounts("user-1", "key-1", "2026-09-07")).rejects.toThrow(
      /rejected these credentials|unexpected status/i
    );
  });
});
