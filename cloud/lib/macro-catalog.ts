/**
 * Static catalog for the /macro-codes tab's round-2 layout (Will's brief,
 * verbatim: "I had also asked you to follow the same format as the excel
 * file. I meant that. There should be a section for covid/flu vaccines
 * for age 3-11 and then for 12+, then a section for all the vaccines. It
 * should say the type of vaccine...").
 *
 * Built by hand from the "Macro codes" sheet's quick-view blocks (Age
 * 3-11 / Age 12+ / Alternative flu shots) and its main "All vaccines"
 * table's Type column + row order — see the brief's verbatim sheet
 * layout for the source. Keyed by short_code, lowercased. A single-dose
 * product's REAL short_code (e.g. "comirnaty12", "spikevax6mo11",
 * "prevnar20") is used as the key VERBATIM, digits and all — those
 * digits are part of the code itself (age range, package size), not an
 * appended dose suffix. A multi-dose product's real per-dose short_codes
 * (e.g. "shingrix1"/"shingrix2") are NOT individually keyed; instead
 * lookupMacroCatalog falls back to the digit-stripped BASE ("shingrix")
 * when the exact code isn't found — see macroBaseShortCode below and
 * this file's lookupMacroCatalog doc comment for why exact-match is
 * tried FIRST (it's what keeps "prevnar20"/"comirnaty12" from being
 * mis-stripped to "prevnar"/"comirnaty").
 */

export type MacroSection = "age3to11" | "age12plus" | "altFlu";

export type MacroCatalogEntry = {
  /** The sheet's "Type" column value, e.g. "Pfizer 12+", "Shingles". */
  type: string;
  /** Position in the sheet's "All vaccines" row order — lower sorts
   * first. Unknown short codes get MACRO_CATALOG_OTHER_ORDER (last). */
  sheetOrder: number;
  /** Which of the sheet's quick-view blocks this product appears in.
   * Empty for a product that's only in "All vaccines". */
  sections: readonly MacroSection[];
};

/** sheetOrder for a short code with no catalog entry — sorts after
 * every named type, per Will's "then a section for all the vaccines"
 * (unknowns still show, just last). */
export const MACRO_CATALOG_OTHER_ORDER = Number.MAX_SAFE_INTEGER;

export const MACRO_CATALOG_OTHER: MacroCatalogEntry = {
  type: "Other",
  sheetOrder: MACRO_CATALOG_OTHER_ORDER,
  sections: [],
};

/** Keyed by short_code (see this file's header for the exact-vs-base
 * key convention). Order here matches the sheet's "All vaccines" row
 * order — sheetOrder values below are just that position, 1-indexed. */
const MACRO_CATALOG: Readonly<Record<string, MacroCatalogEntry>> = {
  comirnaty12: { type: "Pfizer 12+", sheetOrder: 1, sections: ["age12plus"] },
  mnexspike: { type: "Moderna 12+", sheetOrder: 2, sections: ["age12plus"] },
  spikevax6mo11: { type: "Moderna 3-11", sheetOrder: 3, sections: ["age3to11"] },
  flucelvaxmdv: { type: "Flu (regular)", sheetOrder: 4, sections: [] },
  flucelvaxpfs: { type: "Flu (regular)", sheetOrder: 4, sections: ["age3to11", "age12plus"] },
  mflusiva: { type: "Flu (regular)", sheetOrder: 4, sections: ["altFlu"] },
  afluriapfs: { type: "Flu (regular)", sheetOrder: 4, sections: [] },
  fluad: { type: "Flu (65+)", sheetOrder: 5, sections: ["age12plus"] },
  fluzonehd: { type: "Flu (65+)", sheetOrder: 5, sections: [] },
  flumist: { type: "Flu (nasal)", sheetOrder: 6, sections: ["altFlu"] },
  arexvy: { type: "RSV", sheetOrder: 7, sections: [] },
  abrysvo: { type: "RSV (preg)", sheetOrder: 8, sections: [] },
  shingrix: { type: "Shingles", sheetOrder: 9, sections: [] },
  engerix: { type: "Hep B (adult)", sheetOrder: 10, sections: [] },
  prevnar20: { type: "Pneumonia 20", sheetOrder: 11, sections: [] },
  capvaxive: { type: "Pneumonia 21", sheetOrder: 12, sections: [] },
  boostrix: { type: "Tetanus (TDaP)", sheetOrder: 13, sections: [] },
  gardasil: { type: "HPV", sheetOrder: 14, sections: [] },
  menveo: { type: "Meningitis", sheetOrder: 15, sections: [] },
  vaqtaadult: { type: "Hepatitis A (19+)", sheetOrder: 16, sections: [] },
  typhim: { type: "Typhoid", sheetOrder: 17, sections: [] },
  mmr: { type: "MMR", sheetOrder: 18, sections: [] },
  priorix: { type: "MMR", sheetOrder: 19, sections: [] },
};

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
