import { describe, expect, it, vi } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { parsePioneerBohPdf } from "@/lib/on-hand/pioneer-boh-pdf";
import { matchPioneerBohRows } from "@/lib/on-hand/pioneer-boh";
import { MAX_UPLOAD_BYTES } from "@/lib/on-hand/upload";
import type { CatalogVaccine } from "@/lib/vaccine-matching";

const CATALOG: CatalogVaccine[] = [
  // Digits-only NDC matches the fixture row's "70461002603" cell EXACTLY
  // (no fuzzy/name fallback involved) — see matchPioneerBohRows test below.
  { id: "v-fluad", name: "Fluad", short_code: "fluad", ndc: "70461-0026-03" },
  { id: "v-vaxchora", name: "Vaxchora", short_code: "vaxchora", ndc: null },
];

const COLUMN_X = { name: 20, ndc: 170, boh: 280, stockSize: 380 };

/**
 * Builds a synthetic 2-page PDF shaped like Pioneer's real BOH export —
 * a 4-column table (Item Name | NDC/UPC | Current BOH | Stock size)
 * with the header repeated on page 2 — covering every row-reconstruction
 * case the brief calls out: an NDC that matches the catalog exactly, a
 * comma-thousands BOH value, a blank Stock size cell, a wrapped
 * (2-line) item name, and a row on the second page after the repeated
 * header.
 */
async function buildFixturePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const size = 9;

  function drawRow(
    page: Awaited<ReturnType<typeof doc.addPage>>,
    y: number,
    cells: Partial<Record<keyof typeof COLUMN_X, string>>
  ) {
    for (const [key, text] of Object.entries(cells)) {
      if (text === undefined) continue;
      page.drawText(text, { x: COLUMN_X[key as keyof typeof COLUMN_X], y, size, font });
    }
  }

  const page1 = doc.addPage([500, 400]);
  drawRow(page1, 380, { name: "Item Name", ndc: "NDC/UPC", boh: "Current BOH", stockSize: "Stock size" });
  // Exact-NDC match, plain numbers.
  drawRow(page1, 360, { name: "Fluad 2026-2027 Syringe", ndc: "70461002603", boh: "57.5", stockSize: "0.5" });
  // Thousands-separator BOH value.
  drawRow(page1, 340, { name: "Comma Dose Vial", ndc: "99999999901", boh: "1,200", stockSize: "1" });
  // Blank Stock size -> treated as 1 dose/unit.
  drawRow(page1, 320, { name: "Blank Stock Vial", ndc: "99999999902", boh: "40" });
  // Wrapped item name: two drawn rows, one output row.
  drawRow(page1, 300, { name: "Wrapped Long Product Name Vial", ndc: "99999999903", boh: "10", stockSize: "2" });
  drawRow(page1, 280, { name: "Extra Descriptor" });

  const page2 = doc.addPage([500, 400]);
  drawRow(page2, 380, { name: "Item Name", ndc: "NDC/UPC", boh: "Current BOH", stockSize: "Stock size" });
  drawRow(page2, 360, { name: "Second Page Vaccine", ndc: "99999999904", boh: "8", stockSize: "4" });

  const bytes = await doc.save();
  return Buffer.from(bytes);
}

