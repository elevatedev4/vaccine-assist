/**
 * Preferred COVID vaccine setting (V-Q11, Will 2026-10-20, verbatim:
 * "C chooses the preferred COVID vaccine based on the location settings
 * (set ours to Pfizer for 12+ and Kids Moderna for 3-11, make it where
 * you can choose the preferred covid vaccine in data entry tab)").
 *
 * One pharmacy-wide setting with three parts - the preferred product for
 * patients 12 and older (`adult`), for children 5-11 (`kids511`, added
 * when Pfizer 5-11 came back, Will 2026-11-25) and for the youngest
 * children 3-4 (`kids`). Stored in the existing generic `app_setting`
 * table (no migration), edited on the Data Entry tab, and read by the
 * macro-codes "C" hotkey. Products are identified by the macro-catalog
 * short codes already in lib/macro-catalog.ts (comirnaty12 = "Pfizer
 * 12+", mnexspike = "Moderna 12+", comirnaty511 = "Pfizer 5-11",
 * spikevax6mo11 = "Moderna 3-11"), so there is no second product list to
 * keep in sync.
 *
 * BACKWARD COMPATIBILITY: `kids` keeps its original name and shape (it was
 * the whole 3-11 band, Moderna only; it now covers ages 3-4, the ages
 * Pfizer 5-11 does not reach), so a row saved before `kids511` existed -
 * { adult, kids } - is still a valid value; its missing `kids511` takes the
 * default (Pfizer 5-11).
 *
 * Pure (no server-only imports): shared by the settings route, the Data
 * Entry editor and the hotkey resolver. Unset, missing or malformed
 * values fall back to the defaults field by field - the setting can
 * never leave C without an answer.
 */

export const PREFERRED_COVID_SETTING_KEY = "macro.preferred_covid";

export type PreferredCovidAdult = "pfizer" | "moderna";
/** Ages 3-4 (Pfizer 5-11 does not cover them). Stored as `kids`. */
export type PreferredCovidKids = "moderna";
/** Ages 5-11. Stored as `kids511`. */
export type PreferredCovidKids511 = "pfizer" | "moderna";

export type PreferredCovidSetting = {
  /** Preferred COVID vaccine for ages 12 and up. */
  adult: PreferredCovidAdult;
  /** Preferred COVID vaccine for ages 3-4 (the legacy "kids" part of the setting). */
  kids: PreferredCovidKids;
  /** Preferred COVID vaccine for ages 5-11. */
  kids511: PreferredCovidKids511;
};

/**
 * A setting as it may have been stored: `kids511` is absent on a value saved
 * before it existed (normalizePreferredCovid fills it in). Functions that only
 * read a setting accept this looser shape.
 */
export type PreferredCovidSettingInput = Omit<PreferredCovidSetting, "kids511"> & { kids511?: PreferredCovidKids511 };

/**
 * Our location's choice: Pfizer 12+ for 12 and up, Pfizer 5-11 for 5-11,
 * Moderna 3-11 for 3-4. Used whenever nothing valid is saved.
 */
export const DEFAULT_PREFERRED_COVID: PreferredCovidSetting = { adult: "pfizer", kids: "moderna", kids511: "pfizer" };

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

/** Ages 3-4: only Moderna is stocked (Pfizer 5-11 starts at 5, the Pfizer 3-4 product is retired). */
export const PREFERRED_COVID_KIDS_OPTIONS: readonly PreferredCovidOption<PreferredCovidKids>[] = [
  { value: "moderna", label: "Moderna 3-11", shortCode: "spikevax6mo11" },
];

/** Ages 5-11: Pfizer 5-11 (default) or Moderna 3-11. */
export const PREFERRED_COVID_KIDS511_OPTIONS: readonly PreferredCovidOption<PreferredCovidKids511>[] = [
  { value: "pfizer", label: "Pfizer 5-11", shortCode: "comirnaty511" },
  { value: "moderna", label: "Moderna 3-11", shortCode: "spikevax6mo11" },
];

