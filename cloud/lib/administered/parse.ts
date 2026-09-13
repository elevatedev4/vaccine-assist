import { chicagoDateString } from "@/lib/chicago-date";
import { normalizeNdc } from "@/lib/ndc";

/**
 * Parser for PioneerRx's daily "_AppExport_ Vaccines completed.xlsx"
 * per-dose vaccination log (V-administered-ingest, Will 2026-09-12) —
 * the report lib/inbound-attachments.ts's isVaccinationLogHeaderLine
 * detects and retains (raw file only, BOH parser skipped) but that
 * nothing yet turns into administered-dose data. Header row:
 * `Completed date | Item | ` (a trailing blank 3rd column). One row per
 * administered dose:
 *
 *   Completed date            | Item
 *   46275.6416666667          | Fluad Trivalent 2026-27
 *
 * "Completed date" is almost always an Excel serial datetime (fractional
 * days since the 1899-12-30 epoch — see excelSerialToUtcIso below), but
 * this also tolerates an already-formatted date/time STRING for the csv
 * ingest path (lib/inbound-attachments.ts's matrixFromDelimitedText) and
 * for hand-built test fixtures.
 *
 * TIMEZONE: a serial's fractional part is a WALL-CLOCK time with no zone
 * attached. Pioneer runs on Orchards Drug's own PC, so that wall clock is
 * assumed to be America/Chicago (same fixed-zone assumption
 * lib/chicago-date.ts documents for Acuity) — the decoded Y/M/D h:m:s is
 * interpreted AS Chicago local time and converted to a UTC instant
 * (`completedAt`) via chicagoWallTimeToUtcIso. `dateLocal` is that same
 * Chicago calendar date, "YYYY-MM-DD" — the key lib/administered/store.ts
 * groups rows by.
 *
 * HEADER VARIANTS (V-import-doses-file, 2026-09-13): PioneerRx's daily
 * SES email uses `Completed date | Item |` (a trailing blank 3rd
 * column), but Will's manually-exported "8/1 onward" backfill file uses
 * a DIFFERENT column set for the same underlying report: `Completed On |
 * Dispensed Item Name | Dispensed Quantity`. Columns are located BY
 * HEADER NAME (see DATE_HEADER_TOKENS/ITEM_HEADER_TOKENS/
 * QUANTITY_HEADER_TOKENS + resolveColumnMap below), not by position, so
 * either variant's columns land correctly regardless of order. When no
 * recognizable header row is found at all (shouldn't happen for a real
 * export, but keeps every existing position-0/1 test fixture working),
 * this falls back to the original hardcoded date=0/item=1/no-quantity
 * mapping.
 *
 * DOSE QUANTITY (V-import-doses-file): the backfill file's optional
 * "Dispensed Quantity" column is a FRACTIONAL package/vial amount for
 * almost every row (e.g. 0.5, 0.3, 0.2 — a dose's fraction of a
 * multi-dose vial), not a dose count, so it's ignored for those. The one
 * shape it needs to affect dose counting is a genuine WHOLE-dose batch
 * line: an INTEGER quantity greater than 1 emits that many identical
 * dose rows for the same (date, item) — see doseCountFromQuantityCell —
 * so lib/administered/store.ts's occurrence index (which counts DOSES,
 * not source rows) still comes out right. `expanded` on the result
 * counts how many SOURCE rows triggered this (ingest.ts logs it once per
 * ingest call, mirroring how `skipped` is logged).
 *
 * NDC COLUMN (V-administered-ndc-match, 2026-09-13): Pioneer's daily
 * export and the wider KPI-style export Will now also sends both carry
 * an optional "Dispensed Item NDC" column (aliased "NDC" too, in case a
 * future export shortens it). When present, its cell is normalized with
 * lib/ndc.ts's normalizeNdc (digits-only — the SAME comparison form
 * every other NDC match in this app uses, e.g.
 * lib/on-hand/pioneer-boh.ts's matchPioneerBohRows) and carried on each
 * row as `ndc`, so lib/administered/match.ts can try an NDC match before
 * falling back to name matching. A blank/unparseable NDC cell just
 * leaves `ndc` undefined — never a reason to skip the row, since the
 * item name alone is still enough to match on.
 *
 * WIDER KPI EXPORT SHAPE (V-administered-ndc-match): the KPI-style
 * export's header carries the same three core columns under 34+ OTHER
 * columns (every other Rx field a fill has — patient/Rx details this app
 * must never read). findColumnMap/resolveColumnMap already locate
 * columns BY HEADER NAME regardless of position or column count, so
 * those extra columns are simply never referenced by index and fall out
 * on their own — nothing extra to filter here. Because a KPI export logs
 * EVERY fill (not just vaccines), most of its rows will fail to match
 * any catalog vaccine in lib/administered/match.ts (by NDC or name) and
 * are kept with `vaccineId: null`, the same "unmatched" handling any
 * unrecognized item name already gets — never logged with patient/Rx
 * details, only the count.
 */

