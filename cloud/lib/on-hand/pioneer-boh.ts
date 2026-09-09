import { read, utils } from "xlsx";
import { normalizeNdc } from "@/lib/ndc";
import { matchVaccineName, type CatalogVaccine } from "@/lib/vaccine-matching";
import { parseOnHandContent } from "@/lib/on-hand-parser";

/**
 * Pioneer "current BOH" (beyond-on-hand) stock report parser
 * (V-ordering-targets, Will 2026-09-08). This is a DIFFERENT shape from
 * the original "VaccineName, Quantity" on-hand email lines
 * (lib/on-hand-parser.ts) — Pioneer's real export is a table:
 *
 *   Item Name | NDC/UPC | Current BOH | (blank) | (blank)
 *   (blank)   | (blank) | (blank)     | Stock size
 *   Fluad 2026-2027 Syringe | 70461002603 | 57.5 | 0.5
 *   ...
 *
 * "Current BOH" is in mL/units; "Stock size" is the per-dose size, so
 * doses on hand = round(BOH / stock size) (Fluad: 57.5 / 0.5 = 115
 * doses). The header spans TWO rows (Stock size lands on row 2, under a
 * blank 4th column on row 1) — parsePioneerBohMatrix tolerates both
 * header rows by skipping any row that LOOKS like a header (contains
 * "item name" or "ndc"/"stock size" text) rather than assuming a fixed
 * row count to skip.
 *
 * Same parser handles xlsx (parsePioneerBohXlsx, via SheetJS) and
 * csv/tsv (parsePioneerBohDelimited) — both funnel into
 * parsePioneerBohMatrix, which works on a plain 2D array of cells so the
 * two input shapes share every bit of row-interpretation logic.
 */

export type PioneerBohRow = {
  /** The row's cells joined with " | ", for storage in
   * on_hand_count.raw_line — mirrors the on-hand-parser's rawLine, just
   * for a table row instead of a text line. */
  rawLine: string;
  vaccineNameRaw: string;
  /** Digits-only NDC (lib/ndc.ts normalizeNdc), or null if the NDC cell
   * was blank/unparseable. */
  ndc: string | null;
  /** The "Current BOH" cell, as given (mL/units, not doses) — null if
   * blank or not a number. */
  quantityRaw: number | null;
  /** The "Stock size" cell (per-dose size) — null if blank or not a
   * number. */
  stockSize: number | null;
  /** round(quantityRaw / stockSize) — null when either input is missing
   * or stockSize is not a positive number (division by zero/garbage). */
  doses: number | null;
};

/** Extended ParsedOnHandLine shape (lib/on-hand-parser.ts) with the two
 * new columns 0011 adds to on_hand_count — null for a legacy plain-text
 * line, populated for a Pioneer table row. This is the ONE shape both
 * upload paths (POST /api/on-hand/upload and the SES webhook) build
 * insertable on_hand_count rows from — see lib/on-hand/insert.ts. */
export type MatchedOnHandRow = {
  rawLine: string;
  vaccineNameRaw: string;
  quantity: number | null;
  vaccineId: string | null;
  matched: boolean;
  ndc: string | null;
  stockSize: number | null;
};

function isHeaderRow(cells: unknown[]): boolean {
  return cells.some((cell) => {
    if (typeof cell !== "string") return false;
    const lower = cell.toLowerCase();
    return lower.includes("item name") || lower.includes("ndc") || lower.includes("stock size");
  });
}

function cellToString(cell: unknown): string {
  if (cell === null || cell === undefined) return "";
  return String(cell).trim();
}

