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
 *
 * MISMATCHED NDC series, CANONICAL-ONLY (V-T66 round 2/3 follow-up,
 * reviewer findings 2026-09-30: round 2 — the lots-page Shingrix fix
 * didn't reach Ordering, since Shingrix's two dose rows carry DIFFERENT,
 * both non-null, NDCs, so before that round each dose started its OWN
 * NDC-keyed group here and Ordering showed two Shingrix rows; round 3 —
 * the first fix merged ANY same-name rows regardless of NDC, which is
 * broader than Ordering has ever allowed). This file's very own opening
 * rule (Will msg 908, be8b2e7, verbatim: "Each one in the ordering
 * recommendations queue should be for the product itself, NDC specific")
 * means two rows merely SHARING A NAME but carrying genuinely different
 * NDCs must stay separate — e.g. two Afluria package sizes really are
 * different orderable products even though they share a display name.
 * lib/lots-grouping.ts's /lots-page merge has no such guard (a /lots row
 * merges on name alone, no allowlist), so this file does NOT just mirror
 * it unconditionally: a later NDC-bearing row whose (stripped,
 * case-insensitive) product name matches a group already seen joins THAT
 * group ONLY when lib/canonical-ndc.ts's CANONICAL_NDC has an entry for
 * that exact name key (Shingrix today, and nothing else) — i.e. only for
 * a product Will has explicitly told us has one real identity split
 * across NDCs. A same-name collision with no CANONICAL_NDC entry still
 * produces two separate Ordering rows, same as always. (The merge is
 * additionally guarded, same as before, against stealing an NDC another
 * unrelated product already claimed under a different name.) The merged
 * group's ONE primary NDC is then the CANONICAL_NDC value itself (it's
 * how the merge fired in the first place) — see lib/canonical-ndc.ts.
 * upcoming7d/given7d/onHand math downstream
 * (app/api/ordering/recommendation/route.ts) is all summed over
 * `group.vaccineIds`, so once both dose rows land in one group here the
 * math path is identical to the existing null-NDC-merge case — no
 * changes needed there.
 */

