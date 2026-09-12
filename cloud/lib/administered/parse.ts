import { chicagoDateString } from "@/lib/chicago-date";

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
 */

export type VaccinationLogRow = {
  /** UTC instant, ISO 8601 (e.g. "2026-09-10T20:24:00.000Z"). */
  completedAt: string;
  /** The America/Chicago calendar date of `completedAt`, "YYYY-MM-DD". */
  dateLocal: string;
  /** Pioneer's raw item name, e.g. "Fluad Trivalent 2026-27" — matched
   * against the catalog by lib/administered/match.ts, never parsed here. */
  itemName: string;
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
};

const MAX_SKIPPED_SAMPLES = 3;

function cellToString(cell: unknown): string {
  if (cell === null || cell === undefined) return "";
  return String(cell).trim();
}

/** True for a row that looks like the report's own header ("Completed
 * date | Item | ..."), wherever it lands — same defensive posture as
 * lib/on-hand/pioneer-boh.ts's isHeaderRow, in case a re-sent file ever
 * repeats the header mid-sheet. */
function isHeaderRow(cells: unknown[]): boolean {
  return cells.some((cell) => typeof cell === "string" && cell.toLowerCase().includes("completed date"));
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
  const rows: VaccinationLogRow[] = [];
  const skippedSamples: SkippedVaccinationLogRow[] = [];
  let skipped = 0;

  for (const cells of matrix) {
    if (!cells || cells.length === 0) continue;
    if (isHeaderRow(cells)) continue;

    const itemName = cellToString(cells[1]);
    const parsedDate = parseDateCell(cells[0]);

    if (!itemName || !parsedDate) {
      skipped += 1;
      if (skippedSamples.length < MAX_SKIPPED_SAMPLES) {
        skippedSamples.push({ date: cellToString(cells[0]), item: itemName });
      }
      continue;
    }

    rows.push({ completedAt: parsedDate.completedAt, dateLocal: parsedDate.dateLocal, itemName });
  }

  return { rows, skipped, skippedSamples };
}
