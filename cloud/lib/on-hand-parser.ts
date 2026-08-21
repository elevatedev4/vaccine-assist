import { matchVaccineName, type CatalogVaccine } from "@/lib/vaccine-matching";

/**
 * On-hand stock email parser (V-ordering, 2026-08-19/20).
 *
 * Expected email format:
 *   One vaccine per line:
 *     VaccineName, Quantity
 *   (tab-separated also accepted, e.g. "VaccineName<TAB>Quantity")
 *   - Blank lines are ignored.
 *   - Lines starting with # are treated as comments and ignored.
 *   - Quantity must be a non-negative whole number. A line whose quantity
 *     field isn't a plain integer (including a header row like
 *     "Vaccine, Qty") is kept but flagged as unmatched/unparsed, not
 *     dropped.
 *   - Vaccine name matching is case-insensitive "contains" against the
 *     catalog name or short_code, plus a small alias table for known
 *     naming variants (mirrors supabase/migrations/0005_seed_lots.sql).
 * Example:
 *   Comirnaty 2025-26 12+, 40
 *   Flu Quad 2025-26, 120
 *   # sent 8/19 morning count
 *   MMR, 15
 *
 * This module is deliberately just a text-in/rows-out function — no
 * Supabase, no HTTP — so it's easy to unit test in isolation. See
 * app/api/webhooks/ses/route.ts for how the raw request body becomes the
 * `content` string passed in here, and for the insert into `on_hand_count`.
 */

export type ParsedOnHandLine = {
  /** The line as received, trimmed. */
  rawLine: string;
  /** The name portion before the delimiter, trimmed — or the whole line
   * (trimmed) when no delimiter was found at all. */
  vaccineNameRaw: string;
  /** null when the quantity field wasn't a plain non-negative integer
   * (or there was no delimiter at all) — the line is still kept, just
   * flagged via `matched: false`. */
  quantity: number | null;
  /** Matching catalog vaccine's id, or null if unmatched/unparsed. */
  vaccineId: string | null;
  /** True only when both the quantity parsed AND the name matched a
   * catalog vaccine. */
  matched: boolean;
};

/**
 * Splits a single trimmed, non-blank, non-comment line on the FIRST comma
 * or tab. Returns null if neither delimiter is present.
 */
function splitLine(line: string): { name: string; qtyRaw: string } | null {
  const index = line.search(/[,\t]/);
  if (index === -1) return null;
  return {
    name: line.slice(0, index).trim(),
    qtyRaw: line.slice(index + 1).trim(),
  };
}

const QUANTITY_PATTERN = /^\d+$/;

/**
 * Parses raw on-hand email content into one ParsedOnHandLine per
 * non-blank, non-comment input line — see the format doc comment above.
 * `catalog` is the current active-or-not vaccine list to match names
 * against (callers typically pass every row, matched or not, so an
 * inactive vaccine can still receive an on-hand count).
 */
export function parseOnHandContent(content: string, catalog: CatalogVaccine[]): ParsedOnHandLine[] {
  if (!content) return [];

  const results: ParsedOnHandLine[] = [];

  for (const raw of content.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.startsWith("#")) continue;

    const split = splitLine(line);
    if (!split) {
      results.push({ rawLine: line, vaccineNameRaw: line, quantity: null, vaccineId: null, matched: false });
      continue;
    }

    const { name, qtyRaw } = split;
    if (!QUANTITY_PATTERN.test(qtyRaw)) {
      results.push({ rawLine: line, vaccineNameRaw: name, quantity: null, vaccineId: null, matched: false });
      continue;
    }

    const quantity = Number.parseInt(qtyRaw, 10);
    const match = matchVaccineName(name, catalog);

    results.push({
      rawLine: line,
      vaccineNameRaw: name,
      quantity,
      vaccineId: match ? match.id : null,
      matched: match !== null,
    });
  }

  return results;
}
