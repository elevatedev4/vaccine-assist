/**
 * Static catalog for the /macro-codes tab.
 *
 * ROUND 4 (Will's brief, verbatim): "Remove the age ranges and
 * extraneous data from product names... Move age range and price to the
 * end of the row. Have a section (Flu, Pneumonia, RSV, etc) and then
 * have the product name/dose be inside a colored button... Showing the
 * product name and dose number if there are multiple doses." This
 * replaces round-3's two-family split ("fluCovid" vs "other") with a
 * per-catalog-Type `section` (Flu, COVID, Pneumonia, RSV, Shingles, Hep
 * B, Tetanus, HPV, Meningitis, Hep A, Typhoid, MMR, Other) derived via
 * the pure sectionForType below, so there's one place that decides
 * section membership (same posture as round-3's now-removed
 * macroFamilyForType). Names are no longer built here — round 4 uses
 * the ALREADY-cleaned `displayName` from lib/product-view.ts's
 * buildProductViews (see lib/macro-codes.ts).
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

/** One of round 4's product-grouping sections. "Other" catches any
 * short code with no catalog entry. Order matters — see
 * MACRO_SECTION_ORDER below, which is the section display order Will
 * asked for: "Flu, COVID, then the rest in sheet order." */
export type MacroSection =
  | "Flu"
  | "COVID"
  | "Pneumonia"
  | "RSV"
  | "Shingles"
  | "Hep B"
  | "Tetanus"
  | "HPV"
  | "Meningitis"
  | "Hep A"
  | "Typhoid"
  | "MMR"
  | "Other";

/** Display order of the round-4 sections: Flu and COVID first (in that
 * order, per Will's brief), then every other section in the sheet's
 * original Type row order (RSV=7/8, Shingles=9, Hep B=10, Pneumonia=
 * 11/12, Tetanus=13, HPV=14, Meningitis=15, Hep A=16, Typhoid=17, MMR=
 * 18/19 — see RAW_MACRO_CATALOG's sheetOrder values), and "Other" last. */
export const MACRO_SECTION_ORDER: readonly MacroSection[] = [
  "Flu",
  "COVID",
  "RSV",
  "Shingles",
  "Hep B",
  "Pneumonia",
  "Tetanus",
  "HPV",
  "Meningitis",
  "Hep A",
  "Typhoid",
  "MMR",
  "Other",
];

/** Index of `section` in MACRO_SECTION_ORDER, for sorting sections into
 * that display order. Unknown sections (shouldn't happen — MacroSection
 * is a closed union) sort last, same as "Other". */
export function macroSectionOrderIndex(section: MacroSection): number {
  const index = MACRO_SECTION_ORDER.indexOf(section);
  return index === -1 ? MACRO_SECTION_ORDER.length : index;
}

/**
 * ROUND 6 (Will's verbatim feedback, 2026-09-12, replying to the round-5
 * page): "'COVID/Flu' group. Pneumonia, RSV, Shingles, Tdap, HPV should
 * go in the middle under 'Common', then all others under 'Other'." Three
 * top-level groups the /macro-codes page lays out as its three columns,
 * each holding its member sections' family sub-headings in
 * MACRO_SECTION_ORDER's order. "Tdap" is the Tetanus section (Boostrix).
 */
export type MacroTopGroup = "COVID/Flu" | "Common" | "Other";

/** Column display order for the three top-level groups. */
export const MACRO_TOP_GROUP_ORDER: readonly MacroTopGroup[] = ["COVID/Flu", "Common", "Other"];

const TOP_GROUP_SECTIONS: Readonly<Record<Exclude<MacroTopGroup, "Other">, ReadonlySet<MacroSection>>> = {
  "COVID/Flu": new Set(["Flu", "COVID"]),
  Common: new Set(["Pneumonia", "RSV", "Shingles", "Tetanus", "HPV"]),
};

/** Derives a section's top-level group. Every section not explicitly
 * listed in TOP_GROUP_SECTIONS (Hep B, Meningitis, Hep A, Typhoid, MMR,
 * Other, and any future family) falls through to "Other" — same
 * closed-mapping-with-a-catch-all posture as sectionForType above. */
