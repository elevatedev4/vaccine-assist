import { describe, expect, it } from "vitest";
import { addDaysToChicagoDate, chicagoDateString, chicagoDayRange } from "@/lib/chicago-date";

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
