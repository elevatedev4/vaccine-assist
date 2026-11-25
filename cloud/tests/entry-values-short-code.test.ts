import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildEntryValueRows, type EntryValueVaccine } from "@/lib/entry-values";

/**
 * The Entry values page is a sign-in-gated client component full of hooks and
 * vitest runs in the node environment (no DOM), so it is checked at the source
 * level (same approach as preferred-covid-placement.test.ts); the row data the
 * column reads is checked for real through buildEntryValueRows.
 */
const src = readFileSync(path.resolve(__dirname, "..", "app/entry-values/page.tsx"), "utf8");

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
    cash_price_cents: null,
    ...overrides,
  };
}

describe("Entry values: Short code column", () => {
  it("has a 'Short code' header right after 'Product'", () => {
    expect(src).toMatch(/<th style=\{styles\.th\}>Product<\/th>\s*<th style=\{styles\.th\}>Short code<\/th>\s*<th style=\{styles\.th\}>NDC<\/th>/);
  });

  it("renders row.shortCode as stored (blank when none) in the cell right after the Product cell", () => {
    expect(src).toMatch(
      /<PreferredBadge \/>\}\s*<\/td>\s*<td style=\{\{ \.\.\.styles\.td, \.\.\.styles\.shortCode, \.\.\.groupBorder \}\}>\{row\.shortCode \?\? ""\}<\/td>\s*<td[^>]*>\{formatNdcDashed\(row\.ndc\)\}<\/td>/,
    );
  });

  it("row data carries the stored short code, null when none", () => {
    const rows = buildEntryValueRows([
      vaccine({ id: "c1", name: "Comirnaty", short_code: "comirnaty12" }),
      vaccine({ id: "u1", name: "Unknown Vax", short_code: null }),
    ]);
    expect(rows.map((r) => r.shortCode).sort()).toEqual(["comirnaty12", null]);
  });
});
