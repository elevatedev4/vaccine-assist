/**
 * NDC-based row collapsing for the Ordering tab (Will msg 908, verbatim:
 * "Seeing Gardasil entered 3 times because it's given three times for a
 * series. But it's still just one vaccine... Each one in the ordering
 * recommendations queue should be for the product itself, NDC
 * specific."). Pure functions, no Supabase/HTTP — see
 * cloud/app/api/ordering/recommendation/route.ts for how a collapsed
 * group's upcoming7d/onHand get filled in.
 *
 * Real seed data (supabase/seed/vaccines.sql) already shows the exact
 * shape this collapses: Gardasil doses 1/2/3 all share NDC
 * '00006-4121-02' with the IDENTICAL name "Gardasil" (dose lives in its
 * own `dose` column, not the name) — so for every real multi-dose
 * product in this formulary today, chooseCollapsedName's "all names
 * equal after stripping" branch is what actually fires (Gardasil,
 * Engerix 20 (age 20+), MMR-II, Shingrix). The dose-marker-stripping
 * branch exists for a formulary that DOES bake the dose into the name
 * string (e.g. "Shingrix Dose 2"), which this app doesn't have today but
 * shouldn't silently mis-collapse if it ever does.
 *
 * MIXED NDC/no-NDC series (V-T26 followups, Will 2026-09-09 — live bug
 * report: "Vaqta (adult)" showed up twice on /ordering): "Vaqta adult"
 * has two dose rows, but only dose 1 carries an NDC — dose 2's row is
 * null. Mirrors the same rule cloud/lib/lots-grouping.ts's
 * groupVaccinesIntoProducts already uses for the /lots page (a sibling
 * file, not imported from here — see that file's own header comment):
 * a null-NDC dose row joins its NDC-bearing sibling's group when they
 * share a (stripped, case-insensitive) product name, instead of
 * starting its own single-row group. This does NOT change the older
 * rule that two null-NDC rows are never collapsed with EACH OTHER absent
 * any NDC-bearing sibling — there's still no positive evidence two
 * NDC-less rows are the same product unless one of them has a sibling
 * that proves it via a shared NDC.
 */

import { normalizeNdc } from "@/lib/ndc";

const DOSE_MARKER_PATTERNS: RegExp[] = [
  /\s*\(\s*\d+\s*of\s*\d+\s*\)\s*$/i, // "(2 of 3)"
  /\s*#\s*\d+\s*$/, // "#3"
  /\s+dose\s*\d+\s*$/i, // " dose 2"
];

/** Strips a trailing dose-marker suffix (see DOSE_MARKER_PATTERNS), if
 * present — a name with no such suffix passes through unchanged. */
export function stripDoseMarker(name: string): string {
  let result = name.trim();
  for (const pattern of DOSE_MARKER_PATTERNS) {
    result = result.replace(pattern, "").trim();
  }
  return result;
}

/**
 * Picks the display name for a collapsed group of catalog names: strip
 * each name's dose marker, then use the single common name if every
 * stripped name agrees; otherwise fall back to the SHORTEST stripped
 * name (ties broken by first occurrence) rather than concatenating or
 * arbitrarily picking the first, on the theory that a shorter product
 * name is more likely the bare product name than a longer variant that
 * still carries some other qualifier.
 */
export function chooseCollapsedName(names: string[]): string {
  const stripped = names.map(stripDoseMarker);
  const unique = Array.from(new Set(stripped));
  if (unique.length <= 1) return unique[0] ?? "";
  return unique.reduce((shortest, candidate) => (candidate.length < shortest.length ? candidate : shortest));
}

export type CollapsibleVaccine = {
  id: string;
  name: string;
  ndc: string | null;
  active: boolean;
};

