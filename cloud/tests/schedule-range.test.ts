import { describe, expect, it } from "vitest";
import {
  MAX_RANGE_MONTHS,
  chunkScheduleRange,
  daysInclusive,
  defaultScheduleRange,
  maxEndForStart,
  mergePollResponses,
  parseScheduleRangeParams,
  validateScheduleRange,
  type ChunkPollResponse,
} from "@/lib/schedule-range";
import { buildAppointmentTable } from "@/lib/appointment-table";

describe("defaultScheduleRange", () => {
  it("is today through one calendar month out", () => {
    expect(defaultScheduleRange("2026-10-07")).toEqual({ start: "2026-10-07", end: "2026-11-07" });
  });

  it("clamps month-end to the shorter month (Jan 31 -> Feb 28)", () => {
    expect(defaultScheduleRange("2026-01-31").end).toBe("2026-02-28");
  });

  it("clamps to Feb 29 in a leap year", () => {
    expect(defaultScheduleRange("2028-01-31").end).toBe("2028-02-29");
  });

  it("rolls over the year boundary", () => {
    expect(defaultScheduleRange("2026-12-15").end).toBe("2027-01-15");
  });
});

describe("validateScheduleRange", () => {
  it("accepts a normal range", () => {
    expect(validateScheduleRange("2026-10-07", "2026-11-07")).toEqual({
      ok: true,
      range: { start: "2026-10-07", end: "2026-11-07" },
    });
  });

  it("accepts a single-day range", () => {
    expect(validateScheduleRange("2026-10-07", "2026-10-07").ok).toBe(true);
  });

  it("rejects end before start", () => {
    const result = validateScheduleRange("2026-10-07", "2026-10-06");
    expect(result.ok).toBe(false);
  });

  it("rejects empty and malformed dates", () => {
    expect(validateScheduleRange("", "2026-10-06").ok).toBe(false);
    expect(validateScheduleRange("2026-10-07", "10/07/2026").ok).toBe(false);
    expect(validateScheduleRange("2026-02-31", "2026-03-05").ok).toBe(false);
  });

  it("allows exactly the 6-month cap and rejects one day past it", () => {
    expect(maxEndForStart("2026-10-07")).toBe("2027-04-07");
    expect(validateScheduleRange("2026-10-07", "2027-04-07").ok).toBe(true);
    const over = validateScheduleRange("2026-10-07", "2027-04-08");
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error).toContain(`${MAX_RANGE_MONTHS} months`);
  });
});

describe("parseScheduleRangeParams", () => {
  const today = "2026-10-07";

  it("defaults to today..+1 month when no params are given", () => {
    expect(parseScheduleRangeParams(null, null, today)).toEqual({
      range: { start: "2026-10-07", end: "2026-11-07" },
      error: null,
    });
  });

  it("uses a valid URL range", () => {
    expect(parseScheduleRangeParams("2026-11-01", "2026-12-15", today)).toEqual({
      range: { start: "2026-11-01", end: "2026-12-15" },
      error: null,
    });
  });

  it("falls back to the default with a message when only one param is present", () => {
    const parsed = parseScheduleRangeParams("2026-11-01", null, today);
    expect(parsed.range).toEqual({ start: "2026-10-07", end: "2026-11-07" });
    expect(parsed.error).toMatch(/start and an end/);
  });

  it("falls back to the default with a message for garbage and over-cap ranges", () => {
    expect(parseScheduleRangeParams("nope", "2026-11-01", today).error).not.toBeNull();
    expect(parseScheduleRangeParams("2026-10-07", "2028-01-01", today).error).toMatch(/6 months/);
    expect(parseScheduleRangeParams("2026-11-05", "2026-11-01", today).range.start).toBe("2026-10-07");
  });
});