export type VaccinationLogRow = {
  /** UTC instant, ISO 8601 (e.g. "2026-09-10T20:24:00.000Z"). */
  completedAt: string;
  /** The America/Chicago calendar date of `completedAt`, "YYYY-MM-DD". */
  dateLocal: string;
  /** Pioneer's raw item name, e.g. "Fluad Trivalent 2026-27" — matched
   * against the catalog by lib/administered/match.ts, never parsed here. */
  itemName: string;
  /** Digits-only NDC (lib/ndc.ts normalizeNdc), when the source matrix
   * had a recognizable NDC column and the cell parsed to at least one
   * digit — undefined when there's no NDC column at all, or the cell
   * was blank/unparseable. lib/administered/match.ts tries this before
   * falling back to name matching. */
  ndc?: string;
};

/** A row parseVaccinationLog dropped for an unparseable date or a blank
 * item name — just the two raw cell strings (never the whole row), safe
 * to log: this report carries no patient data, but the same restraint
 * matters if a future column ever does. */
export type SkippedVaccinationLogRow = { date: string; item: string };

export type ParseVaccinationLogResult = {
  rows: VaccinationLogRow[];
  /** Count of rows dropped for an unparseable date or a blank item name
   * (V-administered-followups, Will 2026-09-12) — previously silent. */
  skipped: number;
  /** Up to the first 3 skipped rows, in file order, for ingest.ts's
   * once-per-ingest console.warn. */
  skippedSamples: SkippedVaccinationLogRow[];
  /** Count of SOURCE rows whose integer quantity > 1 expanded into
   * multiple dose rows (V-import-doses-file, 2026-09-13) — for
   * ingest.ts's once-per-ingest console.warn, mirroring `skipped`. */
  expanded: number;
};

const MAX_SKIPPED_SAMPLES = 3;

/** Header-name aliases for each column, matched case-insensitively
 * against a header row's own cell text (see resolveColumnMap) — the two
 * known real report variants (the daily SES email vs. Will's manual "8/1
 * onward" export) name their date/item columns differently. Kept as the
 * single source of truth lib/inbound-attachments.ts's
 * isVaccinationLogHeaderLine doc comment points back to. */
const DATE_HEADER_TOKENS = ["completed date", "completed on"];
const ITEM_HEADER_TOKENS = ["item", "dispensed item name"];
const QUANTITY_HEADER_TOKENS = ["dispensed quantity"];
/** V-administered-ndc-match: "Dispensed Item NDC" (the KPI-style export)
 * or a bare "NDC" header — see this file's top doc comment. */
const NDC_HEADER_TOKENS = ["dispensed item ndc", "ndc"];

function cellToString(cell: unknown): string {
  if (cell === null || cell === undefined) return "";
  return String(cell).trim();
}

function normalizedHeaderCell(cell: unknown): string {
  return cellToString(cell).toLowerCase();
}

/** True for a row that looks like the report's own header ("Completed
 * date | Item | ..." or "Completed On | Dispensed Item Name | ..."),
 * wherever it lands — same defensive posture as
 * lib/on-hand/pioneer-boh.ts's isHeaderRow, in case a re-sent file ever
 * repeats the header mid-sheet. */
function isHeaderRow(cells: unknown[]): boolean {
  return cells.some((cell) => {
    if (typeof cell !== "string") return false;
    const lower = cell.toLowerCase();
    return DATE_HEADER_TOKENS.some((token) => lower.includes(token));
  });
}

type ColumnMap = { dateIdx: number; itemIdx: number; quantityIdx: number | null; ndcIdx: number | null };

/** The original hardcoded layout (date in column 0, item in column 1, no
 * quantity or NDC column) — used when no row in the matrix satisfies
 * isHeaderRow at all, so every hand-built matrix that never included a
 * real header row (none exist in this repo's tests today, but nothing
 * guarantees a future caller won't) keeps working exactly as before. */
const POSITIONAL_FALLBACK: ColumnMap = { dateIdx: 0, itemIdx: 1, quantityIdx: null, ndcIdx: null };

