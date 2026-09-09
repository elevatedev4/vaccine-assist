import { read, utils } from "xlsx";
import { normalizeNdc } from "@/lib/ndc";
import { matchVaccineName, type CatalogVaccine } from "@/lib/vaccine-matching";
import { parseOnHandContent } from "@/lib/on-hand-parser";
import { deriveProductViewFields } from "@/lib/product-view";

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

/** The shared product-view's effective NDC for a catalog vaccine — its
 * own DB ndc when present, else the researched static-catalog
 * packageNdc (lib/product-view.ts's deriveProductViewFields, same
 * fields the Ordering/Lots pages show). Used by matchPioneerBohRows'
 * fallback NDC match below. */
function effectiveNdcForCatalogVaccine(vaccine: CatalogVaccine): string | null {
  return deriveProductViewFields(vaccine.name, normalizeNdc(vaccine.ndc)).ndc;
}

/**
 * Pioneer-specific item-name aliases (V-onhand-pioneer-ndc-match, Will
 * 2026-09-09 4:31pm, from a real 47-line Pioneer BOH PDF: 18 unmatched
 * rows). Pioneer's "Item Name" cell carries store-specific prefix/suffix
 * noise ("Mpb Comirnaty 0.1mg Refr Pfs10", "Flucelvax 2026-2027
 * Syringe") that lib/vaccine-matching.ts's plain contains/alias matcher
 * doesn't resolve — this is a SEPARATE small alias table, not an
 * addition to lib/vaccine-matching.ts's shared NAME_ALIASES, for the
 * same reason app/api/ordering/recommendation/route.ts keeps its own
 * COMPOSITE_BASE_TO_CATALOG_NAME out of that shared table (see that
 * route's doc comment): these patterns are specific to Pioneer's export
 * format, not a general vaccine-name variant Will might type anywhere
 * else.
 *
 * Each entry requires ALL of `requiredTokens` (case-insensitive
 * substring) to be present in the raw item name before it's even
 * considered, so an OLD-season line ("Comirnaty Tri '24-25", "Comirnaty
 * 2024-25", "Comirnaty 2025-26") that doesn't also carry "0.1mg" stays
 * UNMATCHED here on purpose (Will's brief: "keep old-season names ...
 * UNMATCHED on purpose") — this alias table intentionally does NOT fall
 * back to a bare "comirnaty"/"flucelvax" substring match.
 */
const PIONEER_NAME_ALIASES: { requiredTokens: string[]; matchesCatalogName: (name: string) => boolean }[] = [
  {
    // "Mpb Comirnaty 0.1mg Refr Pfs10" -> the on-file Comirnaty row.
    // matchesCatalogName uses a name-PREFIX check (not an exact string)
    // so this keeps matching through the on-file name's expected
    // "2025-26" -> "2026-27" rename (same namePrefix tolerance
    // lib/vaccine-product-catalog.ts's Comirnaty row already uses).
    requiredTokens: ["comirnaty", "0.1mg"],
    matchesCatalogName: (name) => name.trim().toLowerCase().startsWith("comirnaty"),
  },
  {
    // "Flucelvax 2026-2027 Syringe" -> "Flucelvax PFS" specifically (a
    // prefilled Syringe, not the MDV multi-dose vial) — exact name match
    // so this can never accidentally resolve to "Flucelvax MDV".
    requiredTokens: ["flucelvax", "2026-2027"],
    matchesCatalogName: (name) => name.trim().toLowerCase() === "flucelvax pfs",
  },
];

function matchByPioneerNameAlias(rawName: string, catalog: CatalogVaccine[]): CatalogVaccine | null {
  const lower = rawName.toLowerCase();
  for (const alias of PIONEER_NAME_ALIASES) {
    if (!alias.requiredTokens.every((token) => lower.includes(token))) continue;
    const found = catalog.find((vaccine) => alias.matchesCatalogName(vaccine.name));
    if (found) return found;
  }
  return null;
}

/**
 * Matches parsed Pioneer rows against the vaccine catalog, in order:
 *   1. Exact DB-ndc match (digits-only comparison — lib/ndc.ts).
 *   2. The shared PRODUCT VIEW's ndc (lib/product-view.ts) — a row whose
 *      DB vaccine.ndc is stale/missing still lands on the right product
 *      when its real package NDC matches the one this app already
 *      researched (e.g. Comirnaty 2026-27's "00069263110", Flucelvax
 *      PFS's "70461065603" — see this file's header comment).
 *   3. The Pioneer-specific name aliases above (matchByPioneerNameAlias)
 *      — for a row whose NDC cell is blank/garbled but whose item name
 *      still identifies the product unambiguously.
 *   4. The existing free-text name matcher (lib/vaccine-matching.ts's
 *      matchVaccineName), same as before this change.
 * `matched` requires both a catalog match AND a computable dose count —
 * a row with an unparseable BOH/stock-size still gets a vaccine_id when
 * its NDC/name is recognized, but is flagged unmatched so it surfaces
 * for manual review rather than silently persisting a null quantity as
 * if it were legitimate.
 */
export function matchPioneerBohRows(rows: PioneerBohRow[], catalog: CatalogVaccine[]): MatchedOnHandRow[] {
  return rows.map((row) => {
    let vaccineId: string | null = null;

    if (row.ndc) {
      const byNdc = catalog.find((vaccine) => normalizeNdc(vaccine.ndc) === row.ndc);
      if (byNdc) vaccineId = byNdc.id;
      if (!vaccineId) {
        const byProductViewNdc = catalog.find((vaccine) => effectiveNdcForCatalogVaccine(vaccine) === row.ndc);
        if (byProductViewNdc) vaccineId = byProductViewNdc.id;
      }
    }
    if (!vaccineId) {
      const byAlias = matchByPioneerNameAlias(row.vaccineNameRaw, catalog);
      if (byAlias) vaccineId = byAlias.id;
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