describe("daysInclusive / chunkScheduleRange", () => {
  it("lists every day inclusive, across a month and DST boundary", () => {
    const days = daysInclusive("2026-10-30", "2026-11-03");
    expect(days).toEqual(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03"]);
  });

  it("keeps a <=31-day range as one chunk", () => {
    expect(chunkScheduleRange({ start: "2026-10-07", end: "2026-11-06" })).toEqual([
      { start: "2026-10-07", end: "2026-11-06" },
    ]);
  });

  it("splits a month+1 day (32 days) into 31 + 1", () => {
    const chunks = chunkScheduleRange({ start: "2026-10-07", end: "2026-11-07" });
    expect(chunks).toEqual([
      { start: "2026-10-07", end: "2026-11-06" },
      { start: "2026-11-07", end: "2026-11-07" },
    ]);
  });

  it("covers a full 6-month range contiguously with no chunk over 31 days", () => {
    const range = { start: "2026-10-07", end: maxEndForStart("2026-10-07") };
    const chunks = chunkScheduleRange(range);
    expect(chunks[0].start).toBe(range.start);
    expect(chunks[chunks.length - 1].end).toBe(range.end);
    let covered = 0;
    chunks.forEach((chunk, i) => {
      const span = daysInclusive(chunk.start, chunk.end).length;
      expect(span).toBeLessThanOrEqual(31);
      covered += span;
      if (i > 0) expect(daysInclusive(chunks[i - 1].end, chunk.start).length).toBe(2);
    });
    expect(covered).toBe(daysInclusive(range.start, range.end).length);
  });
});

describe("mergePollResponses", () => {
  const part = (over: Partial<ChunkPollResponse>): ChunkPollResponse => ({
    configured: true,
    counts: [],
    possiblyTruncated: false,
    cacheHit: true,
    asOf: "2026-10-07T12:00:00.000Z",
    ...over,
  });

  it("concatenates counts, hourly and test counts from every chunk", () => {
    const merged = mergePollResponses([
      part({
        counts: [{ date: "2026-10-07", vaccineName: "Flu Shot", count: 2 }],
        hourlyCounts: [{ date: "2026-10-07", hour: 9, appointmentCount: 1, vaccineCount: 2 }],
        testCounts: [{ date: "2026-10-07", testName: "A1C", count: 1 }],
      }),
      part({ counts: [{ date: "2026-11-07", vaccineName: "Flu Shot", count: 3 }] }),
    ]);
    expect(merged.counts).toHaveLength(2);
    expect(merged.hourlyCounts).toHaveLength(1);
    expect(merged.testCounts).toHaveLength(1);
  });

  it("merged counts pivot into one table spanning both chunks", () => {
    const merged = mergePollResponses([
      part({ counts: [{ date: "2026-10-07", vaccineName: "Flu Shot", count: 2 }] }),
      part({ counts: [{ date: "2026-11-07", vaccineName: "Flu Shot", count: 3 }] }),
    ]);
    const table = buildAppointmentTable(merged.counts, daysInclusive("2026-10-07", "2026-11-07"));
    expect(table.days).toHaveLength(32);
    expect(table.grandTotal).toBe(5);
    expect(table.dailyTotals["2026-11-07"]).toBe(3);
  });

  it("flags truncation if any chunk is truncated; cached only if all are", () => {
    const merged = mergePollResponses([part({}), part({ possiblyTruncated: true, cacheHit: false })]);
    expect(merged.possiblyTruncated).toBe(true);
    expect(merged.cacheHit).toBe(false);
  });

  it("reports the oldest timestamp as 'as of'", () => {
    const merged = mergePollResponses([
      part({ asOf: "2026-10-07T12:05:00.000Z" }),
      part({ asOf: "2026-10-07T12:00:00.000Z" }),
    ]);
    expect(merged.asOf).toBe("2026-10-07T12:00:00.000Z");
  });

  it("is not configured if any chunk is not, carrying its message", () => {
    const merged = mergePollResponses([
      part({ configured: false, message: "Set credentials", settingsUrl: "/settings" }),
    ]);
    expect(merged.configured).toBe(false);
    expect(merged.message).toBe("Set credentials");
    expect(merged.counts).toEqual([]);
  });
});