describe("parsePioneerBohPdf", () => {
  it("reconstructs every row from a multi-page synthetic PDF", async () => {
    const buffer = await buildFixturePdf();
    const result = await parsePioneerBohPdf(buffer);

    expect(result).not.toBeNull();
    expect(result?.pages).toBe(2);
    expect(result?.headerFound).toBe(true);
    expect(result?.rows).toHaveLength(5);

    const [fluad, comma, blankStock, wrapped, secondPage] = result!.rows;

    expect(fluad).toMatchObject({
      vaccineNameRaw: "Fluad 2026-2027 Syringe",
      ndc: "70461002603",
      quantityRaw: 57.5,
      stockSize: 0.5,
      doses: 115,
    });

    expect(comma).toMatchObject({
      vaccineNameRaw: "Comma Dose Vial",
      quantityRaw: 1200,
      stockSize: 1,
      doses: 1200,
    });

    expect(blankStock).toMatchObject({
      vaccineNameRaw: "Blank Stock Vial",
      quantityRaw: 40,
      stockSize: 1, // blank cell -> 1 dose/unit, not null
      doses: 40,
    });

    expect(wrapped).toMatchObject({
      vaccineNameRaw: "Wrapped Long Product Name Vial Extra Descriptor",
      quantityRaw: 10,
      stockSize: 2,
      doses: 5,
    });

    expect(secondPage).toMatchObject({
      vaccineNameRaw: "Second Page Vaccine",
      quantityRaw: 8,
      stockSize: 4,
      doses: 2,
    });
  });

  it("feeds matchPioneerBohRows unchanged, matching the Fluad row by NDC", async () => {
    const buffer = await buildFixturePdf();
    const result = await parsePioneerBohPdf(buffer);
    const matched = matchPioneerBohRows(result!.rows, CATALOG);

    const fluad = matched.find((r) => r.vaccineNameRaw === "Fluad 2026-2027 Syringe");
    expect(fluad).toMatchObject({ vaccineId: "v-fluad", quantity: 115, matched: true });
  });

  it("tolerates a two-row header (Stock size on its own line, mirroring the xlsx export)", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([500, 300]);
    page.drawText("Item Name", { x: 20, y: 260, size: 9, font });
    page.drawText("NDC/UPC", { x: 170, y: 260, size: 9, font });
    page.drawText("Current BOH", { x: 280, y: 260, size: 9, font });
    page.drawText("Stock size", { x: 380, y: 240, size: 9, font }); // own row, below the main header
    page.drawText("Vaxchora Vial", { x: 20, y: 220, size: 9, font });
    page.drawText("00000000000", { x: 170, y: 220, size: 9, font });
    page.drawText("100", { x: 280, y: 220, size: 9, font });
    page.drawText("5", { x: 380, y: 220, size: 9, font });
    const buffer = Buffer.from(await doc.save());

    const result = await parsePioneerBohPdf(buffer);
    expect(result?.headerFound).toBe(true);
    expect(result?.rows).toHaveLength(1);
    expect(result?.rows[0]).toMatchObject({ vaccineNameRaw: "Vaxchora Vial", quantityRaw: 100, stockSize: 5, doses: 20 });
  });

  it("returns null (and never echoes the input bytes) for a non-PDF buffer", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await parsePioneerBohPdf(Buffer.from("this is definitely not a pdf file"));
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    for (const call of warnSpy.mock.calls) {
      for (const arg of call) {
        expect(String(arg)).not.toContain("definitely not a pdf");
      }
    }
    warnSpy.mockRestore();
  });

  it("logs the document-load error's constructor name AND message (2026-09-09 Vercel incident: bare '(Error)' with no message gave no signal)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await parsePioneerBohPdf(Buffer.from("this is definitely not a pdf file"));
    // pdfjs's own document-load error for malformed input — a fixed,
    // generic message describing pdfjs's own parsing state, never
    // attacker-controlled bytes (see the module doc comment's guard
    // list and errorMessage()'s doc comment for why this ONE call site
    // is safe to log .message on).
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("InvalidPDFException"));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/InvalidPDFException\):.+\S/));
    warnSpy.mockRestore();
  });

  it("returns null without invoking pdfjs for a buffer over the 2 MB cap", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const oversized = Buffer.alloc(MAX_UPLOAD_BYTES + 1, 0x41);
    const result = await parsePioneerBohPdf(oversized);
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("skipping oversized PDF"));
    warnSpy.mockRestore();
  });

  describe("footer guard", () => {
    it("drops a pagination/footer-text row (matches FOOTER_LINE_PATTERN) instead of merging it into the previous name, even on a non-last page", async () => {
      const doc = await PDFDocument.create();
      const font = await doc.embedFont(StandardFonts.Helvetica);

      const page1 = doc.addPage([500, 400]);
      page1.drawText("Item Name", { x: 20, y: 380, size: 9, font });
      page1.drawText("NDC/UPC", { x: 170, y: 380, size: 9, font });
      page1.drawText("Current BOH", { x: 280, y: 380, size: 9, font });
      page1.drawText("Stock size", { x: 380, y: 380, size: 9, font });
      page1.drawText("Widget A", { x: 20, y: 360, size: 9, font });
      page1.drawText("70461002603", { x: 170, y: 360, size: 9, font });
      page1.drawText("10", { x: 280, y: 360, size: 9, font });
      page1.drawText("1", { x: 380, y: 360, size: 9, font });
      // A pagination line directly below the last data row on page 1 —
      // page 1 is NOT the last page, so only the regex clause (not the
      // below-last-numeric-row-on-the-last-page clause) can catch this.
      page1.drawText("Page 1 of 2", { x: 20, y: 340, size: 9, font });

      const page2 = doc.addPage([500, 400]);
      page2.drawText("Item Name", { x: 20, y: 380, size: 9, font });
      page2.drawText("NDC/UPC", { x: 170, y: 380, size: 9, font });
      page2.drawText("Current BOH", { x: 280, y: 380, size: 9, font });
      page2.drawText("Stock size", { x: 380, y: 380, size: 9, font });
      page2.drawText("Widget B", { x: 20, y: 360, size: 9, font });
      page2.drawText("99999999999", { x: 170, y: 360, size: 9, font });
      page2.drawText("20", { x: 280, y: 360, size: 9, font });
      page2.drawText("2", { x: 380, y: 360, size: 9, font });

      const buffer = Buffer.from(await doc.save());
      const result = await parsePioneerBohPdf(buffer);

      expect(result?.rows).toHaveLength(2);
      const names = result!.rows.map((r) => r.vaccineNameRaw);
      expect(names).toEqual(["Widget A", "Widget B"]);
      expect(names.join(" ")).not.toContain("Page 1 of 2");
    });

    it("drops a trailing text-only row below the last numeric row on the LAST page, even when it doesn't match FOOTER_LINE_PATTERN", async () => {
      const doc = await PDFDocument.create();
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const page = doc.addPage([500, 400]);
      page.drawText("Item Name", { x: 20, y: 380, size: 9, font });
      page.drawText("NDC/UPC", { x: 170, y: 380, size: 9, font });
      page.drawText("Current BOH", { x: 280, y: 380, size: 9, font });
      page.drawText("Stock size", { x: 380, y: 380, size: 9, font });
      page.drawText("Widget C", { x: 20, y: 360, size: 9, font });
      page.drawText("11111111111", { x: 170, y: 360, size: 9, font });
      page.drawText("30", { x: 280, y: 360, size: 9, font });
      page.drawText("3", { x: 380, y: 360, size: 9, font });
      // Trailing boilerplate that does NOT match FOOTER_LINE_PATTERN —
      // only the "below the last numeric row on the last page" clause
      // catches this one.
      page.drawText("Thank you for choosing Pioneer", { x: 20, y: 340, size: 9, font });

      const buffer = Buffer.from(await doc.save());
      const result = await parsePioneerBohPdf(buffer);

      expect(result?.rows).toHaveLength(1);
      expect(result?.rows[0].vaccineNameRaw).toBe("Widget C");
    });

    it("still merges a genuine wrapped item name on a non-last page (no regression)", async () => {
      // Covered by the multi-page fixture above ("Wrapped Long Product
      // Name Vial" + "Extra Descriptor" on page 1, which is not the
      // last page) — re-asserted here for clarity against the footer
      // guard's isLastPage condition.
      const buffer = await buildFixturePdf();
      const result = await parsePioneerBohPdf(buffer);
      const wrapped = result!.rows.find((r) => r.vaccineNameRaw.startsWith("Wrapped"));
      expect(wrapped?.vaccineNameRaw).toBe("Wrapped Long Product Name Vial Extra Descriptor");
    });
  });
});
