import { describe, expect, it } from "vitest";
import { addDaysToChicagoDate, chicagoDateString, chicagoDayRange, chicagoHour } from "@/lib/chicago-date";

describe("chicagoDateString", () => {
  it("renders a UTC instant as its America/Chicago calendar day", () => {
    // 2026-08-17T03:00:00Z == 2026-08-16T22:00:00-05:00 Central (CDT).
    expect(chicagoDateString(new Date("2026-08-17T03:00:00Z"))).toBe("2026-08-16");
  });

  it("renders an instant that is the same calendar day in both zones", () => {
    // Midday UTC is comfortably the same day in Central time too.
    expect(chicagoDateString(new Date("2026-08-17T15:00:00Z"))).toBe("2026-08-17");
  });

  it("handles the exact UTC-midnight boundary correctly for Central time", () => {
    // 2026-08-17T00:00:00Z == 2026-08-16T19:00:00-05:00 Central — still the 16th locally.
    expect(chicagoDateString(new Date("2026-08-17T00:00:00Z"))).toBe("2026-08-16");
  });
});

describe("addDaysToChicagoDate", () => {
  it("adds whole days without drifting across a month boundary", () => {
    expect(addDaysToChicagoDate("2026-08-28", 7)).toBe("2026-09-04");
  });

  it("adds zero days as a no-op", () => {
    expect(addDaysToChicagoDate("2026-08-16", 0)).toBe("2026-08-16");
  });

  it("is stable across the US DST fall-back boundary (Nov 1, 2026)", () => {
    // Regression guard: date-only arithmetic must not be perturbed by DST.
    expect(addDaysToChicagoDate("2026-10-30", 3)).toBe("2026-11-02");
  });
});

describe("chicagoHour", () => {
  it("renders a UTC instant as its America/Chicago wall-clock hour (CDT)", () => {
    // 2026-08-17T15:00:00Z == 2026-08-17T10:00:00-05:00 Central (CDT).
    expect(chicagoHour(new Date("2026-08-17T15:00:00Z"))).toBe(10);
  });

  it("handles Central midnight without an hourCycle 'h23' wraparound to 24", () => {
    // 2026-08-17T05:00:00Z == 2026-08-17T00:00:00-05:00 Central — exact
    // midnight. Some Intl configurations render 12am as "24" under
    // hour12:false; hourCycle "h23" is what guards against that here.
    expect(chicagoHour(new Date("2026-08-17T05:00:00Z"))).toBe(0);
  });

  it("is correct across the US DST fall-back boundary (Nov 1, 2026)", () => {
    // Central switches from CDT (UTC-5) to CST (UTC-6) at 2026-11-01
    // 02:00 CDT local, which is 2026-11-01T07:00:00Z — any UTC instant
    // strictly before that is still CDT, anything at/after it is CST.
    expect(chicagoHour(new Date("2026-11-01T06:00:00Z"))).toBe(1); // 01:00 CDT (UTC-5), just before the fall-back
    expect(chicagoHour(new Date("2026-11-01T14:00:00Z"))).toBe(8); // 08:00 CST (UTC-6), after the fall-back
  });

  it("is correct across the US DST spring-forward boundary (Mar 8, 2026)", () => {
    // Central switches from CST (UTC-6) to CDT (UTC-5) at 2026-03-08
    // 02:00 local (springs forward to 3am).
    expect(chicagoHour(new Date("2026-03-08T07:00:00Z"))).toBe(1); // 01:00 CST (UTC-6), before spring-forward
    expect(chicagoHour(new Date("2026-03-08T13:00:00Z"))).toBe(8); // 08:00 CDT (UTC-5), after spring-forward
  });

  it("covers every hour 0-23 with no out-of-range value across a full day", () => {
    for (let h = 0; h < 24; h++) {
      const instant = new Date(Date.UTC(2026, 5, 15, h));
      const hour = chicagoHour(instant);
      expect(hour).toBeGreaterThanOrEqual(0);
      expect(hour).toBeLessThanOrEqual(23);
    }
  });
});

describe("chicagoDayRange", () => {
  it("returns days+1 entries starting today, since 0..days is inclusive", () => {
    const range = chicagoDayRange(7);
    expect(range).toHaveLength(8);
    expect(range[0] < range[1]).toBe(true);
    expect(range.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))).toBe(true);
  });

  it("produces a contiguous, strictly increasing sequence of days", () => {
    const range = chicagoDayRange(7);
    for (let i = 1; i < range.length; i++) {
      expect(addDaysToChicagoDate(range[i - 1], 1)).toBe(range[i]);
    }
  });
});
