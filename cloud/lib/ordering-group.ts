import { getVaccineGroup } from "@/lib/vaccine-group-catalog";

/**
 * Ordering-tab-only 3-bucket grouping (V-T26 item 5, Will 2026-09-09,
 * verbatim): "only 'COVID' and 'Flu' get their own heading; everything
 * else under one 'Other' heading." Deliberately scoped to
 * app/api/ordering/recommendation/route.ts (the only consumer of this
 * route's `group` field — see that route's doc comment) — the
 * /data-entry guided flow and the /physicians tab keep using
 * lib/vaccine-group-catalog.ts's fine-grained groups UNCHANGED (that
 * file is not modified by this change; see its own
 * the PHYSICIANS_* constants / getPhysiciansGroup for a similar-shaped
 * but SEPARATE coarsening it already does for the physicians tab).
 *
 * This also fixes the double-rendered "Other" section bug (V-T26 item
 * 8's investigation): the old Ordering page built its group display
 * order as `[...GROUP_DISPLAY_ORDER, OTHER_GROUP]`, but
 * GROUP_DISPLAY_ORDER (lib/vaccine-group-catalog.ts) ALREADY ends with
 * OTHER_GROUP — so "Other" appeared twice in that array, and the page's
 * `.map` over it rendered the entire Other group section (including
 * "Pfizer 3-4"/"Pfizer 5-11", which have no COVID/Flu/etc. name-prefix
 * match and always land in Other) twice. ORDERING_GROUP_DISPLAY_ORDER
 * below is a plain 3-item array with each name appearing exactly once,
 * so that duplication can't recur.
 */

export const ORDERING_GROUP_COVID = "COVID";
export const ORDERING_GROUP_FLU = "Flu";
export const ORDERING_GROUP_OTHER = "Other";

export const ORDERING_GROUP_DISPLAY_ORDER: readonly string[] = [
  ORDERING_GROUP_COVID,
  ORDERING_GROUP_FLU,
  ORDERING_GROUP_OTHER,
];

/** Coarsens a vaccine name straight to its Ordering-tab group — COVID and
 * Flu keep their own heading, every other fine-grained group (Pneumonia,
 * Shingles, RSV, HPV, ... and the fine-grained catalog's own "Other")
 * collapses into ORDERING_GROUP_OTHER. */
export function getOrderingGroup(vaccineName: string | null | undefined): string {
  const fineGroup = getVaccineGroup(vaccineName);
  if (fineGroup === ORDERING_GROUP_COVID) return ORDERING_GROUP_COVID;
  if (fineGroup === ORDERING_GROUP_FLU) return ORDERING_GROUP_FLU;
  return ORDERING_GROUP_OTHER;
}
