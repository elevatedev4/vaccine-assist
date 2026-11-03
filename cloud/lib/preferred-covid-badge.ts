import { stripCovidMakerPrefix } from "@/lib/vaccine-display-name";
import { PREFERRED_COVID_ADULT_OPTIONS, type PreferredCovidSetting } from "@/lib/preferred-covid";

/**
 * Which Lots / Entry values rows get the "Preferred" badge (Will
 * 2026-11-02: "Where do I choose the preferred COVID vaccine so 'C'
 * hotkey knows what to pick? I want it to show up on Lots and Entry
 * values"). The one place the brand -> row rule lives; pure (no I/O).
 *
 * Ages 12+ only: Pfizer = Comirnaty, Moderna = mNEXSPIKE (the same two
 * products the macro catalog calls comirnaty12 / mnexspike). Matching is
 * deliberately conservative - Spikevax (Moderna 3-11) never matches the
 * Moderna 12+ choice, and a Comirnaty name that carries a child age band
 * (3-4, 5-11, 6 mo) never matches Pfizer 12+. Missing setting, missing
 * name, or no match all return false: the badge simply doesn't show.
 */

export type PreferredCovidRowInput = {
  /** Product name as shown on the page (maker prefix and season tolerated). */
  name: string | null | undefined;
  /** The row's short_code when the page has one (Entry values does; Lots does not). */
  shortCode?: string | null;
};

const NAME_BY_ADULT_CHOICE = {
  pfizer: /^comirnaty\b/i,
  moderna: /^mnexspike\b/i,
} as const;

/** A child age band in the name rules the row out of the 12+ preference. */
const CHILD_AGE_BAND = /\b(?:3\s*[-–]\s*4|5\s*[-–]\s*11|6\s*mo)/i;

export function isPreferredAdultCovidRow(
  row: PreferredCovidRowInput,
  setting: PreferredCovidSetting | null | undefined
): boolean {
  if (!setting) return false;
  const option = PREFERRED_COVID_ADULT_OPTIONS.find((o) => o.value === setting.adult);
  if (!option) return false;

  const shortCode = row.shortCode?.trim().toLowerCase();
  if (shortCode && shortCode === option.shortCode) return true;

  const name = row.name?.trim();
  if (!name) return false;
  const bare = stripCovidMakerPrefix(name);
  if (CHILD_AGE_BAND.test(bare)) return false;
  return NAME_BY_ADULT_CHOICE[option.value].test(bare);
}
