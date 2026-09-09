import { describe, expect, it } from "vitest";
import { utils, write } from "xlsx";
import {
  computeDoses,
  looksLikePioneerHeader,
  matchPioneerBohRows,
  parseOnHandUpload,
  parsePioneerBohDelimited,
  parsePioneerBohMatrix,
  parsePioneerBohXlsx,
} from "@/lib/on-hand/pioneer-boh";
import type { CatalogVaccine } from "@/lib/vaccine-matching";

const CATALOG: CatalogVaccine[] = [
  { id: "v-fluad", name: "Fluad", short_code: "fluad", ndc: "70461-0123-03" },
  { id: "v-vaxchora", name: "Vaxchora", short_code: "vaxchora", ndc: null },
  { id: "v-flu", name: "Flu Quad 2025-26", short_code: "fluquad", ndc: null },
];

// The real Pioneer export's shape (see the brief's fixture): a two-row
// header, "Stock size" landing on row 2 under a blank 4th column on
// row 1, then data rows.
const SAMPLE_ROWS: (string | number | null)[][] = [
  ["Item Name", "NDC/UPC", "Current BOH"],
  [null, null, null, "Stock size"],
  ["Fluad 2026-2027 Syringe", "70461002603", 57.5, 0.5], // matches v-fluad by NDC after normalizing dashes
  ["Mpb Mnexspike 0.2ml Pfs 10", "80777040160", 228, 0.2], // unmatched NDC and name
  ["Vaxchora Vial", "00000000000", 0, 100], // 0 BOH is still "reported, 0 on hand"
  ["Duplicate Name Vial", "11111111111", 10, 1],
  ["Duplicate Name Syringe", "22222222222", 5, 0.5], // same raw name, different NDC — must NOT collapse here (that's the recommendation route's job, not the parser's)
];

describe("computeDoses", () => {
  it("rounds BOH / stockSize", () => {
    expect(computeDoses(57.5, 0.5)).toBe(115);
    expect(computeDoses(228, 0.2)).toBe(1140);
  });

  it("returns 0 for a 0-BOH row with a valid stock size (still 'reported, 0 on hand')", () => {
    expect(computeDoses(0, 100)).toBe(0);
  });

  it("returns null when either input is missing", () => {
    expect(computeDoses(null, 0.5)).toBeNull();
    expect(computeDoses(10, null)).toBeNull();
  });

  it("returns null for a non-positive stock size (division by zero/garbage guard)", () => {
    expect(computeDoses(10, 0)).toBeNull();
    expect(computeDoses(10, -1)).toBeNull();
  });
});

describe("looksLikePioneerHeader", () => {
  it("recognizes the real header line", () => {
    expect(looksLikePioneerHeader("Item Name,NDC/UPC,Current BOH")).toBe(true);
    expect(looksLikePioneerHeader("item name\tndc/upc\tcurrent boh")).toBe(true);
  });

  it("does not misfire on an ordinary on-hand line", () => {
    expect(looksLikePioneerHeader("Flu Quad 2025-26, 10")).toBe(false);
    expect(looksLikePioneerHeader("NDC only mentioned here, 5")).toBe(false);
  });
});

describe("parsePioneerBohMatrix", () => {
  it("skips both header rows and blank rows, parsing every data row", () => {
    const rows = parsePioneerBohMatrix(SAMPLE_ROWS);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toEqual({
      rawLine: "Fluad 2026-2027 Syringe | 70461002603 | 57.5 | 0.5",
      vaccineNameRaw: "Fluad 2026-2027 Syringe",
      ndc: "70461002603",
      quantityRaw: 57.5,
      stockSize: 0.5,
      doses: 115,
    });
  });

  it("computes doses for a 0-BOH row", () => {
    const rows = parsePioneerBohMatrix(SAMPLE_ROWS);
    const vaxchora = rows.find((r) => r.vaccineNameRaw === "Vaxchora Vial");
    expect(vaxchora).toMatchObject({ quantityRaw: 0, stockSize: 100, doses: 0 });
  });

  it("keeps two rows with the same name but different NDCs as separate rows", () => {
    const rows = parsePioneerBohMatrix(SAMPLE_ROWS);
    const dupes = rows.filter((r) => r.vaccineNameRaw.startsWith("Duplicate Name"));
    expect(dupes).toHaveLength(2);
    expect(dupes.map((r) => r.ndc).sort()).toEqual(["11111111111", "22222222222"]);
  });

  it("returns [] for an all-header/all-blank matrix", () => {
    expect(parsePioneerBohMatrix([["Item Name", "NDC/UPC"], [null, null]])).toEqual([]);
  });
});

