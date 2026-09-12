import { describe, expect, it } from "vitest";
import { buildEntryValueRows, doseColumnLabel, doseNumberOf, type EntryValueVaccine } from "@/lib/entry-values";

function vaccine(overrides: Partial<EntryValueVaccine>): EntryValueVaccine {
  return {
    id: "v1",
    name: "Test Vaccine",
    ndc: null,
    dose: null,
    short_code: null,
    active: true,
    quantity: null,
    directions: null,
    ...overrides,
  };
}

describe("doseNumberOf", () => {
  it("defaults to 1 for null/missing dose", () => {
    expect(doseNumberOf(null)).toBe(1);
  });

  it("parses a numeric dose string", () => {
    expect(doseNumberOf("2")).toBe(2);
  });

  it("defaults to 1 for an unparseable dose", () => {
    expect(doseNumberOf("not-a-number")).toBe(1);
  });
});

describe("doseColumnLabel", () => {
  it("renders a plain dose number without a 'Dose' word (the column already has that heading)", () => {
    expect(doseColumnLabel(1)).toBe("1");
    expect(doseColumnLabel(2)).toBe("2");
    expect(doseColumnLabel(12)).toBe("12");
  });

  it("defensively strips a leading 'Dose ' if the input already carries it, case-insensitively", () => {
    expect(doseColumnLabel("Dose 1")).toBe("1");
    expect(doseColumnLabel("dose 2")).toBe("2");
  });
});

describe("buildEntryValueRows", () => {
  it("emits one row per active dose vaccine, with the product's doseCount", () => {
    const rows = buildEntryValueRows([
      vaccine({ id: "s1", name: "Shingrix", short_code: "shingrix1", dose: "1", ndc: "58160-0821-52" }),
      vaccine({ id: "s2", name: "Shingrix", short_code: "shingrix2", dose: "2", ndc: "58160-0821-52" }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.doseCount === 2)).toBe(true);
    expect(rows.map((r) => r.doseNumber)).toEqual([1, 2]);
  });

  it("excludes inactive dose rows", () => {
    const rows = buildEntryValueRows([
      vaccine({ id: "a1", name: "Active Vax", active: true }),
      vaccine({ id: "i1", name: "Inactive Vax", active: false }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(["a1"]);
  });

  it("a single-dose product gets doseCount 1", () => {
    const rows = buildEntryValueRows([vaccine({ id: "c1", name: "Comirnaty", short_code: "comirnaty12", dose: "1" })]);
    expect(rows[0].doseCount).toBe(1);
  });

  it("carries the row's own quantity/directions through unchanged", () => {
    const rows = buildEntryValueRows([
      vaccine({ id: "c1", name: "Comirnaty", quantity: "0.3", directions: "inject 0.3ml into the muscle once." }),
    ]);
    expect(rows[0].quantity).toBe("0.3");
    expect(rows[0].directions).toBe("inject 0.3ml into the muscle once.");
  });

  it("carries the row's own short_code through as shortCode", () => {
    const rows = buildEntryValueRows([vaccine({ id: "c1", name: "Comirnaty", short_code: "comirnaty12" })]);
    expect(rows[0].shortCode).toBe("comirnaty12");
  });

  it("falls back to catalog type 'Other' (sorted last) for an unrecognized/missing short_code", () => {
    const rows = buildEntryValueRows([vaccine({ id: "u1", name: "Unknown Vax", short_code: null })]);
    expect(rows[0].catalogType).toBe("Other");
  });

  it("looks up the real catalog type for a known short_code", () => {
    const rows = buildEntryValueRows([vaccine({ id: "shx", name: "Shingles", short_code: "shingrix", dose: "1" })]);
    expect(rows[0].catalogType).toBe("Shingles");
  });
});
