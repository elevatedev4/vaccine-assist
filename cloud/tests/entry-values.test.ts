import { describe, expect, it } from "vitest";
import {
  buildEntryValueRows,
  centsToDollarsInputValue,
  doseColumnLabel,
  doseNumberOf,
  parseDollarsInputToCents,
  type EntryValueVaccine,
} from "@/lib/entry-values";
import { defaultDirections } from "@/lib/entry-defaults";
import { formatNdcDashed } from "@/lib/ndc";

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

  it("Shingrix regression: two dose rows with mismatched NDCs (split into separate ProductViews upstream) still get doseCount 2 and correct dose numbers, not doseCount 1 each", () => {
    // Reproduces the live bug (Will, 2026-09-12): upstream product
    // grouping (lib/lots-grouping.ts's groupVaccinesIntoProducts, keyed
    // by NDC/name) splits Shingrix's two dose rows into TWO separate
    // ProductViews because their NDCs don't match — each split group
    // then had doseCount 1, so lib/entry-defaults.ts's defaultDirections
    // never prefixed "Dose X — " for Shingrix, unlike Engerix-B/Gardasil/
    // Vaqta/MMR whose dose rows share one NDC.
    const rows = buildEntryValueRows([
      vaccine({ id: "s1", name: "Shingrix", short_code: "shingrix1", dose: "1", ndc: "99999999901" }),
      vaccine({ id: "s2", name: "Shingrix", short_code: "shingrix2", dose: "2", ndc: "99999999902" }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.doseCount === 2)).toBe(true);
    expect(rows.map((r) => r.doseNumber)).toEqual([1, 2]);

    const directions = rows.map((r) => defaultDirections({ doseNumber: r.doseNumber, doseCount: r.doseCount }));
    expect(directions).toEqual([
      "Dose 1 — For administration by healthcare provider in pharmacy.",
      "Dose 2 — For administration by healthcare provider in pharmacy.",
    ]);
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

  it("carries the product's NDC through, formatting dashed for the /entry-values table (same formatNdcDashed as Ordering/Lots)", () => {
    const rows = buildEntryValueRows([vaccine({ id: "c1", name: "Comirnaty", ndc: "00069246510" })]);
    expect(rows[0].ndc).toBe("00069246510");
    expect(formatNdcDashed(rows[0].ndc)).toBe("00069-2465-10");
  });

  it("leaves ndc null (renders blank via formatNdcDashed) when the vaccine has none and no catalog fallback matches", () => {
    const rows = buildEntryValueRows([vaccine({ id: "u1", name: "Unknown Vax", short_code: null, ndc: null })]);
    expect(rows[0].ndc).toBeNull();
    expect(formatNdcDashed(rows[0].ndc)).toBe("");
  });

  it("falls back to catalog type 'Other' (sorted last) for an unrecognized/missing short_code", () => {
    const rows = buildEntryValueRows([vaccine({ id: "u1", name: "Unknown Vax", short_code: null })]);
    expect(rows[0].catalogType).toBe("Other");
  });

  it("looks up the real catalog type for a known short_code", () => {
    const rows = buildEntryValueRows([vaccine({ id: "shx", name: "Shingles", short_code: "shingrix", dose: "1" })]);
    expect(rows[0].catalogType).toBe("Shingles");
  });

  describe("cash price (per PRODUCT, not per dose)", () => {
    it("a single-dose product's row carries its own cash price and is editable", () => {
      const rows = buildEntryValueRows([vaccine({ id: "c1", name: "Comirnaty", short_code: "comirnaty12", cash_price_cents: 14799 })]);
      expect(rows[0].cashPriceCents).toBe(14799);
      expect(rows[0].cashPriceEditable).toBe(true);
    });

    it("null cash price stays null (never invented)", () => {
      const rows = buildEntryValueRows([vaccine({ id: "c1", name: "Comirnaty", cash_price_cents: null })]);
      expect(rows[0].cashPriceCents).toBeNull();
    });

    it("a multi-dose product's first dose row is the editable one; every dose shares its price", () => {
      const rows = buildEntryValueRows([
        vaccine({ id: "s1", name: "Shingrix", short_code: "shingrix1", dose: "1", ndc: "58160-0821-52", cash_price_cents: 23299 }),
        // Dose 2's OWN cash_price_cents (a stray/stale value) is ignored —
        // the product's price always comes from the first dose row, same
        // convention lib/macro-codes.ts's MacroProductGroup uses.
        vaccine({ id: "s2", name: "Shingrix", short_code: "shingrix2", dose: "2", ndc: "58160-0821-52", cash_price_cents: 999 }),
      ]);
      expect(rows.map((r) => r.cashPriceCents)).toEqual([23299, 23299]);
      expect(rows.map((r) => r.cashPriceEditable)).toEqual([true, false]);
    });

    // Review fix (2026-09-28): GET /api/vaccines orders by `name` only,
    // and same-product dose rows share a name, so their relative fetch
    // order is unspecified — the primary/editable row must be picked by
    // parsing each row's own `dose` column, never by array order.
    it("picks the LOWEST-doseNumber row as primary even when dose 2 appears before dose 1 in the input array", () => {
      const rows = buildEntryValueRows([
        vaccine({ id: "s2", name: "Shingrix", short_code: "shingrix2", dose: "2", ndc: "58160-0821-52", cash_price_cents: 999 }),
        vaccine({ id: "s1", name: "Shingrix", short_code: "shingrix1", dose: "1", ndc: "58160-0821-52", cash_price_cents: 23299 }),
      ]);
      const dose1Row = rows.find((r) => r.id === "s1")!;
      const dose2Row = rows.find((r) => r.id === "s2")!;
      expect(dose1Row.cashPriceEditable).toBe(true);
      expect(dose2Row.cashPriceEditable).toBe(false);
      expect(dose1Row.cashPriceCents).toBe(23299);
      expect(dose2Row.cashPriceCents).toBe(23299);
    });
  });
});

describe("centsToDollarsInputValue", () => {
  it("formats cents as a plain 2-decimal dollar string", () => {
    expect(centsToDollarsInputValue(8900)).toBe("89.00");
    expect(centsToDollarsInputValue(14799)).toBe("147.99");
  });

  it("returns an empty string for null (no price on file)", () => {
    expect(centsToDollarsInputValue(null)).toBe("");
  });

  it("formats zero as 0.00, not blank", () => {
    expect(centsToDollarsInputValue(0)).toBe("0.00");
  });
});

describe("parseDollarsInputToCents", () => {
  it("round-trips with centsToDollarsInputValue", () => {
    expect(parseDollarsInputToCents(centsToDollarsInputValue(14799))).toBe(14799);
  });

  it("parses a plain dollar amount to cents", () => {
    expect(parseDollarsInputToCents("89")).toBe(8900);
    expect(parseDollarsInputToCents("89.00")).toBe(8900);
    expect(parseDollarsInputToCents("89.5")).toBe(8950);
  });

  it("tolerates a leading $", () => {
    expect(parseDollarsInputToCents("$89.00")).toBe(8900);
  });

  it("tolerates thousands-separator commas", () => {
    expect(parseDollarsInputToCents("1,234.56")).toBe(123456);
    expect(parseDollarsInputToCents("$1,234.56")).toBe(123456);
  });

  it("blank (or whitespace-only) clears the price to null", () => {
    expect(parseDollarsInputToCents("")).toBeNull();
    expect(parseDollarsInputToCents("   ")).toBeNull();
  });

  it("rejects a negative amount", () => {
    expect(parseDollarsInputToCents("-5")).toBeUndefined();
  });

  it("rejects more than 2 decimal places", () => {
    expect(parseDollarsInputToCents("89.999")).toBeUndefined();
  });

  it("rejects non-numeric garbage", () => {
    expect(parseDollarsInputToCents("abc")).toBeUndefined();
    expect(parseDollarsInputToCents("$")).toBeUndefined();
  });
});
