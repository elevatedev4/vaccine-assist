import { describe, expect, it } from "vitest";
import { plusDaysIso } from "@/lib/lots-bud-shortcut";
import { isoToMaskedDate } from "@/lib/date-mask";

describe("plusDaysIso", () => {
  it("adds days within the same month", () => {
    expect(plusDaysIso(new Date(2026, 8, 1), 10)).toBe("2026-09-11"); // Sep 1 -> Sep 11
  });

  it("rolls over into the next month", () => {
    expect(plusDaysIso(new Date(2026, 8, 15), 30)).toBe("2026-10-15"); // Sep 15 + 30d -> Oct 15
  });

  it("rolls over into the next year", () => {
    expect(plusDaysIso(new Date(2026, 11, 15), 30)).toBe("2027-01-14"); // Dec 15 2026 + 30d -> Jan 14 2027
  });

  it("handles a leap day correctly (2028 is a leap year)", () => {
    expect(plusDaysIso(new Date(2028, 1, 15), 30)).toBe("2028-03-16"); // Feb 15 2028 + 30d, crossing Feb 29
  });

  it("handles the day before a leap day as the start date", () => {
    expect(plusDaysIso(new Date(2028, 1, 28), 1)).toBe("2028-02-29"); // Feb 28 2028 + 1d -> Feb 29 (leap)
  });

  it("handles a non-leap year February correctly", () => {
    expect(plusDaysIso(new Date(2026, 1, 28), 1)).toBe("2026-03-01"); // Feb 28 2026 (not a leap year) + 1d -> Mar 1
  });

  it("zero-pads single-digit months and days", () => {
    expect(plusDaysIso(new Date(2026, 0, 1), 3)).toBe("2026-01-04");
  });

  it("round-trips through isoToMaskedDate the same way DateTextInput displays it", () => {
    const iso = plusDaysIso(new Date(2026, 8, 24), 30); // Sep 24 2026 + 30d -> Oct 24 2026
    expect(iso).toBe("2026-10-24");
    expect(isoToMaskedDate(iso)).toBe("10/24/2026");
  });
});
