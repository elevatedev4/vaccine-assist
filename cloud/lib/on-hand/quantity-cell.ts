/**
 * Shared "Current BOH" / "Stock size" cell parser (V-onhand-ndc-units,
 * Will 2026-09-09/10: "The BOH from the report will now include ML or
 * EA. Divide BOH by stock size to get the number of doses on hand.").
 *
 * Both Pioneer ingest paths — the xlsx/csv matrix parser
 * (lib/on-hand/pioneer-boh.ts) and the PDF text-reconstruction parser
 * (lib/on-hand/pioneer-boh-pdf.ts) — previously had their OWN numeric-
 * cell parsing (cellToNumber / parseNumericCell respectively), neither
 * of which recognized a trailing unit token. This is the one shared
 * implementation both now call, so a cell like "9 EA" or "4.5 ML"
 * parses identically (same numeric value, same recovered unit) no
 * matter which ingest path produced it.
 *
 * Accepts: a bare number (already-parsed xlsx cell), or a string like
 * "9", "9 EA", "4.5 ML", "1,200 ML", "0.5mL" — case-insensitive, the
 * space before the unit is optional, and thousands-comma separators are
 * stripped before parsing. Only "EA" and "ML" are recognized units (the
 * two Pioneer's report uses per the brief); anything else after the
 * number is ignored, same permissive "leading numeric run, ignore the
 * rest" posture the two prior per-path parsers already had (a real PDF
 * cell can carry stray whitespace/glyph-split artifacts around the
 * number).
 *
 * Returns { value: null, unit: null } for a blank cell, one with no
 * leading numeric content at all, or a NEGATIVE number (review fix,
 * V-onhand-ndc-units: a BOH/stock-size cell is a physical quantity —
 * "-9 EA" is not a valid report value, so it's treated the same as
 * unparseable rather than silently flowing a negative number into
 * computeDoses/downstream math).
 */
export type ParsedQuantityCell = {
  value: number | null;
  unit: "EA" | "ML" | null;
};

const QUANTITY_CELL_PATTERN = /(-?\d+(?:\.\d+)?)\s*(EA|ML)?/i;

/**
 * Recovers the unit (EA/ML) from a stored on_hand_count.raw_line value,
 * for a row built by the Pioneer ingest paths (lib/on-hand/pioneer-boh.ts
 * / pioneer-boh-pdf.ts), which join four fields with " | ":
 * `name | ndc | bohText | stockSizeText`. The unit lives in the FOURTH
 * field (the stock-size cell's ORIGINAL text, e.g. "1 EA") — no new
 * on_hand_count column was added this round (V-onhand-ndc-units), so
 * raw_line is where a unit annotation has to be recovered from after
 * the fact (by app/api/ordering/recommendation/route.ts's `unitSize`
 * field and GET /api/on-hand/latest). Returns null for anything with
 * fewer than four " | "-delimited fields — including every legacy
 * plain-text on-hand line ("VaccineName, Quantity"), which never had
 * this shape at all.
 */
export function extractUnitFromRawLine(rawLine: string): "EA" | "ML" | null {
  const parts = rawLine.split(" | ");
  if (parts.length < 4) return null;
  return parseQuantityCell(parts[3]).unit;
}

export function parseQuantityCell(cell: unknown): ParsedQuantityCell {
  if (typeof cell === "number") {
    return Number.isFinite(cell) && cell >= 0 ? { value: cell, unit: null } : { value: null, unit: null };
  }
  if (typeof cell !== "string") return { value: null, unit: null };

  const trimmed = cell.trim();
  if (!trimmed) return { value: null, unit: null };

  const cleaned = trimmed.replace(/,/g, "");
  const match = cleaned.match(QUANTITY_CELL_PATTERN);
  if (!match) return { value: null, unit: null };

  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0) return { value: null, unit: null };

  const unit = match[2] ? (match[2].toUpperCase() as "EA" | "ML") : null;
  return { value, unit };
}
