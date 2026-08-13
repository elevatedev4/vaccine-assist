// Pure transform logic for the "Macro codes" sheet of v-macro-codes.xlsx.
// Kept dependency-free (no xlsx import here) so it's unit-testable with
// synthetic row arrays — see tests/formulary-parser.test.ts.
//
// SHEET LAYOUT (confirmed by inspecting the real file, 2026-08-13): the
// sheet has TWO side-by-side blocks. Columns A-E are stale/duplicated
// leftover content (the sheet's own note says "Do NOT use sort... can
// manually drag/drop" — this app treats that block as noise). The real,
// current table lives in columns G-M (0-indexed 6-12 when the sheet is
// read as an array-of-arrays):
//   [6]  G  Cash price (sparse — not every row has one; dose-2/3 rows of
//           a multi-dose product usually leave it blank since it's the
//           same physical product as dose 1)
//   [7]  H  Age group / category label (e.g. "Pfizer 12+ (2025-26)") —
//           not persisted (no matching column in the vaccine table;
//           structured age gates live in eligibility_rule instead)
//   [8]  I  Vaccine name (specific product/brand)
//   [9]  J  Dose (1, 2, or 3 — position in a multi-dose series)
//   [10] K  Short code (the macro lookup key — globally unique, used as
//           the dedupe key and as eligibility_rule's join key)
//   [11] L  Macro text (a computed "shortcode,lot,exp" formula result —
//           informational only, not persisted)
//   [12] M  NDC

const COLUMN = {
  price: 6,
  ageGroup: 7,
  name: 8,
  dose: 9,
  shortCode: 10,
  macroText: 11,
  ndc: 12,
};

const HEADER_LABELS = new Set(["short code", "vaccine", "dose", "ndc"]);

function cleanString(value) {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isHeaderRow(name, shortCode) {
  const n = name?.toLowerCase();
  const s = shortCode?.toLowerCase();
  return HEADER_LABELS.has(n ?? "") || HEADER_LABELS.has(s ?? "");
}

/**
 * @param {Array<Array<unknown>>} rawRows sheet_to_json(sheet, {header:1}) output
 * @returns {{ vaccines: Array<{shortCode:string,name:string,ndc:string|null,dose:string|null,cashPriceCents:number|null,ageGroupLabel:string|null}>, warnings: string[] }}
 */
export function parseFormularyRows(rawRows) {
  const warnings = [];
  /** @type {Map<string, any>} keyed by short_code (the reliable unique key) */
  const byShortCode = new Map();
  /** @type {Map<string, string>} secondary dedupe check requested by the brief: ndc+name */
  const seenByNdcName = new Map();

  for (const row of rawRows ?? []) {
    if (!Array.isArray(row)) continue;

    const shortCode = cleanString(row[COLUMN.shortCode]);
    if (!shortCode) continue;
    const name = cleanString(row[COLUMN.name]);
    if (isHeaderRow(name, shortCode)) continue;
    // Dose-2/dose-3 rows of a multi-dose series (e.g. shingrix2, mmr2,
    // gardasil3) commonly leave the name column blank in this sheet —
    // only the short_code + dose number identify them. Let a row through
    // with a null name here; the sibling-name backfill pass below fills
    // it in from the matching dose-1 row before the missing-name check.

    const ndc = cleanString(row[COLUMN.ndc]);
    const ageGroupLabel = cleanString(row[COLUMN.ageGroup]);
    const rawDose = row[COLUMN.dose];
    const dose = typeof rawDose === "number" ? String(Math.trunc(rawDose)) : cleanString(rawDose);
    const rawPrice = row[COLUMN.price];
    const cashPriceCents =
      typeof rawPrice === "number" && Number.isFinite(rawPrice)
        ? Math.round(rawPrice * 100)
        : null;

    const key = shortCode.toLowerCase();
    const existing = byShortCode.get(key);

    if (existing) {
      // Same product repeated (the sheet has copy-paste duplicates) —
      // fill in any field the first occurrence was missing rather than
      // overwrite good data with a blank.
      existing.ndc ??= ndc;
      existing.dose ??= dose;
      existing.cashPriceCents ??= cashPriceCents;
      existing.ageGroupLabel ??= ageGroupLabel;
      existing.name ??= name;
      if (existing.name && name && existing.name !== name) {
        warnings.push(
          `short_code "${shortCode}" has conflicting names ("${existing.name}" vs "${name}") — kept the first.`
        );
      }
      continue;
    }

    // Secondary dedupe check (brief: "dedupe by NDC+name") — flag rather
    // than silently drop, since short_code is the primary key here and a
    // collision on ndc+name with a *different* short_code most likely
    // means two dose-in-series entries of the same physical product,
    // which this app intentionally keeps as separate rows (dose 1/2/3
    // are separate administration events in the old macro too).
    const ndcNameKey = `${ndc ?? ""}|${(name ?? "").toLowerCase()}`;
    const priorShortCode = seenByNdcName.get(ndcNameKey);
    if (priorShortCode && priorShortCode !== key) {
      warnings.push(
        `ndc+name "${ndcNameKey}" also matches short_code "${priorShortCode}" (kept both — likely a multi-dose series, e.g. dose 1 vs dose 2).`
      );
    }
    seenByNdcName.set(ndcNameKey, key);

    byShortCode.set(key, {
      shortCode,
      name,
      ndc,
      dose,
      cashPriceCents,
      ageGroupLabel,
    });
  }

  // Backfill pass: a dose-2/dose-3 row (e.g. "shingrix2", "gardasil3")
  // that came through with no name inherits it — plus ndc/price if also
  // missing — from a sibling short_code that shares the same alphabetic
  // prefix (short_code with its trailing dose digits stripped) and does
  // have a name. Only ever fills gaps; never overwrites data a row
  // already has.
  const entries = [...byShortCode.values()];
  const byPrefix = new Map();
  for (const entry of entries) {
    const prefix = entry.shortCode.toLowerCase().replace(/\d+$/, "");
    if (entry.name && !byPrefix.has(prefix)) {
      byPrefix.set(prefix, entry);
    }
  }
  for (const entry of entries) {
    if (entry.name) continue;
    const prefix = entry.shortCode.toLowerCase().replace(/\d+$/, "");
    const sibling = byPrefix.get(prefix);
    if (sibling) {
      entry.name = sibling.name;
      entry.ndc ??= sibling.ndc;
      entry.cashPriceCents ??= sibling.cashPriceCents;
      entry.ageGroupLabel ??= sibling.ageGroupLabel;
      warnings.push(
        `short_code "${entry.shortCode}" had no name in the sheet — inherited "${sibling.name}" from sibling "${sibling.shortCode}".`
      );
    }
  }

  const resolved = [];
  for (const entry of entries) {
    if (!entry.name) {
      warnings.push(`short_code "${entry.shortCode}" has no name anywhere in the sheet — dropped.`);
      continue;
    }
    resolved.push(entry);
  }

  return {
    vaccines: resolved,
    warnings,
  };
}
