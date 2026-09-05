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
  // Brand-only, age-stripped forms produced by
  // compositeNameToMatchableBase (lib/appointment-table.ts,
  // V-T-schedule-table ROUND 2 follow-up, Will 2026-09-05) for an
  // aggregated Acuity appointment count — "COVID · Pfizer · <age>" /
  // "COVID · Moderna · <age>" / "COVID · Any · <age>" become "COVID
  // Pfizer" / "COVID Moderna" / "COVID" before reaching matchVaccineName,
  // since Ordering aggregates demand per PRODUCT, not per age bucket.
  // "covid moderna" is a documented judgment call: Moderna currently has
  // TWO catalog products by age (Spikevax for 3-11, mNEXSPIKE for 12+ —
  // see 0005_seed_lots.sql's step 2 comment), and the age-stripped
  // composite can't tell them apart. Pointed at mNEXSPIKE (Moderna's
  // primary 12+ product) as the more common case; a real Moderna 3-11
  // appointment's order count will land on the wrong SKU until this
  // alias is split by age again. "covid" (brandless — the patient
  // expressed no preference) has the same kind of ambiguity and is
  // pointed at Comirnaty (Pfizer) as a single, deterministic choice
  // rather than splitting the count across products.
  "covid pfizer": "comirnaty 2025-26 12+",
  "covid moderna": "mnexspike",
  covid: "comirnaty 2025-26 12+",
};

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