export function topGroupForSection(section: MacroSection): MacroTopGroup {
  for (const [group, sections] of Object.entries(TOP_GROUP_SECTIONS) as [Exclude<MacroTopGroup, "Other">, ReadonlySet<MacroSection>][]) {
    if (sections.has(section)) return group;
  }
  return "Other";
}

/** The sheet Type values that belong to each round-4 section. Every
 * catalog Type must appear in exactly one of these sets; anything not
 * listed (including a short code with no catalog entry at all) falls
 * through to "Other" in sectionForType. */
const SECTION_TYPES: Readonly<Record<Exclude<MacroSection, "Other">, ReadonlySet<string>>> = {
  COVID: new Set(["Pfizer 12+", "Moderna 12+", "Moderna 3-11"]),
  Flu: new Set(["Flu (regular)", "Flu (65+)", "Flu (nasal)", "Flu mRNA (50+)"]),
  Pneumonia: new Set(["Pneumonia 20", "Pneumonia 21"]),
  RSV: new Set(["RSV", "RSV (preg)"]),
  Shingles: new Set(["Shingles"]),
  "Hep B": new Set(["Hep B (adult)"]),
  Tetanus: new Set(["Tetanus (TDaP)"]),
  HPV: new Set(["HPV"]),
  Meningitis: new Set(["Meningitis"]),
  "Hep A": new Set(["Hepatitis A (19+)"]),
  Typhoid: new Set(["Typhoid"]),
  MMR: new Set(["MMR"]),
};

/** Derives a product's round-4 section from its catalog Type — the
 * single place that decides section membership. Exported for its own
 * unit test coverage. */
export function sectionForType(type: string): MacroSection {
  for (const [section, types] of Object.entries(SECTION_TYPES) as [Exclude<MacroSection, "Other">, ReadonlySet<string>][]) {
    if (types.has(type)) return section;
  }
  return "Other";
}

export type MacroCatalogEntry = {
  /** The sheet's "Type" column value, e.g. "Pfizer 12+", "Shingles". */
  type: string;
  /** Position in the sheet's row order — lower sorts first. Unknown
   * short codes get MACRO_CATALOG_OTHER_ORDER (last). Not used to order
   * a section's products (see lib/macro-codes.ts — sorted by
   * ageMinMonths, then sheetOrder, then name). */
  sheetOrder: number;
  /** Which round-4 section this product belongs to. */
  section: MacroSection;
  /** Short, human-readable approved age range, INCLUDING any
   * parenthetical/qualifier clause, e.g. "12+", "3–11", "6 mo+", "50+
   * (19+ IC)", "75+ (18+ high-risk)". "" for an unrecognized code. This
   * is the FULL label round-4/5/7's doseButtonLabel and
   * macroProductNameWithAge flatten for versions A/B — kept exactly as
   * it always was (round 9 below adds ageBase/note for version C
   * alongside this field, without touching it, so A/B's output stays
   * byte-identical). */
  age: string;
  /** ROUND 9 (Will's verbatim feedback, 2026-09-13, /macro-codes round
   * 8 in his own numbering — continuing this file's internal ROUND
   * count after round 8's A/B/C switcher): version C's compact base age
   * range with any qualifier clause stripped out, e.g. "50+" for
   * Shingrix (whose `age` is "50+ (19+ IC)"), "75+" for Abrysvo (whose
   * `age` is "75+ (18+ high-risk)"). Equal to `age` verbatim for a
   * product with no qualifier. "" for an unrecognized code. */
  ageBase: string;
  /** ROUND 9: a special-qualification note surfaced via version C's ⓘ
   * icon/tooltip, e.g. "19+ if immunocompromised" (Shingrix), "2–18
   * high-risk" (Prevnar 20), "18+ if high risk" (Abrysvo), "2–17
   * high-risk" (Capvaxive), "50–59 high-risk" (Arexvy). Undefined for a
   * product with no qualification — see RAW_MACRO_CATALOG below for the
   * full base/note table. */
  note?: string;
  /** Numeric floor of `age`, in months, for sorting a section's products
   * youngest-eligible-first. An unrecognized code sorts last. */
  ageMinMonths: number;
  /** ROUND 10 (Will's verbatim feedback, 2026-09-13): "Add one tiny
   * deemphasized line on the buttons for 1-3 dose items that includes
   * the schedule for when to get those doses." Keyed by dose NUMBER
   * (2, 3, ...) to the interval text for THAT dose, stated as time
   * AFTER THE PREVIOUS DOSE — e.g. Shingrix's {2: "2 mo"} means "give
   * dose 2 two months after dose 1." Never keyed at 1 (a first dose has
   * no "after the previous dose" interval by definition) and undefined
   * entirely for a single-dose product. See lib/macro-codes.ts's
   * buildMacroRows for how this becomes each dose row's `doseInterval`
   * (undefined for dose 1 and for single-dose products, regardless of
   * whether the product even has a doseSchedule). */
  doseSchedule?: Readonly<Record<number, string>>;
  /** V-T50 (Will's verbatim feedback, 2026-09-18): "flu shots to be
   * different colors on their buttons to easily tell them apart" — the
   * key lib/macro-dose-button.tsx's PRODUCT_COLORS looks a product up
   * by, e.g. "flucelvax" for BOTH flucelvaxmdv/flucelvaxpfs (two real
   * short codes, one product/color), "mflusiva", "flumist". Defaults to
   * the short_code this entry is keyed under (see MACRO_CATALOG's
   * construction below) when a product doesn't need to share a color key
   * with a sibling short code. */
  colorKey: string;
};

