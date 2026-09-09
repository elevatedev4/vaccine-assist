/**
 * Pioneer "current BOH" PDF extractor (V-boh-pdf-attachment, 2026-09-09).
 *
 * PioneerRx's scheduled "AppExport: Vaccine BOH" email attaches a PDF
 * export of the SAME table the manual xlsx/csv upload path already
 * parses (lib/on-hand/pioneer-boh.ts: Item Name | NDC/UPC | Current BOH
 * | Stock size). A PDF has no cell/row structure at all — SheetJS can't
 * touch it — so this module reconstructs the table from raw glyph
 * positions using `pdfjs-dist`'s text-extraction API (no rendering, no
 * canvas, no worker thread: the "legacy" ESM build auto-detects Node and
 * runs the (lightweight) parsing/text-extraction path synchronously in
 * the same thread, which is all this needs).
 *
 * Row reconstruction, in order:
 *   1. Every page's text items (each carrying a glyph run's string and
 *      its `x`/`y` baseline position, from `getTextContent()`'s
 *      transform matrix) are clustered into rows by `y`, tolerating
 *      ROW_Y_TOLERANCE points of jitter between items that are visually
 *      on the same line (different fonts/baselines within one row don't
 *      land on the exact same y).
 *   2. Each row's items are sorted left-to-right by `x`.
 *   3. A row is recognized as a HEADER when it contains both a
 *      "name" token ("Item Name" or "Item") and a "boh" token ("Current
 *      BOH" or "BOH") — same two required signals
 *      lib/on-hand/pioneer-boh.ts's isHeaderRow uses for xlsx/csv. "ndc"
 *      and "stockSize" tokens are optional and, when present, set that
 *      column's x-anchor too. Mirroring the real xlsx export's two-row
 *      header (Stock size lands on its OWN row under a blank 4th
 *      column — see pioneer-boh.ts's doc comment), a header row missing
 *      a stockSize token also consumes the NEXT row when that row is a
 *      lone "stock size" token and nothing else.
 *   4. Every row after a header (until the next header, e.g. a repeated
 *      header on page 2+) is a DATA row: each of its items is assigned
 *      to whichever header column's x-anchor is closest, and items
 *      assigned to the same column are joined (in x order) into that
 *      cell's text — this is what lets a cell that PDF-rendering split
 *      into multiple glyph runs (e.g. "Fluad" / "2026-2027" / "Syringe"
 *      as three separate text items) still reconstruct as one cell.
 *   5. A data row with ONLY a name cell (no boh/ndc/stockSize text at
 *      all) is a WRAPPED item name — Pioneer's PDF export wraps a long
 *      product name onto a second line rather than widening the column
 *      — and is appended onto the previous row's vaccineNameRaw instead
 *      of becoming its own row.
 *   6. Numeric cells (Current BOH, Stock size) tolerate a trailing unit
 *      ("57.5 mL") and thousands separators ("1,200") — commas are
 *      stripped, then the leading numeric run is parsed, ignoring
 *      anything after it. A blank Stock size cell is NOT the same as a
 *      blank xlsx/csv stock-size cell (which computeDoses treats as
 *      "can't compute doses, flag unmatched"): the brief for this PDF
 *      path is explicit that a blank Stock size means "1 dose per
 *      unit" — Pioneer's PDF export appears to omit Stock size when
 *      it's trivially 1, unlike the xlsx/csv export which always prints
 *      it.
 *
 * Output shape: PioneerBohRow[] (lib/on-hand/pioneer-boh.ts), the exact
 * same rows parsePioneerBohXlsx/parsePioneerBohDelimited build, so
 * callers keep using matchPioneerBohRows(result.rows, catalog) UNCHANGED
 * — this module never touches vaccine matching.
 *
 * Guards (this is a machine-to-machine webhook path, reachable by
 * anyone who learns a per-account inbound address — same posture as the
 * xlsx/csv attachment path's MAX_UPLOAD_BYTES gate in
 * app/api/webhooks/ses/route.ts):
 *   - buffer.length > MAX_UPLOAD_BYTES (2 MB, same cap as xlsx/csv) ->
 *     null, checked BEFORE pdfjs ever touches the buffer.
 *   - pdf.numPages > MAX_PDF_PAGES (50) -> null, checked after pdfjs
 *     parses just the document structure (page count), before any
 *     per-page text extraction work.
 *   - ANY exception pdfjs throws (malformed PDF, unsupported feature,
 *     etc.) -> null, logged as the exception's constructor name ONLY
 *     (never `.message`, which could echo back attacker-controlled
 *     bytes from a malformed PDF into logs).
 * `null` in every case means "give up cleanly" — the caller
 * (app/api/webhooks/ses/route.ts's processOnHandAttachment) falls back
 * to the plain-text body path exactly as it already does for an
 * oversized xlsx/csv attachment.
 */

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { normalizeNdc } from "@/lib/ndc";
import { MAX_UPLOAD_BYTES } from "@/lib/on-hand/upload";
import { computeDoses, type PioneerBohRow } from "@/lib/on-hand/pioneer-boh";