describe("parsePioneerBohXlsx", () => {
  it("parses a real xlsx buffer built with SheetJS", () => {
    const sheet = utils.aoa_to_sheet(SAMPLE_ROWS);
    const workbook = utils.book_new();
    utils.book_append_sheet(workbook, sheet, "Sheet1");
    const buffer = write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;

    const rows = parsePioneerBohXlsx(buffer);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({ vaccineNameRaw: "Fluad 2026-2027 Syringe", ndc: "70461002603", doses: 115 });
  });

  // Legacy .xls (BIFF8) — SES-attachment-mime fix (2026-09-09): PioneerRx
  // may email the report as a legacy .xls (application/vnd.ms-excel)
  // rather than .xlsx. SheetJS's read() auto-detects BIFF8 from the same
  // Buffer path parsePioneerBohXlsx already uses, so this confirms that
  // holds rather than being merely assumed.
  it("parses a legacy .xls (BIFF8) buffer the same way as .xlsx", () => {
    const sheet = utils.aoa_to_sheet(SAMPLE_ROWS);
    const workbook = utils.book_new();
    utils.book_append_sheet(workbook, sheet, "Sheet1");
    const buffer = write(workbook, { type: "buffer", bookType: "biff8" }) as Buffer;

    const rows = parsePioneerBohXlsx(buffer);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({ vaccineNameRaw: "Fluad 2026-2027 Syringe", ndc: "70461002603", doses: 115 });
  });
});

describe("parsePioneerBohDelimited", () => {
  it("parses a comma-delimited csv with the same shape", () => {
    const csv = [
      "Item Name,NDC/UPC,Current BOH",
      ",,,Stock size",
      "Fluad 2026-2027 Syringe,70461002603,57.5,0.5",
    ].join("\n");
    const rows = parsePioneerBohDelimited(csv, ",");
    expect(rows).toEqual([
      {
        rawLine: "Fluad 2026-2027 Syringe | 70461002603 | 57.5 | 0.5",
        vaccineNameRaw: "Fluad 2026-2027 Syringe",
        ndc: "70461002603",
        quantityRaw: 57.5,
        stockSize: 0.5,
        doses: 115,
      },
    ]);
  });

  it("parses a tab-delimited tsv the same way", () => {
    const tsv = ["Item Name\tNDC/UPC\tCurrent BOH", "Fluad 2026-2027 Syringe\t70461002603\t57.5\t0.5"].join("\n");
    const rows = parsePioneerBohDelimited(tsv, "\t");
    expect(rows).toHaveLength(1);
    expect(rows[0].doses).toBe(115);
  });

  it("tolerates a double-quoted field containing the delimiter", () => {
    const csv = ['Item Name,NDC/UPC,Current BOH', '"Fluad, Southern Region",70461002603,57.5,0.5'].join("\n");
    const rows = parsePioneerBohDelimited(csv, ",");
    expect(rows[0].vaccineNameRaw).toBe("Fluad, Southern Region");
  });
});