import { normalizeNdc } from "@/lib/ndc";
import { CANONICAL_NDC } from "@/lib/canonical-ndc";

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
  /** The group's primary digits-only NDC (when it has one — including a
   * null-NDC dose row that joined an NDC-bearing sibling by name, see
   * this file's header comment), or "vaccine:<id>" for a null-NDC
   * vaccine with no NDC-bearing same-name sibling to join. Two null-NDC
   * vaccines are still NEVER collapsed with EACH OTHER — there's no
   * positive evidence they're the same product without a shared NDC
   * somewhere in the group. When a group's dose rows carry more than one
   * distinct NDC (the Shingrix case — see this file's header comment),
   * this is the SAME primary NDC as `ndc` below, not any of the other
   * NDCs the group's rows also carry. */
  key: string;
  /** The group's ONE primary NDC — lib/canonical-ndc.ts's CANONICAL_NDC
   * override when one applies (see this file's header comment), else the
   * lexicographically-smallest of every distinct NDC the group's dose
   * rows carry, else null when no member has an NDC at all. This is the
   * only NDC Ordering displays or keys on for a multi-NDC product; any
   * other NDC(s) the group's rows carry are folded into `vaccineIds`
   * (and hence upcoming7d/given7d/onHand sums) but not separately
   * exposed here — this file has no lots-page-style altNdcs display, so
   * there's nothing downstream that needs them listed. */
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
 * Two ways a row joins an existing NDC-bearing group instead of starting
 * its own (see this file's header comment for both):
 *
 *   - A null-NDC dose row joins an existing NDC-bearing group whose
 *     members share its (normalized) product name.
 *   - An NDC-bearing row whose NDC differs from a sibling dose's NDC, but
 *     whose (dose-marker-stripped) name matches a group already seen,
 *     joins THAT group instead of starting a second NDC group — ONLY
 *     when lib/canonical-ndc.ts's CANONICAL_NDC has an entry for that
 *     product's name key (the Shingrix case; nothing else today).
 *     Still skipped, same as the null-NDC case, when that exact NDC
 *     already has its own group with DIFFERENT-named members, so an
 *     unrelated product's own grouping is never disturbed. A same-name
 *     collision with NO CANONICAL_NDC entry stays two separate groups
 *     — see this file's header comment for why (Will's "NDC specific"
 *     rule).
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
  const groups = new Map<string, { ndcs: string[]; vaccines: CollapsibleVaccine[] }>();
  // First NDC-bearing group key seen for a given normalized product
  // name — lets a later null-NDC sibling dose (e.g. Vaqta adult's dose
  // 2, which carries no NDC at all), or a later row with a DIFFERENT NDC
  // (Shingrix), join that group instead of starting its own.
  const nameKeyToNdcGroupKey = new Map<string, string>();

  for (const vaccine of catalog) {
    const ndc = normalizeNdc(vaccine.ndc);
    if (!ndc) continue;
    const nameKey = normalizeCollapseNameKey(vaccine.name);
    const key = ndc;
    const existingGroupKeyForName = nameKeyToNdcGroupKey.get(nameKey);

    if (
      existingGroupKeyForName &&
      existingGroupKeyForName !== key &&
      !groups.has(key) &&
      CANONICAL_NDC[nameKey] !== undefined
    ) {
      // Same product family by name, different NDC than its sibling
      // dose(s) — join rather than starting a second group. Guarded by
      // `!groups.has(key)` so this never steals an unrelated product
      // that already claimed this exact NDC under a different name, AND
      // by `CANONICAL_NDC[nameKey] !== undefined` (reviewer fix, V-T66
      // round 3, REQUEST_CHANGES 2026-09-30) so this merge fires ONLY for
      // a product explicitly vetted in lib/canonical-ndc.ts (Shingrix
      // today) — Will's original Ordering rule (be8b2e7, verbatim: "Each
      // one in the ordering recommendations queue should be for the
      // product itself, NDC specific") still holds for every other
      // product: two rows that merely SHARE a name but carry genuinely
      // different, un-vetted NDCs (e.g. two Afluria package sizes) stay
      // separate, same as before this file ever gained a Shingrix fix.
      const target = groups.get(existingGroupKeyForName) as { ndcs: string[]; vaccines: CollapsibleVaccine[] };
      target.vaccines.push(vaccine);
      if (!target.ndcs.includes(ndc)) target.ndcs.push(ndc);
      continue;
    }

    let group = groups.get(key);
    if (!group) {
      group = { ndcs: [ndc], vaccines: [] };
      groups.set(key, group);
      order.push(key);
      if (!nameKeyToNdcGroupKey.has(nameKey)) nameKeyToNdcGroupKey.set(nameKey, key);
    } else if (!group.ndcs.includes(ndc)) {
      group.ndcs.push(ndc);
    }
    group.vaccines.push(vaccine);
  }

  for (const vaccine of catalog) {
    const ndc = normalizeNdc(vaccine.ndc);
    if (ndc) continue; // already placed above

    const nameKey = normalizeCollapseNameKey(vaccine.name);
    // Deliberately NOT registered into nameKeyToNdcGroupKey when this
    // creates a fresh `vaccine:<id>` orphan group — two null-NDC rows are
    // never collapsed with EACH OTHER absent an NDC-bearing sibling (see
    // this file's header comment and the "never collapses two null-NDC
    // vaccines together" test), unlike lib/lots-grouping.ts's equivalent
    // second pass, which intentionally does register its name-only
    // fallback group.
    const key = nameKeyToNdcGroupKey.get(nameKey) ?? `vaccine:${vaccine.id}`;
    let group = groups.get(key);
    if (!group) {
      group = { ndcs: [], vaccines: [] };
      groups.set(key, group);
      order.push(key);
    }
    group.vaccines.push(vaccine);
  }

  return order.map((key) => {
    const group = groups.get(key) as { ndcs: string[]; vaccines: CollapsibleVaccine[] };
    // Same reasoning as lib/lots-grouping.ts's identical step: sort the
    // group's recorded NDCs so the primary pick depends only on the SET
    // of NDCs the product's dose rows carry, never on catalog/array
    // order (see the "order-independent" test in
    // tests/ordering-ndc-collapse.test.ts). CANONICAL_NDC (V-T66 round 2,
    // Will 2026-09-30: "This is the correct NDC for Shingrix:
    // 58160084952. Don't list both.") wins over that tie-break when it
    // applies AND the canonical value is actually one of this group's
    // own recorded NDCs — never invents an NDC nobody seeded.
    const sortedNdcs = [...group.ndcs].sort();
    const vaccineName = chooseCollapsedName(group.vaccines.map((v) => v.name));
    const canonicalNdc = CANONICAL_NDC[normalizeCollapseNameKey(vaccineName)];
    const primaryNdc = canonicalNdc && sortedNdcs.includes(canonicalNdc) ? canonicalNdc : (sortedNdcs[0] ?? null);
    return {
      key: primaryNdc ?? key,
      ndc: primaryNdc,
      vaccineName,
      active: group.vaccines.some((v) => v.active),
      vaccineIds: group.vaccines.map((v) => v.id),
    };
  });
}
