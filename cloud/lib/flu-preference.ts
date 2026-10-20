/**
 * Preferred flu product by patient age (Will 2026-10-18, verbatim:
 * "Flucelvax is available for 3+ and most preferred for age 3-49,
 * mflusiva is approved for 50+ and most preferred for 50-64, fluad is
 * approved for 65+ and preferred for 65+."; 2026-10-20 V-Q11: ordering
 * recommendations switch 50-64 from Flucelvax to mFLUSIVA too).
 *
 * The cloud's single copy of that rule. Three consumers read it so they
 * can never disagree: the macro-codes "F" hotkey (lib/macro-hotkeys.ts),
 * the Ordering tab's flu appointment attribution (lib/acuity-client.ts's
 * flu age band + lib/ordering-flu-mapping.ts). The desktop app keeps its
 * own C# copy (FluPreference/FluPreferenceRules.cs) for the preferred-flu
 * prompt - same numbers, same boundaries.
 *
 * Pure (no server-only imports) so client and server code can share it.
 */

export type FluPreferredKey = "flucelvax" | "mflusiva" | "fluad";

export type FluPreferredProduct = {
  key: FluPreferredKey;
  displayName: string;
  /** Macro-catalog short codes (lib/macro-catalog.ts), in order of preference. */
  shortCodes: readonly string[];
  /** Preferred band start, years, inclusive. */
  minAge: number;
  /** Preferred band end, years, inclusive; null = no upper limit. */
  maxAge: number | null;
};

/** Youngest age the rule covers; younger patients have no preferred flu product. */
export const FLU_PREFERENCE_MIN_AGE = 3;

export const FLU_PREFERRED_PRODUCTS: readonly FluPreferredProduct[] = [
  { key: "flucelvax", displayName: "Flucelvax", shortCodes: ["flucelvaxmdv", "flucelvaxpfs"], minAge: 3, maxAge: 49 },
  { key: "mflusiva", displayName: "mFLUSIVA", shortCodes: ["mflusiva"], minAge: 50, maxAge: 64 },
  { key: "fluad", displayName: "Fluad", shortCodes: ["fluad"], minAge: 65, maxAge: null },
];

/** Whole years for banding: a fractional age (e.g. 49.9) counts as 49. Null for a non-finite or negative value. */
function wholeYears(ageYears: number | null | undefined): number | null {
  if (ageYears === null || ageYears === undefined || !Number.isFinite(ageYears) || ageYears < 0) return null;
  return Math.floor(ageYears);
}

/** The preferred flu product for an age, or null when the age is unknown or under 3. */
export function preferredFluForAge(ageYears: number | null | undefined): FluPreferredProduct | null {
  const age = wholeYears(ageYears);
  if (age === null || age < FLU_PREFERENCE_MIN_AGE) return null;
  return FLU_PREFERRED_PRODUCTS.find((p) => age >= p.minAge && (p.maxAge === null || age <= p.maxAge)) ?? null;
}

/**
 * Ordering/appointment age bands, one per preferred product: "3-49" ->
 * Flucelvax, "50-64" -> mFLUSIVA, "65+" -> Fluad. Derived from the table
 * above so the bands cannot drift from the preference rule.
 */
export type FluOrderingBand = "3-49" | "50-64" | "65+";

const BAND_BY_KEY: Record<FluPreferredKey, FluOrderingBand> = {
  flucelvax: "3-49",
  mflusiva: "50-64",
  fluad: "65+",
};

export function fluOrderingBandForAge(ageYears: number | null | undefined): FluOrderingBand | null {
  const product = preferredFluForAge(ageYears);
  return product ? BAND_BY_KEY[product.key] : null;
}

/** The preferred product an ordering band maps to. */
export function fluProductForOrderingBand(band: FluOrderingBand): FluPreferredProduct {
  const key = (Object.keys(BAND_BY_KEY) as FluPreferredKey[]).find((k) => BAND_BY_KEY[k] === band)!;
  return FLU_PREFERRED_PRODUCTS.find((p) => p.key === key)!;
}
