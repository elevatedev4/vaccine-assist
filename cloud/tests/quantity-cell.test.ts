import { describe, expect, it } from "vitest";
import { parseQuantityCell } from "@/lib/on-hand/quantity-cell";

describe("parseQuantityCell", () => {
  it("parses a bare number cell (already-parsed xlsx numeric cell)", () => {
    expect(parseQuantityCell(9)).toEqual({ value: 9, unit: null });
    expect(parseQuantityCell(4.5)).toEqual({ value: 4.5, unit: null });
  });

  it("parses a bare numeric string with no unit", () => {
    expect(parseQuantityCell("9")).toEqual({ value: 9, unit: null });
  });

  it("parses a number with a space then a unit", () => {
    expect(parseQuantityCell("9 EA")).toEqual({ value: 9, unit: "EA" });
    expect(parseQuantityCell("4.5 ML")).toEqual({ value: 4.5, unit: "ML" });
  });

  it("parses a number with NO space before the unit", () => {
    expect(parseQuantityCell("0.5mL")).toEqual({ value: 0.5, unit: "ML" });
    expect(parseQuantityCell("9EA")).toEqual({ value: 9, unit: "EA" });
  });

  it("is case-insensitive on the unit", () => {
    expect(parseQuantityCell("9 ea")).toEqual({ value: 9, unit: "EA" });
    expect(parseQuantityCell("4.5 ml")).toEqual({ value: 4.5, unit: "ML" });
    expect(parseQuantityCell("9 Ea")).toEqual({ value: 9, unit: "EA" });
  });

  it("strips thousands-comma separators before parsing", () => {
    expect(parseQuantityCell("1,200 ML")).toEqual({ value: 1200, unit: "ML" });
    expect(parseQuantityCell("1,200")).toEqual({ value: 1200, unit: null });
  });

  it("returns null value/unit for a blank cell", () => {
    expect(parseQuantityCell("")).toEqual({ value: null, unit: null });
    expect(parseQuantityCell("   ")).toEqual({ value: null, unit: null });
    expect(parseQuantityCell(null)).toEqual({ value: null, unit: null });
    expect(parseQuantityCell(undefined)).toEqual({ value: null, unit: null });
  });

  it("returns null value/unit for a cell with no numeric content", () => {
    expect(parseQuantityCell("EA")).toEqual({ value: null, unit: null });
    expect(parseQuantityCell("n/a")).toEqual({ value: null, unit: null });
  });

  it("ignores an unrecognized trailing unit token (only EA/ML are recognized)", () => {
    expect(parseQuantityCell("57.5 mg")).toEqual({ value: 57.5, unit: null });
  });

  it("returns null for a non-finite number input", () => {
    expect(parseQuantityCell(NaN)).toEqual({ value: null, unit: null });
    expect(parseQuantityCell(Infinity)).toEqual({ value: null, unit: null });
  });

  // Review fix (V-onhand-ndc-units): a BOH/stock-size cell is a physical
  // quantity — a negative number is never valid and must not silently
  // flow into computeDoses/downstream math.
  describe("negative values (review fix)", () => {
    it("rejects a negative number cell", () => {
      expect(parseQuantityCell(-5)).toEqual({ value: null, unit: null });
    });

    it("rejects a negative numeric string, with or without a unit", () => {
      expect(parseQuantityCell("-5")).toEqual({ value: null, unit: null });
      expect(parseQuantityCell("-5 EA")).toEqual({ value: null, unit: null });
      expect(parseQuantityCell("-4.5ML")).toEqual({ value: null, unit: null });
    });
  });
});