/** Same 2 MB cap the xlsx/csv attachment path enforces (MAX_UPLOAD_BYTES) —
 * a decoded-byte-size gate, checked before pdfjs ever sees the buffer. */
const MAX_PDF_BYTES = MAX_UPLOAD_BYTES;

/** Bounds the per-page text-extraction work done on a malformed/adversarial
 * PDF (a legitimate BOH export is a handful of pages) — same spirit as
 * ses-mime.ts's MAX_MIME_DEPTH. */
const MAX_PDF_PAGES = 50;

/** How many points of y-jitter between two text items counts as "the
 * same visual row" — the brief's "~2-3 pt" range; 2.5 splits the
 * difference. */
const ROW_Y_TOLERANCE = 2.5;

export type PioneerBohPdfResult = {
  rows: PioneerBohRow[];
  pages: number;
  headerFound: boolean;
};

type PdfTextItem = { str: string; x: number; y: number };

type HeaderKey = "name" | "ndc" | "boh" | "stockSize";
type HeaderColumns = Partial<Record<HeaderKey, number>>;

/** Classifies a single text item's string as a header column, or null
 * if it doesn't look like any recognized header token. Order matters:
 * "stock size"/"pkg size" and "ndc" are checked before the broader
 * "boh"/"item" substring checks so e.g. "NDC/UPC" (which also happens
 * not to contain "boh" or "item") only ever matches one key. */
function classifyHeaderToken(text: string): HeaderKey | null {
  const lower = text.toLowerCase().trim();
  if (!lower) return null;
  if (lower.includes("stock size") || lower.includes("pkg size")) return "stockSize";
  if (lower.includes("ndc")) return "ndc";
  if (lower.includes("current boh") || lower.includes("boh")) return "boh";
  if (lower.includes("item name") || lower === "item") return "name";
  return null;
}

/** Scans a row (already x-sorted) for header tokens, keeping the
 * LEFTMOST x for each key (a header cell can be more than one text
 * item, e.g. "Item" then "Name" as separate glyph runs). */
function detectHeaderColumns(row: PdfTextItem[]): HeaderColumns {
  const found: HeaderColumns = {};
  for (const item of row) {
    const key = classifyHeaderToken(item.str);
    if (key && found[key] === undefined) found[key] = item.x;
  }
  return found;
}

/** True when a row's detected header tokens are ONLY a stockSize token
 * (used to recognize the xlsx export's real-world two-row header
 * pattern — "Stock size" landing alone on the row under the main
 * header — reproduced in the PDF export too). */
function isLoneStockSizeRow(columns: HeaderColumns): boolean {
  return columns.stockSize !== undefined && columns.name === undefined && columns.boh === undefined && columns.ndc === undefined;
}

/** Clusters a page's text items into visual rows by y-position
 * (descending — PDF y grows upward, so the first row is the highest
 * y), then sorts each row's items left-to-right by x. Whitespace-only
 * items are dropped before clustering — they carry no column signal
 * and would otherwise perturb the y-tolerance grouping. */
