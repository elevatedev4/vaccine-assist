import { describe, expect, it } from "vitest";
import { parseOnHandContent } from "@/lib/on-hand-parser";
import type { CatalogVaccine } from "@/lib/vaccine-matching";

const CATALOG: CatalogVaccine[] = [
  { id: "v-comirnaty", name: "Comirnaty 2025-26 12+", short_code: "pfizer12" },
  { id: "v-flu", name: "Flu Quad 2025-26", short_code: "fluquad" },
  { id: "v-mmr", name: "MMR-II", short_code: "mmrii" },
];

describe("parseOnHandContent", () => {
  it("parses comma-separated lines and matches them to the catalog", () => {
    const rows = parseOnHandContent("Comirnaty 2025-26 12+, 40\nFlu Quad 2025-26, 120", CATALOG);

    expect(rows).toEqual([
      {
        rawLine: "Comirnaty 2025-26 12+, 40",
        vaccineNameRaw: "Comirnaty 2025-26 12+",
        quantity: 40,
        vaccineId: "v-comirnaty",
        matched: true,
      },
      {
        rawLine: "Flu Quad 2025-26, 120",
        vaccineNameRaw: "Flu Quad 2025-26",
        quantity: 120,
        vaccineId: "v-flu",
        matched: true,
      },
    ]);
  });

  it("parses tab-separated lines the same way", () => {
    const rows = parseOnHandContent("Flu Quad 2025-26\t120", CATALOG);
    expect(rows).toEqual([
      { rawLine: "Flu Quad 2025-26\t120", vaccineNameRaw: "Flu Quad 2025-26", quantity: 120, vaccineId: "v-flu", matched: true },
    ]);
  });

  it("matches via the alias table (MMR -> MMR-II)", () => {
    const rows = parseOnHandContent("MMR, 15", CATALOG);
    expect(rows).toEqual([
      { rawLine: "MMR, 15", vaccineNameRaw: "MMR", quantity: 15, vaccineId: "v-mmr", matched: true },
    ]);
  });

  it("ignores blank lines", () => {
    const rows = parseOnHandContent("Flu Quad 2025-26, 120\n\n\nMMR, 15", CATALOG);
    expect(rows).toHaveLength(2);
  });

  it("ignores lines starting with #", () => {
    const rows = parseOnHandContent("Flu Quad 2025-26, 120\n# sent 8/19 morning count\nMMR, 15", CATALOG);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.vaccineNameRaw)).toEqual(["Flu Quad 2025-26", "MMR"]);
  });

  it("keeps (does not drop) a malformed line with no delimiter, flagged unmatched", () => {
    const rows = parseOnHandContent("this line has no delimiter at all", CATALOG);
    expect(rows).toEqual([
      {
        rawLine: "this line has no delimiter at all",
        vaccineNameRaw: "this line has no delimiter at all",
        quantity: null,
        vaccineId: null,
        matched: false,
      },
    ]);
  });

  it("keeps (does not drop) a line whose quantity isn't a plain integer, flagged unmatched", () => {
    const rows = parseOnHandContent("Flu Quad 2025-26, forty", CATALOG);
    expect(rows).toEqual([
      {
        rawLine: "Flu Quad 2025-26, forty",
        vaccineNameRaw: "Flu Quad 2025-26",
        quantity: null,
        vaccineId: null,
        matched: false,
      },
    ]);
  });

  it("keeps a header row ('Vaccine, Qty') flagged unmatched rather than dropping it", () => {
    const rows = parseOnHandContent("Vaccine, Qty", CATALOG);
    expect(rows).toEqual([
      { rawLine: "Vaccine, Qty", vaccineNameRaw: "Vaccine", quantity: null, vaccineId: null, matched: false },
    ]);
  });

  it("keeps a negative-number quantity as unparsed (only non-negative integers match ^\\d+$)", () => {
    const rows = parseOnHandContent("Flu Quad 2025-26, -5", CATALOG);
    expect(rows[0]).toMatchObject({ quantity: null, matched: false });
  });

  it("parses a valid quantity but flags matched:false when the name has no catalog match", () => {
    const rows = parseOnHandContent("Some Unknown Vaccine, 7", CATALOG);
    expect(rows).toEqual([
      {
        rawLine: "Some Unknown Vaccine, 7",
        vaccineNameRaw: "Some Unknown Vaccine",
        quantity: 7,
        vaccineId: null,
        matched: false,
      },
    ]);
  });

  it("accepts a quantity of 0", () => {
    const rows = parseOnHandContent("Flu Quad 2025-26, 0", CATALOG);
    expect(rows[0]).toMatchObject({ quantity: 0, matched: true, vaccineId: "v-flu" });
  });

  it("returns an empty array for empty/whitespace-only content", () => {
    expect(parseOnHandContent("", CATALOG)).toEqual([]);
    expect(parseOnHandContent("   \n  \n", CATALOG)).toEqual([]);
  });

  it("handles the full example from the format spec end to end", () => {
    const content = [
      "Comirnaty 2025-26 12+, 40",
      "Flu Quad 2025-26, 120",
      "# sent 8/19 morning count",
      "MMR, 15",
    ].join("\n");

    const rows = parseOnHandContent(content, CATALOG);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.matched)).toBe(true);
  });
});
