/**
 * Preferred COVID vaccine setting (V-Q11, Will 2026-10-20, verbatim:
 * "C chooses the preferred COVID vaccine based on the location settings
 * (set ours to Pfizer for 12+ and Kids Moderna for 3-11, make it where
 * you can choose the preferred covid vaccine in data entry tab)").
 *
 * One pharmacy-wide setting with two parts - the preferred product for
 * patients 12 and older, and for children 3-11. Stored in the existing
 * generic `app_setting` table (no migration), edited on the Data Entry
 * tab, and read by the macro-codes "C" hotkey. Products are identified
 * by the macro-catalog short codes already in lib/macro-catalog.ts
 * (comirnaty12 = "Pfizer 12+", mnexspike = "Moderna 12+", spikevax6mo11 =
 * "Moderna 3-11"), so there is no second product list to keep in sync.
 *
 * Pure (no server-only imports): shared by the settings route, the Data
 * Entry editor and the hotkey resolver. Unset, missing or malformed
 * values fall back to the defaults field by field - the setting can
 * never leave C without an answer.
 */

export const PREFERRED_COVID_SETTING_KEY = "macro.preferred_covid";

export type PreferredCovidAdult = "pfizer" | "moderna";
export type PreferredCovidKids = "moderna";

export type PreferredCovidSetting = {
  /** Preferred COVID vaccine for ages 12 and up. */
  adult: PreferredCovidAdult;
  /** Preferred COVID vaccine for ages 3-11. */
  kids: PreferredCovidKids;
};

/** Our location's choice: Pfizer for 12+, Moderna (kids) for 3-11. Used whenever nothing valid is saved. */
export const DEFAULT_PREFERRED_COVID: PreferredCovidSetting = { adult: "pfizer", kids: "moderna" };

export type PreferredCovidOption<V extends string> = {
  value: V;
  /** Product label, as the macro catalog names it. */
  label: string;
  /** Macro-catalog short code the hotkey selects. */
  shortCode: string;
};

export const PREFERRED_COVID_ADULT_OPTIONS: readonly PreferredCovidOption<PreferredCovidAdult>[] = [
  { value: "pfizer", label: "Pfizer 12+", shortCode: "comirnaty12" },
  { value: "moderna", label: "Moderna 12+", shortCode: "mnexspike" },
];

/** Only Moderna is stocked for 3-11 today (the Pfizer 3-4 / 5-11 products are retired). */
export const PREFERRED_COVID_KIDS_OPTIONS: readonly PreferredCovidOption<PreferredCovidKids>[] = [
  { value: "moderna", label: "Moderna 3-11", shortCode: "spikevax6mo11" },
];

export function isPreferredCovidAdult(value: unknown): value is PreferredCovidAdult {
  return PREFERRED_COVID_ADULT_OPTIONS.some((o) => o.value === value);
}

export function isPreferredCovidKids(value: unknown): value is PreferredCovidKids {
  return PREFERRED_COVID_KIDS_OPTIONS.some((o) => o.value === value);
}

/** True when `value` is a complete, valid setting (both parts valid). */
export function isValidPreferredCovid(value: unknown): value is PreferredCovidSetting {
  if (!value || typeof value !== "object") return false;
  const { adult, kids } = value as Record<string, unknown>;
  return isPreferredCovidAdult(adult) && isPreferredCovidKids(kids);
}

/** Whatever was stored (or nothing) -> a complete setting, defaulting each part independently. */
export function normalizePreferredCovid(raw: unknown): PreferredCovidSetting {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    adult: isPreferredCovidAdult(obj.adult) ? obj.adult : DEFAULT_PREFERRED_COVID.adult,
    kids: isPreferredCovidKids(obj.kids) ? obj.kids : DEFAULT_PREFERRED_COVID.kids,
  };
}

export type PreferredCovidChoice = {
  band: "12+" | "3-11";
  label: string;
  shortCode: string;
};

/** Youngest and the 12+ cutoff ages of the two COVID bands. */
export const COVID_MIN_AGE = 3;
export const COVID_ADULT_MIN_AGE = 12;

/**
 * The preferred COVID vaccine for a patient's age under `setting`:
 * 12 and up -> the 12+ preference, 3-11 -> the kids preference. Null for
 * an unknown age or one under 3 (no COVID band). A fractional age uses
 * its whole years (11.9 is 11).
 */
export function preferredCovidForAge(
  ageYears: number | null | undefined,
  setting: PreferredCovidSetting = DEFAULT_PREFERRED_COVID
): PreferredCovidChoice | null {
  if (ageYears === null || ageYears === undefined || !Number.isFinite(ageYears) || ageYears < 0) return null;
  const age = Math.floor(ageYears);
  if (age < COVID_MIN_AGE) return null;
  if (age >= COVID_ADULT_MIN_AGE) {
    const option = PREFERRED_COVID_ADULT_OPTIONS.find((o) => o.value === setting.adult) ?? PREFERRED_COVID_ADULT_OPTIONS[0];
    return { band: "12+", label: option.label, shortCode: option.shortCode };
  }
  const option = PREFERRED_COVID_KIDS_OPTIONS.find((o) => o.value === setting.kids) ?? PREFERRED_COVID_KIDS_OPTIONS[0];
  return { band: "3-11", label: option.label, shortCode: option.shortCode };
}