/** Locates the date/item/quantity columns BY HEADER NAME (not position)
 * from a header row's own cells, so the two known column-name variants
 * (see this file's top doc comment) both resolve correctly regardless of
 * column order. Returns null when the row doesn't carry BOTH a
 * recognizable date column and a recognizable item column (isHeaderRow
 * already confirmed the date column alone before this is called, so in
 * practice this only returns null for a header missing its item
 * column — treated the same as "no header row found"). */
function resolveColumnMap(headerRow: unknown[]): ColumnMap | null {
  let dateIdx = -1;
  let itemIdx = -1;
  let quantityIdx = -1;
  let ndcIdx = -1;

  headerRow.forEach((cell, idx) => {
    const norm = normalizedHeaderCell(cell);
    if (dateIdx === -1 && DATE_HEADER_TOKENS.includes(norm)) dateIdx = idx;
    if (itemIdx === -1 && ITEM_HEADER_TOKENS.includes(norm)) itemIdx = idx;
    if (quantityIdx === -1 && QUANTITY_HEADER_TOKENS.includes(norm)) quantityIdx = idx;
    if (ndcIdx === -1 && NDC_HEADER_TOKENS.includes(norm)) ndcIdx = idx;
  });

  if (dateIdx === -1 || itemIdx === -1) return null;
  return {
    dateIdx,
    itemIdx,
    quantityIdx: quantityIdx === -1 ? null : quantityIdx,
    ndcIdx: ndcIdx === -1 ? null : ndcIdx,
  };
}

/** The first header row found in the matrix (isHeaderRow), plus the
 * column map resolved from it — falling back to POSITIONAL_FALLBACK when
 * no row looks like a header, or the header row found doesn't carry a
 * recognizable item column alongside its date column. */
function findColumnMap(matrix: unknown[][]): ColumnMap {
  for (const cells of matrix) {
    if (cells && cells.length > 0 && isHeaderRow(cells)) {
      return resolveColumnMap(cells) ?? POSITIONAL_FALLBACK;
    }
  }
  return POSITIONAL_FALLBACK;
}

/** An integer quantity greater than 1 means this source row represents
 * that many individual doses (a genuine batch line), so it's expanded
 * into that many dose rows below — everything else (missing column,
 * non-numeric, fractional like the real backfill file's 0.5/0.3/0.2
 * vial-fraction values, or exactly 1) is a single dose, per this file's
 * top doc comment. */
function doseCountFromQuantityCell(cell: unknown): number {
  if (typeof cell === "number" && Number.isInteger(cell) && cell > 1) return cell;
  return 1;
}

// --- Excel serial -> UTC instant (assuming the serial's wall-clock time
// is America/Chicago local) --------------------------------------------

/** Decodes an Excel date serial's calendar/time-of-day components,
 * ignoring timezone entirely (the serial carries none) — days since the
 * 1899-12-30 epoch, fractional part = time of day. Excel's 1900
 * leap-year bug is irrelevant for any date this report will ever carry
 * (2026+), so it's not modeled here. */
function excelSerialToParts(serial: number): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const days = Math.floor(serial);
  const frac = serial - days;
  const totalSeconds = Math.round(frac * 86400);
  const epochMs = Date.UTC(1899, 11, 30) + days * 86400000 + totalSeconds * 1000;
  const d = new Date(epochMs);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
  };
}

const chicagoOffsetFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  timeZoneName: "shortOffset",
});

/** The America/Chicago UTC offset (hours, negative) in effect at
 * `instant` — e.g. -5 during CDT, -6 during CST. Used to convert a
 * Chicago wall-clock time back to a UTC instant (there's no built-in
 * inverse of Intl's timeZone formatting, so this resolves it by
 * checking the offset at a first-guess instant and correcting once,
 * which is exact except in the one-hour DST-transition window a
 * pharmacy dose timestamp will not land in). */
function chicagoOffsetHoursAt(instant: Date): number {
  const part = chicagoOffsetFormatter.formatToParts(instant).find((p) => p.type === "timeZoneName")?.value ?? "GMT-6";
  const match = part.match(/GMT([+-]\d+)/);
  return match ? Number(match[1]) : -6;
}

/** Converts a wall-clock date/time, interpreted as America/Chicago local
 * time, to a UTC instant ISO string. */
function chicagoWallTimeToUtcIso(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number
): string {
  const naiveUtcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  // First pass: offset at the naive (wrong-by-the-offset) instant is
  // close enough to resolve DST correctly except right at a transition;
  // a second pass re-checks against the corrected instant to settle it.
  let offsetHours = chicagoOffsetHoursAt(new Date(naiveUtcMs));
  let utcMs = naiveUtcMs - offsetHours * 3600000;
  offsetHours = chicagoOffsetHoursAt(new Date(utcMs));
  utcMs = naiveUtcMs - offsetHours * 3600000;
  return new Date(utcMs).toISOString();
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// --- String date/time cell parsing (already-formatted dates) ----------

const ISO_WITH_TZ = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;
const ISO_NO_TZ = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;
const US_SLASH = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM|am|pm)?)?$/;