function clusterRows(items: PdfTextItem[]): PdfTextItem[][] {
  const sorted = [...items].filter((item) => item.str.trim().length > 0).sort((a, b) => b.y - a.y || a.x - b.x);

  const rows: PdfTextItem[][] = [];
  let current: PdfTextItem[] = [];
  let refY: number | null = null;

  for (const item of sorted) {
    if (refY === null || Math.abs(item.y - refY) <= ROW_Y_TOLERANCE) {
      current.push(item);
      if (refY === null) refY = item.y;
    } else {
      rows.push(current);
      current = [item];
      refY = item.y;
    }
  }
  if (current.length > 0) rows.push(current);

  return rows.map((row) => row.sort((a, b) => a.x - b.x));
}

/** Assigns each item in a data row to its nearest header column (by x
 * distance) and joins same-column items (already x-ordered) with a
 * space, reconstructing each cell's text even when pdfjs split it into
 * multiple glyph runs. */
function assignCells(row: PdfTextItem[], columns: [HeaderKey, number][]): Record<HeaderKey, string> {
  const cells: Record<HeaderKey, string[]> = { name: [], ndc: [], boh: [], stockSize: [] };

  for (const item of row) {
    let bestKey: HeaderKey = columns[0][0];
    let bestDist = Infinity;
    for (const [key, x] of columns) {
      const dist = Math.abs(item.x - x);
      if (dist < bestDist) {
        bestDist = dist;
        bestKey = key;
      }
    }
    cells[bestKey].push(item.str);
  }

  return {
    name: cells.name.join(" ").trim(),
    ndc: cells.ndc.join(" ").trim(),
    boh: cells.boh.join(" ").trim(),
    stockSize: cells.stockSize.join(" ").trim(),
  };
}

/** Parses a numeric cell that may carry thousands separators ("1,200")
 * and/or a trailing unit ("57.5 mL") — strips commas, then takes the
 * leading numeric run and ignores everything after it. Returns null for
 * a blank cell or one with no numeric content at all. */