export type CollapsedVaccineGroup = {
  /** Digits-only NDC (when the group has one — including a null-NDC
   * dose row that joined an NDC-bearing sibling by name, see this
   * file's header comment), or "vaccine:<id>" for a null-NDC vaccine
   * with no NDC-bearing same-name sibling to join. Two null-NDC
   * vaccines are still NEVER collapsed with EACH OTHER — there's no
   * positive evidence they're the same product without a shared NDC
   * somewhere in the group. */
  key: string;
  /** Digits-only NDC shared by every vaccine in this group, or null. */
  ndc: string | null;
  vaccineName: string;
  /** true if ANY constituent vaccine is active — an active dose keeps
   * the whole collapsed product in the active section even if a
   * (unlikely) sibling dose was individually deactivated. */
  active: boolean;
  vaccineIds: string[];
};

/** Case-insensitive product-name key used ONLY to match a null-NDC dose
 * row to an NDC-bearing sibling's group (see this file's header comment
 * and lib/lots-grouping.ts's normalizeProductNameKey, which this
 * mirrors) — trims, lowercases, and strips a trailing dose-marker suffix
 * if present. */
function normalizeCollapseNameKey(name: string): string {
  return stripDoseMarker(name).toLowerCase();
}

/**
 * Groups a flat catalog list into one CollapsedVaccineGroup per product:
 * keyed by digits-only NDC when any member has one, else by vaccine id.
 * A null-NDC dose row joins an existing NDC-bearing group whose members
 * share its (normalized) product name — see this file's header comment
 * — rather than always starting its own single-row group.
 *
 * Two passes over `catalog`: NDC-bearing rows first (so every possible
 * NDC group, and its name, exists before any null-NDC row needs to look
 * one up), then null-NDC rows. Group order in the returned array
 * therefore reflects first-NDC-appearance followed by
 * first-orphan-appearance, NOT strict catalog order — callers that want
 * a specific display order (e.g. by upcoming7d/order, as the ordering
 * route does) should sort the result themselves.
 */
export function collapseVaccinesByNdc(catalog: CollapsibleVaccine[]): CollapsedVaccineGroup[] {
  const order: string[] = [];
  const groups = new Map<string, { ndc: string | null; vaccines: CollapsibleVaccine[] }>();
  // First NDC-bearing group key seen for a given normalized product
  // name — lets a later null-NDC sibling dose (e.g. Vaqta adult's dose
  // 2, which carries no NDC at all) join that group instead of starting
  // its own single-row group.
  const nameKeyToNdcGroupKey = new Map<string, string>();

  for (const vaccine of catalog) {
    const ndc = normalizeNdc(vaccine.ndc);
    if (!ndc) continue;
    const key = ndc;
    const existing = groups.get(key);
    if (existing) {
      existing.vaccines.push(vaccine);
    } else {
      groups.set(key, { ndc, vaccines: [vaccine] });
      order.push(key);
    }
    const nameKey = normalizeCollapseNameKey(vaccine.name);
    if (!nameKeyToNdcGroupKey.has(nameKey)) nameKeyToNdcGroupKey.set(nameKey, key);
  }

  for (const vaccine of catalog) {
    const ndc = normalizeNdc(vaccine.ndc);
    if (ndc) continue; // already placed above

    const nameKey = normalizeCollapseNameKey(vaccine.name);
    const key = nameKeyToNdcGroupKey.get(nameKey) ?? `vaccine:${vaccine.id}`;
    const existing = groups.get(key);
    if (existing) {
      existing.vaccines.push(vaccine);
    } else {
      groups.set(key, { ndc: null, vaccines: [vaccine] });
      order.push(key);
    }
  }

  return order.map((key) => {
    const { ndc, vaccines } = groups.get(key) as { ndc: string | null; vaccines: CollapsibleVaccine[] };
    return {
      key,
      ndc,
      vaccineName: chooseCollapsedName(vaccines.map((v) => v.name)),
      active: vaccines.some((v) => v.active),
      vaccineIds: vaccines.map((v) => v.id),
    };
  });
}