function cellToNumber(cell: unknown): number | null {
  if (typeof cell === "number" && Number.isFinite(cell)) return cell;
  if (typeof cell === "string" && cell.trim() !== "") {
    const parsed = Number(cell.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function computeDoses(quantityRaw: number | null, stockSize: number | null): number | null {
  if (quantityRaw === null || stockSize === null || stockSize <= 0) return null;
  return Math.round(quantityRaw / stockSize);
}

/**
 * Interprets a plain 2D array of cells (row-major, from either SheetJS's
 * sheet_to_json({header:1}) or a hand-split csv/tsv line) as Pioneer BOH
 * rows. Skips header rows (see isHeaderRow) and fully blank rows (e.g.
 * the second header row's leading blank cells before "Stock size"),
 * wherever they fall — this is what makes the two-row header tolerant of
 * both rows landing anywhere near the top rather than assuming a fixed
 * skip count.
 */
export function parsePioneerBohMatrix(matrix: unknown[][]): PioneerBohRow[] {
  const rows: PioneerBohRow[] = [];

  for (const cells of matrix) {
    if (!cells || cells.length === 0) continue;
    if (isHeaderRow(cells)) continue;

    const name = cellToString(cells[0]);
    if (!name) continue; // blank row

    const ndc = normalizeNdc(cellToString(cells[1]) || null);
    const quantityRaw = cellToNumber(cells[2]);
    const stockSize = cellToNumber(cells[3]);
    const doses = computeDoses(quantityRaw, stockSize);

    rows.push({
      rawLine: [name, ndc ?? "", quantityRaw ?? "", stockSize ?? ""].join(" | "),
      vaccineNameRaw: name,
      ndc,
      quantityRaw,
      stockSize,
      doses,
    });
  }

  return rows;
}

export function parsePioneerBohXlsx(buffer: Buffer): PioneerBohRow[] {
  const workbook = read(buffer, { type: "buffer" });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return [];
  const sheet = workbook.Sheets[sheetName];
  const matrix = utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, raw: true });
  return parsePioneerBohMatrix(matrix);
}

/** Minimal delimited-line splitter that tolerates a double-quoted field
 * containing the delimiter (Excel's own csv export quotes such fields) —
 * a full RFC 4180 parser is more than this table needs. */
function splitDelimitedLine(line: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

export function parsePioneerBohDelimited(text: string, delimiter: "," | "\t"): PioneerBohRow[] {
  const lines = text.split(/\r\n|\r|\n/).filter((line) => line.trim().length > 0);
  const matrix = lines.map((line) => splitDelimitedLine(line, delimiter));
  return parsePioneerBohMatrix(matrix);
}

/**
 * True when `line` looks like the Pioneer table's header row ("Item
 * Name | NDC/UPC | Current BOH | ..."), used to decide whether an
 * uploaded/emailed text body is this table format at all, vs. the
 * legacy "VaccineName, Quantity" lines lib/on-hand-parser.ts already
 * handles. Requires BOTH "item name" and "ndc" so an ordinary on-hand
 * line that happens to contain the word "ndc" doesn't misfire.
 */
export function looksLikePioneerHeader(line: string): boolean {
  const lower = line.toLowerCase();
  return lower.includes("item name") && lower.includes("ndc");
}

/**
 * Matches parsed Pioneer rows against the vaccine catalog: by NDC first
 * (digits-only comparison — lib/ndc.ts), falling back to the existing
 * free-text name matcher (lib/vaccine-matching.ts's matchVaccineName)
 * when the NDC doesn't match anything (or the row/catalog has no NDC at
 * all). `matched` requires both a catalog match AND a computable dose
 * count — a row with an unparseable BOH/stock-size still gets a
 * vaccine_id when its NDC/name is recognized, but is flagged unmatched
 * so it surfaces for manual review rather than silently persisting a
 * null quantity as if it were legitimate.
 */
export function matchPioneerBohRows(rows: PioneerBohRow[], catalog: CatalogVaccine[]): MatchedOnHandRow[] {
  return rows.map((row) => {
    let vaccineId: string | null = null;

    if (row.ndc) {
      const byNdc = catalog.find((vaccine) => normalizeNdc(vaccine.ndc) === row.ndc);
      if (byNdc) vaccineId = byNdc.id;
    }
    if (!vaccineId) {
      const byName = matchVaccineName(row.vaccineNameRaw, catalog);
      if (byName) vaccineId = byName.id;
    }

    return {
      rawLine: row.rawLine,
      vaccineNameRaw: row.vaccineNameRaw,
      quantity: row.doses,
      vaccineId,
      matched: vaccineId !== null && row.doses !== null,
      ndc: row.ndc,
      stockSize: row.stockSize,
    };
  });
}

export type UploadPayload = { kind: "text"; text: string } | { kind: "xlsx"; buffer: Buffer };

/**
 * Single entry point both POST /api/on-hand/upload and the SES webhook
 * funnel their extracted payload through (Will's brief: "extended...to
 * accept... used by the same entry point"). Dispatches on shape:
 *   - xlsx buffer -> parsePioneerBohXlsx
 *   - text whose first non-blank line looks like the Pioneer header ->
 *     parsePioneerBohDelimited (tab-delimited if the header line has a
 *     tab in it, comma-delimited otherwise)
 *   - any other text -> the legacy lib/on-hand-parser.ts line format,
 *     with ndc/stockSize simply null (0011's new columns don't apply to
 *     a hand-typed "VaccineName, Quantity" line).
 */
export function parseOnHandUpload(payload: UploadPayload, catalog: CatalogVaccine[]): MatchedOnHandRow[] {
  if (payload.kind === "xlsx") {
    return matchPioneerBohRows(parsePioneerBohXlsx(payload.buffer), catalog);
  }

  const firstLine = payload.text.split(/\r\n|\r|\n/).find((line) => line.trim().length > 0) ?? "";
  if (looksLikePioneerHeader(firstLine)) {
    const delimiter: "," | "\t" = firstLine.includes("\t") ? "\t" : ",";
    return matchPioneerBohRows(parsePioneerBohDelimited(payload.text, delimiter), catalog);
  }

  return parseOnHandContent(payload.text, catalog).map((line) => ({ ...line, ndc: null, stockSize: null }));
}