function parseDateCell(cell: unknown): { completedAt: string; dateLocal: string } | null {
  if (typeof cell === "number" && Number.isFinite(cell)) {
    const parts = excelSerialToParts(cell);
    const completedAt = chicagoWallTimeToUtcIso(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second);
    const dateLocal = `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
    return { completedAt, dateLocal };
  }

  const str = cellToString(cell);
  if (!str) return null;

  const withTz = str.match(ISO_WITH_TZ);
  if (withTz) {
    const instant = new Date(str);
    if (Number.isNaN(instant.getTime())) return null;
    return { completedAt: instant.toISOString(), dateLocal: chicagoDateString(instant) };
  }

  const isoNoTz = str.match(ISO_NO_TZ);
  if (isoNoTz) {
    const [, y, mo, d, h, mi, s] = isoNoTz;
    const completedAt = chicagoWallTimeToUtcIso(Number(y), Number(mo), Number(d), Number(h ?? 0), Number(mi ?? 0), Number(s ?? 0));
    return { completedAt, dateLocal: `${y}-${mo}-${d}` };
  }

  const usSlash = str.match(US_SLASH);
  if (usSlash) {
    const [, mo, d, y, hRaw, miRaw, sRaw, ampm] = usSlash;
    let hour = hRaw ? Number(hRaw) : 0;
    if (ampm) {
      const isPm = ampm.toLowerCase() === "pm";
      if (isPm && hour !== 12) hour += 12;
      if (!isPm && hour === 12) hour = 0;
    }
    const month = Number(mo);
    const day = Number(d);
    const year = Number(y);
    const completedAt = chicagoWallTimeToUtcIso(year, month, day, hour, miRaw ? Number(miRaw) : 0, sRaw ? Number(sRaw) : 0);
    return { completedAt, dateLocal: `${year}-${pad2(month)}-${pad2(day)}` };
  }

  return null;
}

/**
 * Parses a vaccination-log matrix (SheetJS `sheet_to_json({header:1})`
 * shape, same as lib/inbound-attachments.ts's matrixFromXlsxBuffer, or
 * matrixFromDelimitedText for a csv/tsv variant) into rows. Skips the
 * header row (wherever it lands), fully blank rows, and any row missing
 * a parseable date or a non-empty item name — this is deliberately
 * lenient (drop the bad row, don't throw) since a single ragged row must
 * never lose the other 108 in the same file. Tolerates the report's
 * trailing empty 3rd column (only cells[0]/cells[1] are read).
 *
 * A dropped row (unparseable date or blank item name) is counted in
 * `skipped` and, for the first MAX_SKIPPED_SAMPLES, recorded in
 * `skippedSamples` — previously these were silently discarded (V-admin
 * followups review fix, Will 2026-09-12).
 */
export function parseVaccinationLog(matrix: unknown[][]): ParseVaccinationLogResult {
  const columnMap = findColumnMap(matrix);
  const rows: VaccinationLogRow[] = [];
  const skippedSamples: SkippedVaccinationLogRow[] = [];
  let skipped = 0;
  let expanded = 0;

  for (const cells of matrix) {
    if (!cells || cells.length === 0) continue;
    if (isHeaderRow(cells)) continue;

    const itemName = cellToString(cells[columnMap.itemIdx]);
    const parsedDate = parseDateCell(cells[columnMap.dateIdx]);

    if (!itemName || !parsedDate) {
      skipped += 1;
      if (skippedSamples.length < MAX_SKIPPED_SAMPLES) {
        skippedSamples.push({ date: cellToString(cells[columnMap.dateIdx]), item: itemName });
      }
      continue;
    }

    const doseCount = columnMap.quantityIdx === null ? 1 : doseCountFromQuantityCell(cells[columnMap.quantityIdx]);
    if (doseCount > 1) expanded += 1;
    const ndc = columnMap.ndcIdx === null ? undefined : (normalizeNdc(cellToString(cells[columnMap.ndcIdx])) ?? undefined);
    for (let i = 0; i < doseCount; i++) {
      rows.push({ completedAt: parsedDate.completedAt, dateLocal: parsedDate.dateLocal, itemName, ...(ndc ? { ndc } : {}) });
    }
  }

  return { rows, skipped, skippedSamples, expanded };
}