describe("matchPioneerBohRows", () => {
  it("matches by NDC first, normalizing dashes on the catalog side", () => {
    const rows = parsePioneerBohMatrix(SAMPLE_ROWS);
    const matched = matchPioneerBohRows(rows, CATALOG);
    const fluad = matched.find((r) => r.vaccineNameRaw === "Fluad 2026-2027 Syringe");
    expect(fluad).toMatchObject({ vaccineId: "v-fluad", quantity: 115, matched: true, ndc: "70461002603", stockSize: 0.5 });
  });

  it("falls back to name matching when the NDC doesn't match anything", () => {
    const rows = parsePioneerBohMatrix([
      ["Item Name", "NDC/UPC", "Current BOH", "Stock size"],
      ["Vaxchora Vial", "99999999999", 0, 100],
    ]);
    const matched = matchPioneerBohRows(rows, CATALOG);
    expect(matched[0]).toMatchObject({ vaccineId: "v-vaxchora", matched: true, quantity: 0 });
  });

  it("flags matched:false (but still returns any name-matched vaccineId) when doses can't be computed", () => {
    const rows = parsePioneerBohMatrix([
      ["Item Name", "NDC/UPC", "Current BOH", "Stock size"],
      ["Flu Quad 2025-26", "", 40, null], // no stock size -> doses null
    ]);
    const matched = matchPioneerBohRows(rows, CATALOG);
    expect(matched[0]).toMatchObject({ vaccineId: "v-flu", quantity: null, matched: false });
  });

  it("flags matched:false with a null vaccineId when nothing matches at all", () => {
    const rows = parsePioneerBohMatrix([
      ["Item Name", "NDC/UPC", "Current BOH", "Stock size"],
      ["Totally Unknown Product", "55555555555", 10, 1],
    ]);
    const matched = matchPioneerBohRows(rows, CATALOG);
    expect(matched[0]).toMatchObject({ vaccineId: null, matched: false, ndc: "55555555555" });
  });

  // --- V-onhand-pioneer-ndc-match additions (Will 2026-09-09 4:31pm,
  // from a real 47-line Pioneer BOH PDF: 47 lines, 29 matched, 18
  // unmatched) — two concrete misses from that real file. ---

  describe("PRODUCT-VIEW ndc fallback (real misses from Will's 4:31pm Pioneer PDF)", () => {
    // On-file DB row: name "Comirnaty 2025-26 12+", ndc null here (stale/
    // missing on this fixture's catalog — the real DB row's own ndc is
    // the OLD 2025-26 NDC, "00069252810", which the incoming row's real
    // "00069263110" package NDC does NOT match either way; the point is
    // the DB ndc alone can't resolve this row).
    const comirnatyCatalog: CatalogVaccine[] = [
      { id: "v-comirnaty", name: "Comirnaty 2025-26 12+", short_code: "comirnaty12", ndc: null },
    ];
    // On-file DB row: name "Flucelvax PFS", ndc null (matches
    // supabase/seed/vaccines.sql exactly).
    const flucelvaxCatalog: CatalogVaccine[] = [
      { id: "v-flucelvax-pfs", name: "Flucelvax PFS", short_code: "flucelvaxpfs", ndc: null },
    ];

    it("'Mpb Comirnaty 0.1mg Refr Pfs10' NDC 00069263110 matches Comirnaty via the catalog's researched packageNdc", () => {
      const rows = parsePioneerBohMatrix([
        ["Item Name", "NDC/UPC", "Current BOH", "Stock size"],
        ["Mpb Comirnaty 0.1mg Refr Pfs10", "00069263110", 30, 0.3],
      ]);
      const matched = matchPioneerBohRows(rows, comirnatyCatalog);
      expect(matched[0]).toMatchObject({ vaccineId: "v-comirnaty", matched: true });
    });

    it("'Flucelvax 2026-2027 Syringe' NDC 70461065603 matches Flucelvax PFS via the catalog's researched packageNdc", () => {
      const rows = parsePioneerBohMatrix([
        ["Item Name", "NDC/UPC", "Current BOH", "Stock size"],
        ["Flucelvax 2026-2027 Syringe", "70461065603", 50, 0.5],
      ]);
      const matched = matchPioneerBohRows(rows, flucelvaxCatalog);
      expect(matched[0]).toMatchObject({ vaccineId: "v-flucelvax-pfs", matched: true });
    });

    it("Pioneer name alias: 'Comirnaty' + '0.1mg' matches even with NO ndc cell at all", () => {
      const rows = parsePioneerBohMatrix([
        ["Item Name", "NDC/UPC", "Current BOH", "Stock size"],
        ["Mpb Comirnaty 0.1mg Refr Pfs10", "", 30, 0.3],
      ]);
      const matched = matchPioneerBohRows(rows, comirnatyCatalog);
      expect(matched[0]).toMatchObject({ vaccineId: "v-comirnaty", matched: true });
    });

    it("Pioneer name alias: 'Flucelvax' + '2026-2027' matches Flucelvax PFS specifically, not MDV, with no ndc cell", () => {
      const bothFlucelvax: CatalogVaccine[] = [
        ...flucelvaxCatalog,
        { id: "v-flucelvax-mdv", name: "Flucelvax MDV", short_code: "flucelvaxmdv", ndc: "70461-0323-03" },
      ];
      const rows = parsePioneerBohMatrix([
        ["Item Name", "NDC/UPC", "Current BOH", "Stock size"],
        ["Flucelvax 2026-2027 Syringe", "", 50, 0.5],
      ]);
      const matched = matchPioneerBohRows(rows, bothFlucelvax);
      expect(matched[0]).toMatchObject({ vaccineId: "v-flucelvax-pfs", matched: true });
    });

    it("keeps old-season Comirnaty names UNMATCHED on purpose (no '0.1mg' token, no researched-NDC match)", () => {
      const rows = parsePioneerBohMatrix([
        ["Item Name", "NDC/UPC", "Current BOH", "Stock size"],
        ["Comirnaty Tri '24-25", "", 5, 0.3],
        ["Mpb Comirnaty 2024-25 Pfs10", "", 5, 0.3],
      ]);
      const matched = matchPioneerBohRows(rows, comirnatyCatalog);
      expect(matched[0].vaccineId).toBeNull();
      expect(matched[1].vaccineId).toBeNull();
    });
  });
});

