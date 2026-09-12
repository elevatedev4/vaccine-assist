/**
 * Static catalog for the /macro-codes tab.
 *
 * ROUND 3 (Will's brief, verbatim highlights): "Make the 'All vaccines'
 * section be 'Other vaccines' and don't include flu/covid. Add mFLUSIVA
 * and FluMist to the flu/covid section. Eliminate the age range
 * distinction in flu/covid and combine them. Arrange them by age. Add
 * an age column to show the approved age range for the vaccines." This
 * drops the round-2 "sections" (age3to11/age12plus/altFlu quick-view
 * blocks) entirely in favor of a single `family` split — "fluCovid" vs
 * "other" — plus a human-readable `age` label and a numeric
 * `ageMinMonths` for sorting the fluCovid family by age.
 *
 * Built by hand from the "Macro codes" sheet's Type column + row order,
 * and from Will's round-3 age table (verbatim per-product age ranges) —
 * see the brief for the source. Keyed by short_code, lowercased. A
 * single-dose product's REAL short_code (e.g. "comirnaty12",
 * "spikevax6mo11", "prevnar20") is used as the key VERBATIM, digits and
 * all — those digits are part of the code itself (age range, package
 * size), not an appended dose suffix. A multi-dose product's real
 * per-dose short_codes (e.g. "shingrix1"/"shingrix2") are NOT
 * individually keyed; instead lookupMacroCatalog falls back to the
 * digit-stripped BASE ("shingrix") when the exact code isn't found —
 * see macroBaseShortCode below and this file's lookupMacroCatalog doc
 * comment for why exact-match is tried FIRST (it's what keeps
 * "prevnar20"/"comirnaty12" from being mis-stripped to
 * "prevnar"/"comirnaty").
 */

/** "fluCovid" = every product whose catalog Type is a flu or COVID
 * type (Pfizer 12+, Moderna 12+, Moderna 3-11, Flu (regular),
 * Flu (65+), Flu (nasal) — this includes mFLUSIVA and FluMist);
 * "other" = everything else. Derived from `type` via
 * macroFamilyForType so there's one place that decides membership. */
export type MacroFamily = "fluCovid" | "other";

export type MacroCatalogEntry = {
  /** The sheet's "Type" column value, e.g. "Pfizer 12+", "Shingles". */
  type: string;
  /** Position in the sheet's "Other vaccines" row order — lower sorts
   * first. Unknown short codes get MACRO_CATALOG_OTHER_ORDER (last).
   * Not used for ordering the fluCovid family (that's by ageMinMonths). */
  sheetOrder: number;
  /** Which quick-view family this product belongs to. */
  family: MacroFamily;
  /** Short, human-readable approved age range, e.g. "12+", "3–11",
   * "6 mo+", "60+ (50–59 high-risk)". "" for an unrecognized code. */
  age: string;
  /** Numeric floor of `age`, in months, for sorting the fluCovid family
   * youngest-eligible-first. An unrecognized code sorts last. */
  ageMinMonths: number;
};

/** sheetOrder for a short code with no catalog entry — sorts after
 * every named type in the "Other vaccines" section (unknowns still
 * show, just last). */
export const MACRO_CATALOG_OTHER_ORDER = Number.MAX_SAFE_INTEGER;

export const MACRO_CATALOG_OTHER: MacroCatalogEntry = {
  type: "Other",
  sheetOrder: MACRO_CATALOG_OTHER_ORDER,
  family: "other",
  age: "",
  ageMinMonths: Number.MAX_SAFE_INTEGER,
};

/** The sheet Type values that belong in the combined Flu/COVID section
 * per Will's round-3 brief. Everything else is "other". */
const FLU_COVID_TYPES: ReadonlySet<string> = new Set([
  "Pfizer 12+",
  "Moderna 12+",
  "Moderna 3-11",
  "Flu (regular)",
  "Flu (65+)",
  "Flu (nasal)",
]);

/** Derives a product's family from its catalog Type — the single place
 * that decides fluCovid-vs-other membership. Exported for its own unit
 * test coverage. */
export function macroFamilyForType(type: string): MacroFamily {
  return FLU_COVID_TYPES.has(type) ? "fluCovid" : "other";
}

type RawCatalogEntry = { type: string; sheetOrder: number; age: string; ageMinMonths: number };

/** Keyed by short_code (see this file's header for the exact-vs-base
 * key convention). sheetOrder values are the "Other vaccines" section's
 * row position (1-indexed); the fluCovid entries carry a sheetOrder too
 * only for stability/tie-breaking, but display order for that family
 * comes from ageMinMonths instead (see lib/macro-codes.ts). */