/** sheetOrder for a short code with no catalog entry — sorts after
 * every named type (unknowns still show, just last). */
export const MACRO_CATALOG_OTHER_ORDER = Number.MAX_SAFE_INTEGER;

export const MACRO_CATALOG_OTHER: MacroCatalogEntry = {
  type: "Other",
  sheetOrder: MACRO_CATALOG_OTHER_ORDER,
  section: "Other",
  age: "",
  ageBase: "",
  ageMinMonths: Number.MAX_SAFE_INTEGER,
  colorKey: "",
};

type RawCatalogEntry = {
  type: string;
  sheetOrder: number;
  age: string;
  ageBase: string;
  note?: string;
  ageMinMonths: number;
  doseSchedule?: Readonly<Record<number, string>>;
  /** Overrides the default colorKey (the short_code this entry is keyed
   * under) — see MacroCatalogEntry.colorKey above. Only set where two
   * distinct short codes must share one product color (flucelvaxmdv/
   * flucelvaxpfs -> "flucelvax"). */
  colorKey?: string;
};

/** Keyed by short_code (see this file's header for the exact-vs-base
 * key convention). sheetOrder values are the sheet's original row
 * position (1-indexed) and are kept for stability/tie-breaking even
 * though section display order is now driven by MACRO_SECTION_ORDER.
 *
 * ROUND 9 (Will's verbatim feedback, 2026-09-13): `ageBase`/`note` split
 * out of `age`'s qualifier clause for version C's compact age line + ⓘ
 * tooltip — `age` itself is untouched (still the full label A/B use).
 * Hand-edited per product below rather than parsed out of `age`, since
 * three of the five notes reword the source clause for a clearer
 * tooltip (Shingrix "19+ IC" -> "19+ if immunocompromised", Abrysvo
 * "18+ high-risk" -> "18+ if high risk") rather than just stripping
 * parens — a generic parser can't produce that wording.
 *
 * ROUND 10 (Will's verbatim feedback, 2026-09-13): adds `doseSchedule`
 * (see MacroCatalogEntry's doc comment) to every multi-dose product
 * Will gave an interval for — Shingrix, Gardasil 9, Engerix-B, Vaqta,
 * M-M-R II (NOT Priorix, a distinct MMR product Will's brief didn't
 * mention) — hand-entered per his exact figures, each stated as time
 * after the PREVIOUS dose. */