describe("parseOnHandUpload", () => {
  it("dispatches an xlsx payload to the Pioneer matcher", () => {
    const sheet = utils.aoa_to_sheet(SAMPLE_ROWS);
    const workbook = utils.book_new();
    utils.book_append_sheet(workbook, sheet, "Sheet1");
    const buffer = write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;

    const rows = parseOnHandUpload({ kind: "xlsx", buffer }, CATALOG);
    expect(rows).toHaveLength(5);
    expect(rows.some((r) => r.vaccineId === "v-fluad")).toBe(true);
  });

  it("dispatches Pioneer-header'd csv text to the Pioneer matcher", () => {
    const csv = ["Item Name,NDC/UPC,Current BOH,Stock size", "Fluad 2026-2027 Syringe,70461002603,57.5,0.5"].join("\n");
    const rows = parseOnHandUpload({ kind: "text", text: csv }, CATALOG);
    expect(rows).toEqual([
      expect.objectContaining({ vaccineId: "v-fluad", quantity: 115, ndc: "70461002603", stockSize: 0.5 }),
    ]);
  });

  it("dispatches Pioneer-header'd tsv text using a tab delimiter", () => {
    const tsv = ["Item Name\tNDC/UPC\tCurrent BOH\tStock size", "Fluad 2026-2027 Syringe\t70461002603\t57.5\t0.5"].join("\n");
    const rows = parseOnHandUpload({ kind: "text", text: tsv }, CATALOG);
    expect(rows[0]).toMatchObject({ vaccineId: "v-fluad", quantity: 115 });
  });

  it("falls back to the legacy 'VaccineName, Quantity' parser for ordinary text, with ndc/stockSize null", () => {
    const rows = parseOnHandUpload({ kind: "text", text: "Flu Quad 2025-26, 10\nMMR, 15" }, CATALOG);
    expect(rows).toEqual([
      {
        rawLine: "Flu Quad 2025-26, 10",
        vaccineNameRaw: "Flu Quad 2025-26",
        quantity: 10,
        vaccineId: "v-flu",
        matched: true,
        ndc: null,
        stockSize: null,
      },
      {
        rawLine: "MMR, 15",
        vaccineNameRaw: "MMR",
        quantity: 15,
        vaccineId: null,
        matched: false,
        ndc: null,
        stockSize: null,
      },
    ]);
  });
});
