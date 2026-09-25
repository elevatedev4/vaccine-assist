import { describe, expect, it } from "vitest";
import { ageRangeIncludes, parseAgeRange } from "@/lib/age-range";

describe("parseAgeRange", () => {
  it("plain '+' form", () => {
    expect(parseAgeRange("12+")).toEqual([{ minYears: 12, maxYears: null }]);
    expect(parseAgeRange("2+")).toEqual([{ minYears: 2, maxYears: null }]);
    expect(parseAgeRange("50+")).toEqual([{ minYears: 50, maxYears: null }]);
  });

  it("en-dash range", () => {
    expect(parseAgeRange("3–11")).toEqual([{ minYears: 3, maxYears: 11 }]);
    expect(parseAgeRange("2–49")).toEqual([{ minYears: 2, maxYears: 49 }]);
    expect(parseAgeRange("9–45")).toEqual([{ minYears: 9, maxYears: 45 }]);
  });

  it("months '+' form ('6 mo+')", () => {
    expect(parseAgeRange("6 mo+")).toEqual([{ minYears: 0.5, maxYears: null }]);
    expect(parseAgeRange("12 mo+")).toEqual([{ minYears: 1, maxYears: null }]);
  });

  it("months-to-years range ('2 mo–55')", () => {
    expect(parseAgeRange("2 mo–55")).toEqual([{ minYears: 2 / 12, maxYears: 55 }]);
  });

  it("compact months shorthand with no space ('6m–11'), as a desktop caller might pass", () => {
    expect(parseAgeRange("6m–11")).toEqual([{ minYears: 0.5, maxYears: 11 }]);
  });

  it("qualifier clause in parens is a second token, in order ('50+ (19+ IC)')", () => {
    expect(parseAgeRange("50+ (19+ IC)")).toEqual([
      { minYears: 50, maxYears: null },
      { minYears: 19, maxYears: null },
    ]);
  });

  it("qualifier clause with an explicit range ('60+ (50–59 high-risk)')", () => {
    expect(parseAgeRange("60+ (50–59 high-risk)")).toEqual([
      { minYears: 60, maxYears: null },
      { minYears: 50, maxYears: 59 },
    ]);
  });

  it("comma-joined qualifier clause, per Will's brief wording ('75+, 18+ high-risk')", () => {
    expect(parseAgeRange("75+, 18+ high-risk")).toEqual([
      { minYears: 75, maxYears: null },
      { minYears: 18, maxYears: null },
    ]);
  });

  it("returns [] for an empty or unparseable label", () => {
    expect(parseAgeRange("")).toEqual([]);
    expect(parseAgeRange("high-risk only")).toEqual([]);
  });
});

describe("ageRangeIncludes", () => {
  it("'12+': exactly 12 is included, 11.9 is not", () => {
    expect(ageRangeIncludes("12+", 12)).toBe(true);
    expect(ageRangeIncludes("12+", 11.9)).toBe(false);
    expect(ageRangeIncludes("12+", 40)).toBe(true);
  });

  it("'6m–11': edges at 0.4/0.5/11/12", () => {
    expect(ageRangeIncludes("6m–11", 0.4)).toBe(false);
    expect(ageRangeIncludes("6m–11", 0.5)).toBe(true);
    expect(ageRangeIncludes("6m–11", 11)).toBe(true);
    expect(ageRangeIncludes("6m–11", 12)).toBe(false);
  });

  it("'3–11' inclusive range", () => {
    expect(ageRangeIncludes("3–11", 2.9)).toBe(false);
    expect(ageRangeIncludes("3–11", 3)).toBe(true);
    expect(ageRangeIncludes("3–11", 11)).toBe(true);
    expect(ageRangeIncludes("3–11", 11.1)).toBe(false);
  });

  it("'50+ (19+ IC)' matches via EITHER token", () => {
    expect(ageRangeIncludes("50+ (19+ IC)", 60)).toBe(true);
    expect(ageRangeIncludes("50+ (19+ IC)", 25)).toBe(true);
    expect(ageRangeIncludes("50+ (19+ IC)", 10)).toBe(false);
  });

  it("'75+, 18+ high-risk' matches via either clause", () => {
    expect(ageRangeIncludes("75+, 18+ high-risk", 80)).toBe(true);
    expect(ageRangeIncludes("75+, 18+ high-risk", 30)).toBe(true);
    expect(ageRangeIncludes("75+, 18+ high-risk", 10)).toBe(false);
  });

  it("an unparseable or empty label is never excluded", () => {
    expect(ageRangeIncludes("", 5)).toBe(true);
    expect(ageRangeIncludes("", 0)).toBe(true);
    expect(ageRangeIncludes("unrecognized", 25)).toBe(true);
  });
});