const RAW_MACRO_CATALOG: Readonly<Record<string, RawCatalogEntry>> = {
  comirnaty12: { type: "Pfizer 12+", sheetOrder: 1, age: "12+", ageBase: "12+", ageMinMonths: 144 },
  mnexspike: { type: "Moderna 12+", sheetOrder: 2, age: "12+", ageBase: "12+", ageMinMonths: 144 },
  spikevax6mo11: { type: "Moderna 3-11", sheetOrder: 3, age: "3–11", ageBase: "3–11", ageMinMonths: 36 },
  flucelvaxmdv: {
    type: "Flu (regular)",
    sheetOrder: 4,
    age: "6 mo+",
    ageBase: "6 mo+",
    ageMinMonths: 6,
    colorKey: "flucelvax",
  },
  flucelvaxpfs: {
    type: "Flu (regular)",
    sheetOrder: 4,
    age: "6 mo+",
    ageBase: "6 mo+",
    ageMinMonths: 6,
    colorKey: "flucelvax",
  },
  mflusiva: { type: "Flu mRNA (50+)", sheetOrder: 20, age: "50+", ageBase: "50+", ageMinMonths: 600 },
  afluriapfs: { type: "Flu (regular)", sheetOrder: 4, age: "6 mo+", ageBase: "6 mo+", ageMinMonths: 6 },
  fluad: { type: "Flu (65+)", sheetOrder: 5, age: "65+", ageBase: "65+", ageMinMonths: 780 },
  fluzonehd: { type: "Flu (65+)", sheetOrder: 5, age: "65+", ageBase: "65+", ageMinMonths: 780 },
  flumist: { type: "Flu (nasal)", sheetOrder: 6, age: "2–49", ageBase: "2–49", ageMinMonths: 24 },
  arexvy: { type: "RSV", sheetOrder: 7, age: "60+ (50–59 high-risk)", ageBase: "60+", note: "50–59 high-risk", ageMinMonths: 600 },
  // ROUND 9 macro-round9 (Will verbatim, 2026-09-13): "Abrysvo should be
  // marked 75+ and 18+ if high risk" — replaces the old "60+ / preg
  // 32–36 wk" age (that pregnancy-week qualifier is gone entirely, not
  // just reworded). ageMinMonths follows this file's established
  // pattern for a note that itself names a younger qualifying age (see
  // shingrix/prevnar20/capvaxive below): 18 * 12 = 216, not the 75+ base.
  abrysvo: {
    type: "RSV (preg)",
    sheetOrder: 8,
    age: "75+ (18+ high-risk)",
    ageBase: "75+",
    note: "18+ if high risk",
    ageMinMonths: 216,
  },
  shingrix: {
    type: "Shingles",
    sheetOrder: 9,
    age: "50+ (19+ IC)",
    ageBase: "50+",
    note: "19+ if immunocompromised",
    ageMinMonths: 228,
    doseSchedule: { 2: "2 mo" },
  },
  engerix: {
    type: "Hep B (adult)",
    sheetOrder: 10,
    age: "20+",
    ageBase: "20+",
    ageMinMonths: 240,
    doseSchedule: { 2: "1 mo", 3: "6 mo" },
  },
  prevnar20: {
    type: "Pneumonia 20",
    sheetOrder: 11,
    age: "19+ (2–18 high-risk)",
    ageBase: "19+",
    note: "2–18 high-risk",
    ageMinMonths: 24,
  },
  capvaxive: {
    type: "Pneumonia 21",
    sheetOrder: 12,
    age: "18+ (2–17 high-risk)",
    ageBase: "18+",
    note: "2–17 high-risk",
    ageMinMonths: 24,
  },
  boostrix: { type: "Tetanus (TDaP)", sheetOrder: 13, age: "10+", ageBase: "10+", ageMinMonths: 120 },
  gardasil: {
    type: "HPV",
    sheetOrder: 14,
    age: "9–45",
    ageBase: "9–45",
    ageMinMonths: 108,
    doseSchedule: { 2: "1–2 mo · 9–14: 6 mo", 3: "6 mo (15+)" },
  },
  menveo: { type: "Meningitis", sheetOrder: 15, age: "2 mo–55", ageBase: "2 mo–55", ageMinMonths: 2 },
  vaqtaadult: {
    type: "Hepatitis A (19+)",
    sheetOrder: 16,
    age: "19+",
    ageBase: "19+",
    ageMinMonths: 228,
    doseSchedule: { 2: "6 mo" },
  },
  typhim: { type: "Typhoid", sheetOrder: 17, age: "2+", ageBase: "2+", ageMinMonths: 24 },
  mmr: {
    type: "MMR",
    sheetOrder: 18,
    age: "12 mo+",
    ageBase: "12 mo+",
    ageMinMonths: 12,
    doseSchedule: { 2: "28 d · special groups" },
  },
  priorix: { type: "MMR", sheetOrder: 19, age: "12 mo+", ageBase: "12 mo+", ageMinMonths: 12 },
};

