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
  /** Digits-only NDC, or "vaccine:<id>" for a vaccine with no NDC — a
   * null-NDC vaccine is NEVER collapsed with another null-NDC vaccine
   * (Will's brief: "Rows with null NDC stay keyed by vaccine id"), since
   * there's no evidence they're the same product. */
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

/**
 * Groups a flat catalog list into one CollapsedVaccineGroup per
 * NDC (or per vaccine id when NDC is null), preserving catalog order for
 * each group's first appearance.
 */
export function collapseVaccinesByNdc(catalog: CollapsibleVaccine[]): CollapsedVaccineGroup[] {
  const order: string[] = [];
  const groups = new Map<string, { ndc: string | null; vaccines: CollapsibleVaccine[] }>();

  for (const vaccine of catalog) {
    const ndc = normalizeNdc(vaccine.ndc);
    const key = ndc ?? `vaccine:${vaccine.id}`;
    const existing = groups.get(key);
    if (existing) {
      existing.vaccines.push(vaccine);
    } else {
      groups.set(key, { ndc, vaccines: [vaccine] });
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
