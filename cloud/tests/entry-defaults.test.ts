import { describe, expect, it } from "vitest";
import { defaultDirections, planFillBlanksDirections } from "@/lib/entry-defaults";

describe("defaultDirections", () => {
  it("single-dose product: no 'Dose X' prefix", () => {
    expect(defaultDirections({ doseNumber: 1, doseCount: 1 })).toBe(
      "For administration by healthcare provider in pharmacy."
    );
  });

  it("multi-dose series: prefixes 'Dose X — ' using the dose number", () => {
    expect(defaultDirections({ doseNumber: 1, doseCount: 2 })).toBe(
      "Dose 1 — For administration by healthcare provider in pharmacy."
    );
    expect(defaultDirections({ doseNumber: 2, doseCount: 2 })).toBe(
      "Dose 2 — For administration by healthcare provider in pharmacy."
    );
  });

  it("dose numbering follows doseNumber, not doseCount, for a 3-dose series", () => {
    expect(defaultDirections({ doseNumber: 3, doseCount: 3 })).toBe(
      "Dose 3 — For administration by healthcare provider in pharmacy."
    );
  });
});

describe("planFillBlanksDirections", () => {
  it("plans a PATCH for a row with null directions", () => {
    const patches = planFillBlanksDirections([{ id: "v1", directions: null, doseNumber: 1, doseCount: 1 }]);
    expect(patches).toEqual([{ id: "v1", directions: "For administration by healthcare provider in pharmacy." }]);
  });

  it("plans a PATCH for a row with whitespace-only directions", () => {
    const patches = planFillBlanksDirections([{ id: "v1", directions: "   ", doseNumber: 1, doseCount: 1 }]);
    expect(patches).toHaveLength(1);
    expect(patches[0].id).toBe("v1");
  });

  it("uses the multi-dose default for a row whose doseCount > 1", () => {
    const patches = planFillBlanksDirections([{ id: "shingrix2", directions: null, doseNumber: 2, doseCount: 2 }]);
    expect(patches[0].directions).toBe("Dose 2 — For administration by healthcare provider in pharmacy.");
  });

  it("never plans a PATCH for a row that already has non-blank directions, even if it wouldn't match today's default", () => {
    const patches = planFillBlanksDirections([
      { id: "comirnaty12", directions: "inject 0.2ml into the muscle once.", doseNumber: 1, doseCount: 1 },
    ]);
    expect(patches).toEqual([]);
  });

  it("only plans PATCHes for the blank rows out of a mixed list, preserving id order", () => {
    const patches = planFillBlanksDirections([
      { id: "a", directions: "already set", doseNumber: 1, doseCount: 1 },
      { id: "b", directions: null, doseNumber: 1, doseCount: 2 },
      { id: "c", directions: "", doseNumber: 2, doseCount: 2 },
    ]);
    expect(patches.map((p) => p.id)).toEqual(["b", "c"]);
  });

  it("returns an empty list when given no rows", () => {
    expect(planFillBlanksDirections([])).toEqual([]);
  });
});