export function isPreferredCovidAdult(value: unknown): value is PreferredCovidAdult {
  return PREFERRED_COVID_ADULT_OPTIONS.some((o) => o.value === value);
}

export function isPreferredCovidKids(value: unknown): value is PreferredCovidKids {
  return PREFERRED_COVID_KIDS_OPTIONS.some((o) => o.value === value);
}

export function isPreferredCovidKids511(value: unknown): value is PreferredCovidKids511 {
  return PREFERRED_COVID_KIDS511_OPTIONS.some((o) => o.value === value);
}

/**
 * True when `value` is a usable setting: `adult` and `kids` valid, and
 * `kids511` either absent (a value saved before it existed) or valid. A
 * present-but-invalid `kids511` is NOT valid (the PUT route rejects it).
 */
export function isValidPreferredCovid(value: unknown): value is PreferredCovidSettingInput {
  if (!value || typeof value !== "object") return false;
  const { adult, kids, kids511 } = value as Record<string, unknown>;
  return isPreferredCovidAdult(adult) && isPreferredCovidKids(kids) && (kids511 === undefined || isPreferredCovidKids511(kids511));
}

/** Whatever was stored (or nothing) -> a complete setting, defaulting each part independently. */
export function normalizePreferredCovid(raw: unknown): PreferredCovidSetting {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    adult: isPreferredCovidAdult(obj.adult) ? obj.adult : DEFAULT_PREFERRED_COVID.adult,
    kids: isPreferredCovidKids(obj.kids) ? obj.kids : DEFAULT_PREFERRED_COVID.kids,
    kids511: isPreferredCovidKids511(obj.kids511) ? obj.kids511 : DEFAULT_PREFERRED_COVID.kids511,
  };
}

export type PreferredCovidChoice = {
  band: "12+" | "5-11" | "3-4";
  label: string;
  shortCode: string;
};

/** Youngest age, the 5-11 band's start and the 12+ cutoff of the COVID bands. */
export const COVID_MIN_AGE = 3;
export const COVID_KIDS511_MIN_AGE = 5;
export const COVID_ADULT_MIN_AGE = 12;

/**
 * The preferred COVID vaccine for a patient's age under `setting`:
 * 12 and up -> the 12+ preference, 5-11 -> the 5-11 preference, 3-4 ->
 * the 3-4 preference. Null for an unknown age or one under 3 (no COVID
 * band). A fractional age uses its whole years (11.9 is 11). `setting`
 * may be a value saved before `kids511` existed: its missing part takes
 * the default.
 */
export function preferredCovidForAge(
  ageYears: number | null | undefined,
  setting: PreferredCovidSettingInput = DEFAULT_PREFERRED_COVID
): PreferredCovidChoice | null {
  if (ageYears === null || ageYears === undefined || !Number.isFinite(ageYears) || ageYears < 0) return null;
  const age = Math.floor(ageYears);
  if (age < COVID_MIN_AGE) return null;
  if (age >= COVID_ADULT_MIN_AGE) {
    const option = PREFERRED_COVID_ADULT_OPTIONS.find((o) => o.value === setting.adult) ?? PREFERRED_COVID_ADULT_OPTIONS[0];
    return { band: "12+", label: option.label, shortCode: option.shortCode };
  }
  if (age >= COVID_KIDS511_MIN_AGE) {
    const option =
      PREFERRED_COVID_KIDS511_OPTIONS.find((o) => o.value === (setting.kids511 ?? DEFAULT_PREFERRED_COVID.kids511)) ??
      PREFERRED_COVID_KIDS511_OPTIONS[0];
    return { band: "5-11", label: option.label, shortCode: option.shortCode };
  }
  const option = PREFERRED_COVID_KIDS_OPTIONS.find((o) => o.value === setting.kids) ?? PREFERRED_COVID_KIDS_OPTIONS[0];
  return { band: "3-4", label: option.label, shortCode: option.shortCode };
}
