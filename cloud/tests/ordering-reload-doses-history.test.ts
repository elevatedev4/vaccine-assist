import { describe, expect, it } from "vitest";
import { formatReloadDosesHistoryResult } from "@/lib/ordering-reload-doses-history";

describe("formatReloadDosesHistoryResult", () => {
  it("formats the plural case", () => {
    expect(formatReloadDosesHistoryResult({ rows: 109, days: 7, processed: 3 })).toBe(
      "Doses history reloaded: 109 rows over 7 days (3 files)"
    );
  });

  it("singularizes row/day/file counts of exactly 1", () => {
    expect(formatReloadDosesHistoryResult({ rows: 1, days: 1, processed: 1 })).toBe(
      "Doses history reloaded: 1 row over 1 day (1 file)"
    );
  });

  it("handles the all-zero (nothing retained) case", () => {
    expect(formatReloadDosesHistoryResult({ rows: 0, days: 0, processed: 0 })).toBe(
      "Doses history reloaded: 0 rows over 0 days (0 files)"
    );
  });

  it("pluralizes each count independently", () => {
    expect(formatReloadDosesHistoryResult({ rows: 1, days: 2, processed: 1 })).toBe(
      "Doses history reloaded: 1 row over 2 days (1 file)"
    );
  });
});