const RAW_MACRO_CATALOG: Readonly<Record<string, RawCatalogEntry>> = {
  comirnaty12: { type: "Pfizer 12+", sheetOrder: 1, age: "12+", ageMinMonths: 144 },
  mnexspike: { type: "Moderna 12+", sheetOrder: 2, age: "12+", ageMinMonths: 144 },
  spikevax6mo11: { type: "Moderna 3-11", sheetOrder: 3, age: "3–11", ageMinMonths: 36 },
  flucelvaxmdv: { type: "Flu (regular)", sheetOrder: 4, age: "6 mo+", ageMinMonths: 6 },
  flucelvaxpfs: { type: "Flu (regular)", sheetOrder: 4, age: "6 mo+", ageMinMonths: 6 },
  mflusiva: { type: "Flu (regular)", sheetOrder: 4, age: "50+", ageMinMonths: 600 },
  afluriapfs: { type: "Flu (regular)", sheetOrder: 4, age: "6 mo+", ageMinMonths: 6 },
  fluad: { type: "Flu (65+)", sheetOrder: 5, age: "65+", ageMinMonths: 780 },
  fluzonehd: { type: "Flu (65+)", sheetOrder: 5, age: "65+", ageMinMonths: 780 },
  flumist: { type: "Flu (nasal)", sheetOrder: 6, age: "2–49", ageMinMonths: 24 },
  arexvy: { type: "RSV", sheetOrder: 7, age: "60+ (50–59 high-risk)", ageMinMonths: 600 },
  abrysvo: { type: "RSV (preg)", sheetOrder: 8, age: "60+ / preg 32–36 wk", ageMinMonths: 720 },
  shingrix: { type: "Shingles", sheetOrder: 9, age: "50+ (19+ IC)", ageMinMonths: 228 },
  engerix: { type: "Hep B (adult)", sheetOrder: 10, age: "20+", ageMinMonths: 240 },
  prevnar20: { type: "Pneumonia 20", sheetOrder: 11, age: "19+ (2–18 high-risk)", ageMinMonths: 24 },
  capvaxive: { type: "Pneumonia 21", sheetOrder: 12, age: "18+ (2–17 high-risk)", ageMinMonths: 24 },
  boostrix: { type: "Tetanus (TDaP)", sheetOrder: 13, age: "10+", ageMinMonths: 120 },
  gardasil: { type: "HPV", sheetOrder: 14, age: "9–45", ageMinMonths: 108 },
  menveo: { type: "Meningitis", sheetOrder: 15, age: "2 mo–55", ageMinMonths: 2 },
  vaqtaadult: { type: "Hepatitis A (19+)", sheetOrder: 16, age: "19+", ageMinMonths: 228 },
  typhim: { type: "Typhoid", sheetOrder: 17, age: "2+", ageMinMonths: 24 },
  mmr: { type: "MMR", sheetOrder: 18, age: "12 mo+", ageMinMonths: 12 },
  priorix: { type: "MMR", sheetOrder: 19, age: "12 mo+", ageMinMonths: 12 },
};

const MACRO_CATALOG: Readonly<Record<string, MacroCatalogEntry>> = Object.fromEntries(
  Object.entries(RAW_MACRO_CATALOG).map(([shortCode, entry]) => [
    shortCode,
    { ...entry, family: macroFamilyForType(entry.type) },
  ])
);

/** Lowercases and strips a trailing run of digits, e.g. "shingrix1" ->
 * "shingrix", "engerix3" -> "engerix". Pure and exported for its own
 * unit tests; NOT what every lookup uses on its own (see
 * lookupMacroCatalog) since a single-dose code's trailing digits are
 * sometimes the code itself ("comirnaty12"). */
export function macroBaseShortCode(shortCode: string): string {
  return shortCode.trim().toLowerCase().replace(/\d+$/, "");
}

/**
 * Resolves a real vaccine row's short_code to its catalog entry.
 * Tries the short_code VERBATIM (lowercased) first — this is what
 * correctly resolves single-dose codes whose trailing digits are part
 * of the code ("comirnaty12", "spikevax6mo11", "prevnar20") — and only
 * falls back to the digit-stripped base (macroBaseShortCode) for
 * multi-dose per-dose codes ("shingrix1" -> "shingrix"). Returns
 * MACRO_CATALOG_OTHER, sorted last, for anything unrecognized.
 */
export function lookupMacroCatalog(shortCode: string): MacroCatalogEntry {
  const lower = shortCode.trim().toLowerCase();
  if (!lower) return MACRO_CATALOG_OTHER;
  return MACRO_CATALOG[lower] ?? MACRO_CATALOG[macroBaseShortCode(lower)] ?? MACRO_CATALOG_OTHER;
}