const MACRO_CATALOG: Readonly<Record<string, MacroCatalogEntry>> = Object.fromEntries(
  Object.entries(RAW_MACRO_CATALOG).map(([shortCode, entry]) => [
    shortCode,
    { ...entry, section: sectionForType(entry.type), colorKey: entry.colorKey ?? shortCode },
  ])
);

/**
 * V-T50 (Will's verbatim feedback, 2026-09-18): "mFLUSIVA is a flu shot,
 * move it to the flu shot section." The live `vaccine` row for mFLUSIVA
 * doesn't (yet) carry the "mflusiva" short_code (see
 * scripts/set-vaccine-fields.mjs's new --short-code flag for correcting
 * that at the DB level) so a short_code-only lookup misses and
 * lookupMacroCatalog falls through to "Other." This is a small,
 * name-substring safety net: when the short_code lookup misses entirely,
 * try matching the vaccine's NAME (case-insensitive substring) against
 * this table before giving up to MACRO_CATALOG_OTHER. Intentionally
 * covers ONLY mflusiva today — extend this table (never the fallback
 * logic itself) if a future product needs the same treatment. */
const NAME_FALLBACK_ALIASES: ReadonlyArray<{ substring: string; catalogKey: string }> = [
  { substring: "mflusiva", catalogKey: "mflusiva" },
  { substring: "flusiva", catalogKey: "mflusiva" },
];

/** Matches `name` (case-insensitive substring) against
 * NAME_FALLBACK_ALIASES, returning the aliased catalog entry or
 * MACRO_CATALOG_OTHER if nothing matches (or `name` is empty). Exported
 * for its own unit test coverage; lookupMacroCatalog below is the only
 * normal caller. */
export function lookupMacroCatalogByName(name: string | null | undefined): MacroCatalogEntry {
  const lowerName = (name ?? "").trim().toLowerCase();
  if (!lowerName) return MACRO_CATALOG_OTHER;
  for (const { substring, catalogKey } of NAME_FALLBACK_ALIASES) {
    if (lowerName.includes(substring)) {
      return MACRO_CATALOG[catalogKey] ?? MACRO_CATALOG_OTHER;
    }
  }
  return MACRO_CATALOG_OTHER;
}

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
 * multi-dose per-dose codes ("shingrix1" -> "shingrix").
 *
 * V-T50: when BOTH short_code attempts miss, and an optional `name` is
 * given, falls back to lookupMacroCatalogByName before giving up — see
 * that function's doc comment. Returns MACRO_CATALOG_OTHER, sorted last,
 * for anything still unrecognized.
 */
export function lookupMacroCatalog(shortCode: string, name?: string | null): MacroCatalogEntry {
  const lower = shortCode.trim().toLowerCase();
  const bySortCode = lower ? MACRO_CATALOG[lower] ?? MACRO_CATALOG[macroBaseShortCode(lower)] : undefined;
  if (bySortCode) return bySortCode;
  const byName = lookupMacroCatalogByName(name);
  return byName !== MACRO_CATALOG_OTHER ? byName : MACRO_CATALOG_OTHER;
}