function parseNumericCell(text: string): number | null {
  if (!text) return null;
  const cleaned = text.replace(/,/g, "");
  const match = cleaned.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildRawLine(name: string, ndc: string | null, quantityRaw: number | null, stockSize: number | null): string {
  return [name, ndc ?? "", quantityRaw ?? "", stockSize ?? ""].join(" | ");
}

/** Returns the exception's constructor name only (e.g. "Error",
 * "InvalidPDFException") — never `.message`, which for a malformed PDF
 * could echo back attacker-controlled byte content into logs. */
function errorClassName(err: unknown): string {
  if (err instanceof Error) return err.constructor.name || "Error";
  return typeof err;
}

/**
 * Extracts Pioneer BOH rows from a PDF export. Returns null on any
 * guard trip or pdfjs exception (see module doc comment) — the caller
 * falls back to the plain-text body path. A non-null result can still
 * carry `headerFound: false` / `rows: []` when the PDF parsed cleanly
 * but no page's table matched the expected header shape (e.g. an
 * unrelated PDF attachment) — that's not an exception, just "nothing to
 * ingest", left for the caller to log/summarize rather than silently
 * treated the same as a hard failure.
 */
export async function parsePioneerBohPdf(buffer: Buffer): Promise<PioneerBohPdfResult | null> {
  if (buffer.length > MAX_PDF_BYTES) {
    console.warn(`parsePioneerBohPdf: skipping oversized PDF (${buffer.length} bytes > ${MAX_PDF_BYTES} max)`);
    return null;
  }

  let numPages: number;
  let getPage: (pageNumber: number) => Promise<{ getTextContent: () => Promise<{ items: unknown[] }> }>;
  try {
    const loadingTask = getDocument({
      data: new Uint8Array(buffer),
      useWorkerFetch: false,
      disableFontFace: true,
      verbosity: 0,
    });
    const pdf = await loadingTask.promise;
    numPages = pdf.numPages;
    getPage = (pageNumber: number) => pdf.getPage(pageNumber) as unknown as Promise<{ getTextContent: () => Promise<{ items: unknown[] }> }>;
  } catch (err) {
    console.warn(`parsePioneerBohPdf: pdfjs failed to load the document (${errorClassName(err)})`);
    return null;
  }

  if (numPages > MAX_PDF_PAGES) {
    console.warn(`parsePioneerBohPdf: skipping PDF with ${numPages} pages > ${MAX_PDF_PAGES} max`);
    return null;
  }

  try {
    const rows: PioneerBohRow[] = [];
    let columns: [HeaderKey, number][] | null = null;
    let headerFound = false;
    let lastRow: PioneerBohRow | null = null;

    for (let pageNumber = 1; pageNumber <= numPages; pageNumber++) {
      const page = await getPage(pageNumber);
      const content = await page.getTextContent();
      const items: PdfTextItem[] = content.items
        .map((raw) => {
          const item = raw as { str?: unknown; transform?: unknown };
          if (typeof item.str !== "string" || !Array.isArray(item.transform) || item.transform.length < 6) return null;
          const transform = item.transform as number[];
          return { str: item.str, x: transform[4], y: transform[5] };
        })
        .filter((item): item is PdfTextItem => item !== null);

      const pageRows = clusterRows(items);

      let i = 0;
      while (i < pageRows.length) {
        const row = pageRows[i];
        const headerCols = detectHeaderColumns(row);

        if (headerCols.name !== undefined && headerCols.boh !== undefined) {
          headerFound = true;
          // The real xlsx export's "Stock size" header lands on its OWN
          // row (see this module's doc comment) — reproduce that
          // tolerance for the PDF export too.
          if (headerCols.stockSize === undefined && i + 1 < pageRows.length) {
            const nextCols = detectHeaderColumns(pageRows[i + 1]);
            if (isLoneStockSizeRow(nextCols)) {
              headerCols.stockSize = nextCols.stockSize;
              i++; // consume the continuation row
            }
          }
          columns = (Object.entries(headerCols) as [HeaderKey, number | undefined][])
            .filter((entry): entry is [HeaderKey, number] => entry[1] !== undefined);
          i++;
          continue;
        }

        if (!columns) {
          // Stray text above/around the table before any header has
          // been seen (a title, a generated-at timestamp, ...) — no
          // columns to assign it to yet.
          i++;
          continue;
        }

        const cells = assignCells(row, columns);
        const name = cells.name;
        if (!name) {
          i++;
          continue;
        }

        const hasOtherData = Boolean(cells.boh || cells.ndc || cells.stockSize);
        if (!hasOtherData && lastRow) {
          // Wrapped item name — continues the previous row rather than
          // starting a new one.
          lastRow.vaccineNameRaw = `${lastRow.vaccineNameRaw} ${name}`.trim();
          lastRow.rawLine = buildRawLine(lastRow.vaccineNameRaw, lastRow.ndc, lastRow.quantityRaw, lastRow.stockSize);
          i++;
          continue;
        }

        const ndc = normalizeNdc(cells.ndc || null);
        const quantityRaw = parseNumericCell(cells.boh);
        const parsedStockSize = parseNumericCell(cells.stockSize);
        // Blank Stock size on this PDF path means "1 dose per unit" —
        // see the module doc comment; this is deliberately DIFFERENT
        // from the xlsx/csv matrix path, where a blank stock size stays
        // null (-> unmatched, flagged for manual review).
        const stockSize = parsedStockSize === null ? 1 : parsedStockSize;
        const doses = computeDoses(quantityRaw, stockSize);

        const newRow: PioneerBohRow = {
          rawLine: buildRawLine(name, ndc, quantityRaw, stockSize),
          vaccineNameRaw: name,
          ndc,
          quantityRaw,
          stockSize,
          doses,
        };
        rows.push(newRow);
        lastRow = newRow;
        i++;
      }
    }

    return { rows, pages: numPages, headerFound };
  } catch (err) {
    console.warn(`parsePioneerBohPdf: pdfjs failed while extracting text (${errorClassName(err)})`);
    return null;
  }
}
