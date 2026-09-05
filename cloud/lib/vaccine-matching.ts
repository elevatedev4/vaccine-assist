/**
 * Shared vaccine-name matching: takes a free-text vaccine name (typed by
 * Will into an on-hand-count email, or spoken by Acuity's appointment
 * form) and resolves it against the `vaccine` catalog. Used by
 * lib/on-hand-parser.ts (task 1) and app/api/ordering/recommendation
 * (task 2) so the two features stay consistent instead of each growing
 * its own ad hoc matching logic.
 *
 * Matching strategy, in order:
 *   1. Exact case-insensitive match on name or short_code.
 *   2. Alias table lookup (see NAME_ALIASES below), then exact/contains
 *      match against the alias's target name.
 *   3. Case-insensitive "contains" in either direction against name or
 *      short_code (catalog name contains the raw text, or vice versa) —
 *      covers both a raw name that's an abbreviation of the catalog name
 *      ("MMR" -> "MMR-II") and a raw name that's more verbose than the
 *      catalog's.
 *
 * First catalog match wins — a prototype tradeoff: with only ~30 vaccines
 * in the formulary, an ambiguous double-match is unlikely, but it's not
 * impossible (e.g. two catalog rows both containing a common short
 * fragment). If that ever bites, the fix is a more specific alias entry,
 * not a rewrite of this function.
 */

export type CatalogVaccine = {
  id: string;
  name: string;
  short_code?: string | null;
};

/**
 * Known naming variants between how Will refers to a vaccine informally
 * (email on-hand counts, Acuity form answers) and the catalog's
 * canonical `name`. MIRRORS supabase/migrations/0005_seed_lots.sql's
 * seed-to-catalog name mapping (see that migration's step 2 comment) —
 * keep these two in sync if 0005's aliases ever change.
 */
const NAME_ALIASES: Record<string, string> = {
  "pfizer 12+": "comirnaty 2025-26 12+",
  "moderna 12+ nexspike": "mnexspike",
  flumist: "flumist (age 2-49)",
  mmr: "mmr-ii",
};

// NOTE (review fix, 2026-09-05): a "covid"/"covid pfizer"/"covid moderna"
// -> catalog-product alias set used to live in NAME_ALIASES above, added
// alongside compositeNameToMatchableBase (lib/appointment-table.ts) so
// app/api/ordering/recommendation/route.ts could resolve an aggregated
// COVID appointment count to a catalog product. That was wrong: this
// table is SHARED with lib/on-hand-parser.ts, which also calls
// matchVaccineName — for a manually-typed on-hand email line like
// "COVID: 40", Will genuinely doesn't know (and this app can't guess)
// whether he means Comirnaty or mNEXSPIKE, so it must keep surfacing
// matched:false for his manual review, not silently attribute stock to
// whichever product the alias happened to point at. That composite ->
// catalog resolution now lives ONLY in
// app/api/ordering/recommendation/route.ts, scoped to appointment counts
// that have already been through compositeNameToMatchableBase — see that
// route's COMPOSITE_BASE_TO_CATALOG_NAME.

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function fieldsMatch(needle: string, name: string, shortCode: string): boolean {
  if (name === needle || shortCode === needle) return true;
  if (name.includes(needle) || needle.includes(name)) return true;
  if (shortCode && (shortCode.includes(needle) || needle.includes(shortCode))) return true;
  return false;
}

/**
 * Returns the first catalog entry that matches `rawName`, or null if
 * nothing matches. `catalog` order is caller-controlled (callers
 * typically pass vaccines already sorted by name).
 */
export function matchVaccineName(rawName: string, catalog: CatalogVaccine[]): CatalogVaccine | null {
  const needle = normalize(rawName);
  if (!needle) return null;

  const aliasTarget = NAME_ALIASES[needle];

  for (const vaccine of catalog) {
    const name = normalize(vaccine.name);
    const shortCode = normalize(vaccine.short_code ?? "");

    if (aliasTarget && (name === aliasTarget || name.includes(aliasTarget))) return vaccine;
    if (fieldsMatch(needle, name, shortCode)) return vaccine;
  }

  return null;
}
