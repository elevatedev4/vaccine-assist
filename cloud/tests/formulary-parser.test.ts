import { describe, expect, it } from "vitest";
import { parseFormularyRows } from "../scripts/lib/formulary-parser.mjs";

// Column indices mirrored from formulary-parser.mjs's COLUMN map:
// [6]=price [7]=ageGroup [8]=name [9]=dose [10]=shortCode [11]=macroText [12]=ndc
function row(opts: {
  price?: number | null;
  ageGroup?: string | null;
  name?: string | null;
  dose?: number | string | null;
  shortCode?: string | null;
  macroText?: string | null;
  ndc?: string | null;
}) {
  const r = new Array(13).fill(null);
  r[6] = opts.price ?? null;
  r[7] = opts.ageGroup ?? null;
  r[8] = opts.name ?? null;
  r[9] = opts.dose ?? null;
  r[10] = opts.shortCode ?? null;
  r[11] = opts.macroText ?? null;
  r[12] = opts.ndc ?? null;
  return r;
}

describe("parseFormularyRows", () => {
  it("extracts a single well-formed row", () => {
    const { vaccines } = parseFormularyRows([
      row({
        price: 147.99,
        ageGroup: "Pfizer 12+ (2025-26)",
        name: "Comirnaty 2025-26 12+",
        dose: 1,
        shortCode: "comirnaty12",
        ndc: "00069-2528-10",
      }),
    ]);

    expect(vaccines).toHaveLength(1);
    expect(vaccines[0]).toMatchObject({
      shortCode: "comirnaty12",
      name: "Comirnaty 2025-26 12+",
      ndc: "00069-2528-10",
      dose: "1",
      cashPriceCents: 14799,
    });
  });

  it("skips the header row (H/I/J/K literal column labels)", () => {
    const { vaccines } = parseFormularyRows([
      row({ ageGroup: "Cash price (2/28/24)", name: "Vaccine", dose: "Dose", shortCode: "Short code" }),
    ]);
    expect(vaccines).toHaveLength(0);
  });

  it("skips rows missing a short code or name", () => {
    const { vaccines } = parseFormularyRows([
      row({ name: "Something", shortCode: null }),
      row({ name: null, shortCode: "abc" }),
      row({}),
    ]);
    expect(vaccines).toHaveLength(0);
  });

  it("dedupes repeated rows for the same short_code (copy-paste duplicates)", () => {
    const { vaccines } = parseFormularyRows([
      row({ name: "Spikevax", shortCode: "spikevax6mo11", dose: 1 }),
      row({ name: "Spikevax", shortCode: "spikevax6mo11", dose: 1 }),
      row({ name: "Spikevax", shortCode: "spikevax6mo11", dose: 1, ndc: "3053855" }),
    ]);
    expect(vaccines).toHaveLength(1);
    expect(vaccines[0].ndc).toBe("3053855");
  });

  it("fills missing fields from a later duplicate without clobbering existing data", () => {
    const { vaccines } = parseFormularyRows([
      row({ name: "Arexvy", shortCode: "arexvy", price: 311.99 }),
      row({ name: "Arexvy", shortCode: "arexvy", ndc: "58160-0848-11" }),
    ]);
    expect(vaccines).toHaveLength(1);
    expect(vaccines[0].cashPriceCents).toBe(31199);
    expect(vaccines[0].ndc).toBe("58160-0848-11");
  });

  it("keeps dose-1/dose-2 entries of the same product as separate rows", () => {
    const { vaccines, warnings } = parseFormularyRows([
      row({ name: "Shingrix", shortCode: "shingrix1", dose: 1, ndc: "58160-0823-11" }),
      row({ name: "Shingrix", shortCode: "shingrix2", dose: 2, ndc: null }),
    ]);
    expect(vaccines).toHaveLength(2);
    expect(vaccines.map((v) => v.shortCode).sort()).toEqual(["shingrix1", "shingrix2"]);
  });

  it("warns (but keeps both) when ndc+name collides across different short codes", () => {
    const { warnings } = parseFormularyRows([
      row({ name: "Engerix", shortCode: "engerix1", ndc: "2GZ34" }),
      row({ name: "Engerix", shortCode: "engerix2", ndc: "2GZ34" }),
    ]);
    expect(warnings.some((w) => w.includes("ndc+name"))).toBe(true);
  });

  it("backfills a nameless dose-2/dose-3 row from its dose-1 sibling", () => {
    const { vaccines, warnings } = parseFormularyRows([
      row({ name: "Shingrix", shortCode: "shingrix1", dose: 1, ndc: "58160-0823-11", price: 232.99 }),
      row({ name: null, shortCode: "shingrix2", dose: 2 }),
    ]);
    expect(vaccines).toHaveLength(2);
    const dose2 = vaccines.find((v) => v.shortCode === "shingrix2");
    expect(dose2).toMatchObject({ name: "Shingrix", ndc: "58160-0823-11", cashPriceCents: 23299 });
    expect(warnings.some((w) => w.includes("inherited"))).toBe(true);
  });

  it("drops a row whose short_code never resolves to a name anywhere in the sheet", () => {
    const { vaccines, warnings } = parseFormularyRows([row({ name: null, shortCode: "mystery9" })]);
    expect(vaccines).toHaveLength(0);
    expect(warnings.some((w) => w.includes("no name anywhere"))).toBe(true);
  });

  it("treats a non-numeric price as null rather than throwing", () => {
    const { vaccines } = parseFormularyRows([
      row({ name: "Boostrix", shortCode: "boostrix", price: undefined }),
    ]);
    expect(vaccines[0].cashPriceCents).toBeNull();
  });
});
