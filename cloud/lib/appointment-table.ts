/**
 * Pure client-safe helper that reshapes the poll route's flat
 * {date, vaccineName, count} list (see VaccineCount in lib/acuity-client.ts)
 * into a vaccine-columns x day-rows table for app/appointments/page.tsx:
 * one row per exact vaccine name (V-T-something, Will 2026-08-19: "I want
 * to see the exact vaccines they are getting ... COVID-Pfizer,
 * COVID-Moderna, Flu, RSV, etc.", not the generic Acuity appointment-type
 * name), one column per day in the requested range, a per-vaccine 7-day
 * total column, and a daily-total row.
 *
 * ROUND 4 (V-T9 answer, Will 2026-09-05, verbatim feedback on ROUND 2/3):
 * "For COVID, combine the 'any' into the Pfizer since that is our
 * preferred option. I also need to be able to distinguish between the
 * vaccine columns easier ... color differentiation between covid, flu,
 * and everything else. For the everything else section, group them into
 * 'Common' and 'Other'. Common includes: Shingles Pneumonia Tdap RSV HPV,
 * then Other is everything else." Two structural changes from ROUND 2/3:
 *
 *   (a) The 3 "Any"-brand COVID columns are GONE — an Any-brand count now
 *   resolves onto the matching Pfizer column instead (Pfizer being the
 *   pharmacy's preferred default when no brand is specified). This merge
 *   happens HERE, in resolveColumn, at the column-resolution layer only —
 *   the raw composite name a count arrives with (built by
 *   covidCompositeName in lib/acuity-client.ts) still says
 *   "COVID · Any · {age}" in the cache/API `counts` list untouched, so a
 *   future round can un-merge (show "Any" as its own column again) with
 *   no data migration, just a code change here. See resolveColumn's own
 *   comment for the "Pfizer gains a 3-11 column" nuance this merge
 *   creates.
 *
 *   (b) The 10 non-COVID, non-Flu fixed columns split into two named
 *   groups instead of being ungrouped: "Common" (Shingles, Pneumonia,
 *   Tdap, RSV, HPV, in that order) and "Other" (Meningitis, Typhoid, MMR,
 *   Hep A, Hep B, plus any genuinely-unmatched extra column appended after
 *   them). Every column now belongs to exactly one of 4 groups — COVID,
 *   Flu, Common, or Other — so AppointmentTableColumn.group is no longer
 *   nullable; see that type's doc comment below.
 *
 * ROUND 2 (V-T-schedule-table, Will 2026-09-05, his mockup header row —
 * "Scheduled date | Total | Pfizer 12+ | Moderna 3-11 | Moderna 12+ | Any
 * brand | Flu <65 | Flu 65+ | Flu (unk) | Meningitis | Typhoid | MMR |
 * Shingles | Pneumonia | Tetanus | RSV | HPV | Hep A | Hep B" — then two
 * rounds of same-day amendments: (a) "Any brand" splits into Any 3-11/Any
 * 12+; (b) "headings need to be much more succinct ... make it look like
 * a chart" — short labels (Tdap, not Tetanus), a 65+ split added to EVERY
 * COVID brand (Pfizer 12-64/65+; Moderna and Any 3-11/12-64/65+; Flu
 * 3-64/65+/Unk), and a 3-level nested header for COVID (group -> brand ->
 * age) vs. 2-level for Flu (group -> age)): the vaccine dimension is no
 * longer purely dynamic. `buildAppointmentTable` now seeds a FIXED set of
 * columns (FIXED_COLUMNS below), in his exact order, that always render —
 * even at zero, even on an empty poll response — plus a small canonical-
 * name matcher (mirrors the contains/alias approach in
 * lib/vaccine-matching.ts) that resolves an incoming vaccineName onto one
 * of those fixed columns. Anything that doesn't resolve — an unrecognized
 * vaccine name, or an unusual COVID brand/age combo his mockup doesn't
 * list (e.g. a Pfizer 3-11, or any brand's Unknown-age bucket) — becomes
 * its own EXTRA column appended after the fixed set instead of being
 * dropped, so data is never hidden; in practice that "extra, appended,
 * only appears when it actually has a count" mechanism IS his "per-brand
 * Unknown-age columns ... render only when nonzero" ask — one mechanism
 * serves both.
 *
 * COVID and Flu keep the ROUND 1 trick of riding their age (and, for
 * COVID, brand) bucket through the cache as a composite name — see
 * covidCompositeName/fluCompositeName in lib/acuity-client.ts — because
 * the VaccineCount cache/API shape itself stays {date, vaccineName,
 * count} unchanged (requirement: canonical-column mapping happens HERE,
 * client-safe, not in the cache, so a stale cache row self-heals within
 * one poll TTL rather than needing a migration). This module parses those
 * composites back into columns; every other canonical vaccine (Meningitis,
 * Typhoid, MMR, Shingles, Pneumonia, Tdap, RSV, HPV, Hep A, Hep B) is
 * matched directly off its raw name here, with no cache-side involvement
 * at all.
 *
 * No PHI ever reaches this function — it only ever sees the already
 * aggregated counts the poll route returns, never raw appointment data.
 */

export type VaccineCount = {
  date: string; // "YYYY-MM-DD"
  vaccineName: string;
  count: number;
};

export type AppointmentTableRow = {
  vaccineName: string;
  countsByDay: Record<string, number>;
  total: number;
};

/**
 * One table column, in display order — `columns` and `rows` are always
 * the same length with columns[i].vaccineName === rows[i].vaccineName, so
 * a caller can zip them to render cells while using `columns` just for
 * the header. `vaccineName` here is a COLUMN KEY, not necessarily a raw
 * vaccine name: for a fixed column it's the column's stable id (e.g.
 * "pfizer_65+"); for an extra (unmatched, or unusual COVID combo) column
 * it's the exact composite/raw name that produced it, so two counts that
 * resolve to the same unmatched name still land in one column.
 *
 * `group`/`subgroup`/`label` describe the (up to 3-level) nested header —
 * see app/appointments/page.tsx's buildHeaderRows. Every column belongs
 * to exactly one of 4 groups (ROUND 4 — no more null/ungrouped columns):
 *   - COVID column: group "COVID", subgroup the short brand label
 *     ("Pfizer"/"Moderna" — "Any" no longer exists as a brand, see
 *     resolveColumn's ROUND 4 merge comment), label the age bucket
 *     ("3-11"/"12-64"/"65+"). Renders as a 3-row header: spanning "COVID"
 *     -> spanning brand -> leaf age.
 *   - Flu column: group "Flu", subgroup null, label the age bucket
 *     ("3-64"/"65+"/"Unk"). Renders as a 2-row header: spanning "Flu" ->
 *     leaf age (with the leaf cell's rowSpan covering the 3rd header row
 *     too, since Flu has no brand level).
 *   - Common column: group "Common", subgroup null, label the short
 *     vaccine name (Shingles, Pneumonia, Tdap, RSV, HPV). Same 2-row
 *     shape as Flu — a spanning "Common" cell over a leaf-label run.
 *   - Other column: group "Other", subgroup null, label the short vaccine
 *     name (Meningitis, Typhoid, MMR, Hep A, Hep B, plus any
 *     genuinely-unmatched extra column). Same 2-row shape as Common/Flu.
 */
export type AppointmentTableColumn = {
  vaccineName: string;
  group: "COVID" | "Flu" | "Common" | "Other";
  subgroup: string | null;
  label: string;
};

export type AppointmentTable = {
  days: string[];
  rows: AppointmentTableRow[];
  columns: AppointmentTableColumn[];
  dailyTotals: Record<string, number>;
  grandTotal: number;
};

/**
 * The fixed column set, in Will's exact mockup order (V-T-schedule-table
 * ROUND 2, regrouped ROUND 4 per his V-T9 answer), always rendered — see
 * buildAppointmentTable. `id` is the stable column key; `label` is the
 * leaf header text; `subgroup` is the short brand label for a COVID
 * column (null for every other group) — see AppointmentTableColumn's doc
 * comment for how these render as a nested header.
 *
 * ROUND 4 changes from ROUND 2/3: the 3 "Any"-brand COVID columns are
 * gone (merged into Pfizer, see resolveColumn) and Pfizer gains a 3-11
 * column it didn't have before (that merge's side effect — see
 * resolveColumn's comment); the 10 non-COVID/Flu columns are split into
 * "Common" (Shingles, Pneumonia, Tdap, RSV, HPV — Will's exact order) and
 * "Other" (Meningitis, Typhoid, MMR, Hep A, Hep B) instead of being
 * ungrouped.
 */
type FixedColumn = {
  id: string;
  label: string;
  group: "COVID" | "Flu" | "Common" | "Other";
  subgroup: string | null;
};

const FIXED_COLUMNS: FixedColumn[] = [
  { id: "pfizer_3-11", label: "3-11", group: "COVID", subgroup: "Pfizer" },
  { id: "pfizer_12-64", label: "12-64", group: "COVID", subgroup: "Pfizer" },
  { id: "pfizer_65+", label: "65+", group: "COVID", subgroup: "Pfizer" },
  { id: "moderna_3-11", label: "3-11", group: "COVID", subgroup: "Moderna" },
  { id: "moderna_12-64", label: "12-64", group: "COVID", subgroup: "Moderna" },
  { id: "moderna_65+", label: "65+", group: "COVID", subgroup: "Moderna" },
  { id: "flu_3-64", label: "3-64", group: "Flu", subgroup: null },
  { id: "flu_65+", label: "65+", group: "Flu", subgroup: null },
  { id: "flu_unknown", label: "Unk", group: "Flu", subgroup: null },
  // "Common" (Will, V-T9): "Common includes: Shingles Pneumonia Tdap RSV
  // HPV" — this exact order.
  { id: "shingles", label: "Shingles", group: "Common", subgroup: null },
  // Abbreviated (Will, V-T11): "If a name is long (ex: Pneumonia), you can
  // abbreviate it" — "Pneumo" so it never truncates with an ellipsis at
  // equal chart-column widths. Canonical match id ("pneumonia" below, and
  // the "pneumonia" entry in CANONICAL_VACCINE_MATCHERS) is unchanged.
  { id: "pneumonia", label: "Pneumo", group: "Common", subgroup: null },
  // Short label per Will (V-T-schedule-table ROUND 2): "Don't write
  // Tetanus/whooping cough, just write Tdap" — the canonical match
  // (matchCanonicalVaccineId's "tetanus" entry below) is unchanged, only
  // the displayed header text is shorter.
  { id: "tetanus", label: "Tdap", group: "Common", subgroup: null },
  { id: "rsv", label: "RSV", group: "Common", subgroup: null },
  { id: "hpv", label: "HPV", group: "Common", subgroup: null },
  // "Other" (Will, V-T9): "Other is everything else" — the remaining
  // fixed non-COVID/Flu/Common columns, plus any genuinely-unmatched
  // extra column (see buildAppointmentTable's extras-adjacency logic).
  // Abbreviated (Will, V-T11 — same "abbreviate long names" ask as
  // Pneumonia above): "Mening" so it never truncates with an ellipsis at
  // equal chart-column widths. Canonical match id/matcher unchanged.
  { id: "meningitis", label: "Mening", group: "Other", subgroup: null },
  { id: "typhoid", label: "Typhoid", group: "Other", subgroup: null },
  { id: "mmr", label: "MMR", group: "Other", subgroup: null },
  { id: "hepA", label: "Hep A", group: "Other", subgroup: null },
  { id: "hepB", label: "Hep B", group: "Other", subgroup: null },
];

const FIXED_COLUMN_BY_ID = new Map(FIXED_COLUMNS.map((c) => [c.id, c]));

// Matches the exact composite names covidCompositeName/fluCompositeName
// (lib/acuity-client.ts) build — "COVID · Pfizer · 12-64", "Flu · 3-64",
// etc. Keep these in sync with that module if the format ever changes.
const COVID_COMPOSITE_PATTERN = /^COVID · (Pfizer|Moderna|Any) · (3-11|12-64|65\+|Unknown)$/;
const FLU_COMPOSITE_PATTERN = /^Flu · (3-64|65\+|Unknown)$/;

/**
 * Converts a composite vaccine name (COVID's "COVID · {Brand} · {Age}" or
 * Flu's "Flu · {Age}" — built by covidCompositeName/fluCompositeName in
 * lib/acuity-client.ts) into a plain string lib/vaccine-matching.ts's
 * contains/alias matcher can actually match against a catalog name.
 *
 * Follow-up fix (V-T-schedule-table ROUND 2, Will 2026-09-05): the
 * composite format made every COVID and Flu appointment invisible to
 * app/api/ordering/recommendation/route.ts's upcoming7d count — it called
 * matchVaccineName directly on the aggregated vaccineName, and a string
 * like "COVID · Pfizer · 65+" doesn't resemble any catalog name/alias.
 * That was a REGRESSION for Flu (a real name like "Flu Quad 2025-26" used
 * to match fine before ROUND 2 introduced Flu compositing) and a LATENT
 * gap for COVID going all the way back to ROUND 1 (nothing ever exercised
 * it with a test). This is the fix: strip the age segment always —
 * Ordering aggregates demand across ages per product, it doesn't stock
 * separately by age bucket — and keep the brand for COVID, since brand
 * genuinely determines which catalog product to order more of:
 *   - "COVID · Pfizer · <age>" -> "COVID Pfizer" (see the "covid pfizer"
 *     alias in lib/vaccine-matching.ts, added alongside this function).
 *   - "COVID · Moderna · <age>" -> "COVID Moderna" (see "covid moderna").
 *   - "COVID · Any · <age>" -> "COVID" (brandless — the patient expressed
 *     no brand preference, so there IS no single right catalog product;
 *     left to the alias table's "covid" entry, which resolves to ONE
 *     specific product. Documented prototype tradeoff, not a bug to chase
 *     further: a brandless COVID appointment nudges the recommended order
 *     for whichever COVID product the alias happens to point at, rather
 *     than being split proportionally across products.)
 *   - "Flu · <age>" -> "Flu" (Flu was never brand-split by this feature —
 *     unlike COVID, there's no brand-preference form field for Flu — so
 *     this already ties for the SAME kind of ambiguity as brandless
 *     COVID: matchVaccineName's plain "contains" fallback resolves "Flu"
 *     to whichever Flu-ish catalog product it hits first, e.g. "Flu Quad
 *     2025-26" or "Afluria MDV". Same documented tradeoff, no alias
 *     needed since "flu" already substring-matches those names directly.)
 * A non-composite name (anything COVID_COMPOSITE_PATTERN/
 * FLU_COMPOSITE_PATTERN don't recognize) passes through completely
 * untouched — this only ever rewrites the two composite shapes this
 * module itself parses elsewhere (see resolveColumn above).
 */
export function compositeNameToMatchableBase(rawName: string): string {
  const covidMatch = COVID_COMPOSITE_PATTERN.exec(rawName);
  if (covidMatch) {
    const brand = covidMatch[1];
    return brand === "Any" ? "COVID" : `COVID ${brand}`;
  }

  const fluMatch = FLU_COMPOSITE_PATTERN.exec(rawName);
  if (fluMatch) return "Flu";

  return rawName;
}

// Header label per brand. ROUND 2 originally shortened Moderna to "Mod";
// Will's V-T11 answer reversed that ("change Mod to Moderna since we have
// room") now that the tightened spacing/abbreviation pass elsewhere frees
// up the width. Keyed by the brand text covidCompositeName actually writes
// (COVID_BRAND_LABELS in lib/acuity-client.ts), not the lowercase
// CovidBrand union. "Any" is still here (ROUND 4) only as a defensive
// fallback — resolveColumn always remaps an "Any" brand to "Pfizer" before
// this map is consulted (see MERGE_ANY_INTO_BRAND below), so in normal
// operation this key is never actually looked up.
const COVID_BRAND_DISPLAY: Record<string, string> = { Pfizer: "Pfizer", Moderna: "Moderna", Any: "Any" };

/**
 * ROUND 4 merge (Will, V-T9 answer): "combine the 'any' into the Pfizer
 * since that is our preferred option." Applied at the very top of
 * resolveColumn's COVID branch, BEFORE any fixed-combo/extra-column
 * lookup, so every downstream decision (which fixed column, what
 * subgroup label, what synthetic extra-column id) already sees "Pfizer"
 * and never sees "Any" again. The raw composite name in the cache/count
 * entry is untouched by this — see this module's ROUND 4 doc comment.
 */
function mergeAnyIntoPfizer(brand: string): string {
  return brand === "Any" ? "Pfizer" : brand;
}

// The 6 (brand, age) combos Will's mockup lists as fixed columns, POST
// ROUND-4 Any->Pfizer merge. Pfizer now gets all 3 age buckets (3-11,
// 12-64, 65+) instead of just 2 — the 3-11 column is new, and exists
// SOLELY because an Any-brand 3-11 count merges here (see
// resolveColumn's comment on the "no real Pfizer-brand 3-11 patient"
// nuance); Moderna is unchanged. Every other combo a real COVID
// composite could carry (e.g. either brand's Unknown age) is NOT in this
// map and falls through to the "extra column, appended, nonzero-only"
// path below.
const FIXED_COVID_COMBO_IDS: Record<string, string> = {
  "Pfizer|3-11": "pfizer_3-11",
  "Pfizer|12-64": "pfizer_12-64",
  "Pfizer|65+": "pfizer_65+",
  "Moderna|3-11": "moderna_3-11",
  "Moderna|12-64": "moderna_12-64",
  "Moderna|65+": "moderna_65+",
};

const FLU_COMBO_IDS: Record<string, string> = {
  "3-64": "flu_3-64",
  "65+": "flu_65+",
  Unknown: "flu_unknown",
};

/**
 * Small alias/contains matcher for the 10 non-COVID, non-Flu canonical
 * vaccine columns — mirrors the strategy in lib/vaccine-matching.ts
 * (exact/alias/contains against a small known-variants list) rather than
 * reusing it directly, since that module matches against a live DB
 * catalog (CatalogVaccine[]) and this one matches against a fixed,
 * hardcoded column list. `test` runs against an already-lowercased name.
 *
 * Tetanus (displayed as "Tdap") is deliberately careful about "td": Tdap,
 * "tetanus", and its brand names (Boostrix, Adacel, Tenivac) are matched
 * as ordinary substrings, but the bare "Td" answer some intake forms use
 * is dangerously short to substring-match (it would false-positive inside
 * unrelated text) — \btd\b requires it to appear as its own whole word.
 */
const CANONICAL_VACCINE_MATCHERS: Array<{ id: string; test: (lower: string) => boolean }> = [
  {
    id: "meningitis",
    test: (n) => ["meningitis", "menactra", "menquadfi", "menveo"].some((s) => n.includes(s)),
  },
  { id: "typhoid", test: (n) => ["typhoid", "typhim"].some((s) => n.includes(s)) },
  { id: "mmr", test: (n) => n.includes("mmr") },
  { id: "shingles", test: (n) => ["shingles", "shingrix", "zoster"].some((s) => n.includes(s)) },
  {
    id: "pneumonia",
    test: (n) => ["pneumonia", "prevnar", "pneumovax", "pcv"].some((s) => n.includes(s)),
  },
  {
    id: "tetanus",
    test: (n) =>
      ["tetanus", "tdap", "boostrix", "adacel", "tenivac"].some((s) => n.includes(s)) || /\btd\b/.test(n),
  },
  { id: "rsv", test: (n) => ["rsv", "abrysvo", "arexvy"].some((s) => n.includes(s)) },
  { id: "hpv", test: (n) => ["hpv", "gardasil"].some((s) => n.includes(s)) },
  {
    id: "hepA",
    test: (n) => ["hep a", "havrix", "vaqta", "hepatitis a"].some((s) => n.includes(s)),
  },
  {
    id: "hepB",
    test: (n) => ["hep b", "heplisav", "engerix", "hepatitis b"].some((s) => n.includes(s)),
  },
];

function matchCanonicalVaccineId(rawName: string): string | null {
  const lower = rawName.toLowerCase();
  for (const matcher of CANONICAL_VACCINE_MATCHERS) {
    if (matcher.test(lower)) return matcher.id;
  }
  return null;
}

/**
 * True for a raw (non-composite) name that looks Flu-ish — mirrors
 * isFluVaccineName in lib/acuity-client.ts. Used only as a stale-cache
 * self-heal: a VaccineCount row cached before this ROUND 2 flu-age-split
 * shipped carries a plain "Flu Shot"-style name with no age info at all,
 * so it's routed to the fixed Flu Unk column rather than spawning a
 * duplicate extra column. Any freshly aggregated Flu count already
 * arrives as a "Flu · {Age}" composite and matches FLU_COMPOSITE_PATTERN
 * before this is ever consulted.
 */
function looksFluLike(rawName: string): boolean {
  const lower = rawName.toLowerCase();
  return lower.includes("flu") || lower.includes("influenza") || lower.includes("flumist");
}

type ResolvedColumn = {
  id: string;
  label: string;
  group: "COVID" | "Flu" | "Common" | "Other";
  subgroup: string | null;
  fixed: boolean;
};

/**
 * Resolves one incoming (already-aggregated) vaccineName onto a column:
 * one of the FIXED_COLUMNS when it matches, or a synthesized "extra"
 * column (fixed: false) that buildAppointmentTable appends after the
 * fixed set and only ever creates when a count actually needs it — see
 * this module's doc comment for why that IS the "Unknown-age columns
 * render only when nonzero" rule, not a separate case.
 */
function resolveColumn(rawName: string): ResolvedColumn {
  const covidMatch = COVID_COMPOSITE_PATTERN.exec(rawName);
  if (covidMatch) {
    const [, rawBrand, age] = covidMatch;
    // ROUND 4 (Will, V-T9): merge "Any" into "Pfizer" before anything
    // else below ever sees the brand — see mergeAnyIntoPfizer's comment.
    //
    // NUANCE this merge creates (doc-commented per the brief): Pfizer now
    // has a 3-11 column even though Pfizer itself is never actually given
    // to a 3-11 patient ("still no <12" — the original ROUND 2 spec).
    // That column exists ONLY because an Any-brand (no preference stated)
    // appointment for a 3-11 patient lands here: the pharmacy fulfills
    // that visit with whatever brand is age-appropriate (in practice,
    // Moderna, since Pfizer's own product line starts at 12), but the
    // COLUMN is keyed by brand PREFERENCE, not brand FULFILLMENT — and
    // "no preference stated" defaults to the Pfizer bucket. So
    // "pfizer_3-11" reads as "no-brand-preference patients age 3-11," not
    // literally "Pfizer doses given to 3-11 patients."
    const brand = mergeAnyIntoPfizer(rawBrand);
    const comboId = FIXED_COVID_COMBO_IDS[`${brand}|${age}`];
    if (comboId) {
      const fixed = FIXED_COLUMN_BY_ID.get(comboId)!;
      return { id: fixed.id, label: fixed.label, group: fixed.group, subgroup: fixed.subgroup, fixed: true };
    }
    // Unusual combo (currently: either brand's Unknown age) — never hide
    // it, but it isn't one of the fixed columns Will's mockup names. The
    // synthetic id is keyed by the (already-merged) brand + age, NOT the
    // raw composite string, so e.g. an "Any"-brand Unknown-age count and
    // a native Pfizer Unknown-age count land in the SAME extra column
    // (Will, V-T9: "Per-brand Unknown still nonzero-only (Any-unknown →
    // Pfizer-unknown)") instead of two side-by-side "Unk" columns both
    // labeled "Pfizer".
    return {
      id: `covid_${brand.toLowerCase()}_${age.toLowerCase()}`,
      label: age,
      group: "COVID",
      subgroup: COVID_BRAND_DISPLAY[brand] ?? brand,
      fixed: false,
    };
  }

  const fluMatch = FLU_COMPOSITE_PATTERN.exec(rawName);
  if (fluMatch) {
    const comboId = FLU_COMBO_IDS[fluMatch[1]];
    const fixed = FIXED_COLUMN_BY_ID.get(comboId)!;
    return { id: fixed.id, label: fixed.label, group: fixed.group, subgroup: fixed.subgroup, fixed: true };
  }

  const canonicalId = matchCanonicalVaccineId(rawName);
  if (canonicalId) {
    const fixed = FIXED_COLUMN_BY_ID.get(canonicalId)!;
    return { id: fixed.id, label: fixed.label, group: fixed.group, subgroup: fixed.subgroup, fixed: true };
  }

  if (looksFluLike(rawName)) {
    const fixed = FIXED_COLUMN_BY_ID.get("flu_unknown")!;
    return { id: fixed.id, label: fixed.label, group: fixed.group, subgroup: fixed.subgroup, fixed: true };
  }

  // Genuinely unmatched — e.g. a brand-new vaccine type, or a stale
  // pre-composite raw COVID name ("COVID-Pfizer") that self-heals within
  // one poll TTL. NEVER hide it — give it its own column. ROUND 4: group
  // is "Other" (Will: "Other is everything else") rather than null, so it
  // still renders under a group header and sorts to the very end of the
  // table, after Other's own fixed columns — see buildAppointmentTable's
  // extras-adjacency logic, where "Other" being the LAST fixed group is
  // exactly what makes this land at the very end.
  return { id: rawName, label: rawName, group: "Other", subgroup: null, fixed: false };
}

/**
 * A count entry is normally {date, vaccineName, count} (VaccineCount
 * above). This also tolerates the OLD pre-pivot cached shape
 * {date, appointmentTypeName, count} — a row already sitting in
 * acuity_poll_cache when this change ships — by falling back to
 * appointmentTypeName, and finally to "Unknown", rather than grouping
 * under an "undefined" column or throwing. Stale rows self-heal within
 * one cache TTL (~5 min) once re-fetched from Acuity in the new shape.
 */
function resolveVaccineName(entry: VaccineCount | Record<string, unknown>): string {
  const withVaccineName = entry as { vaccineName?: unknown };
  if (typeof withVaccineName.vaccineName === "string" && withVaccineName.vaccineName.length > 0) {
    return withVaccineName.vaccineName;
  }
  const withTypeName = entry as { appointmentTypeName?: unknown };
  if (typeof withTypeName.appointmentTypeName === "string" && withTypeName.appointmentTypeName.length > 0) {
    return withTypeName.appointmentTypeName;
  }
  return "Unknown";
}

/**
 * `days` is the caller's canonical list of "YYYY-MM-DD" column headers —
 * every row and the daily-totals row are pre-seeded with 0 for each of
 * these so a vaccine/day with no appointments still renders a cell
 * instead of being omitted. Any count entry whose `date` isn't in `days`
 * is ignored rather than silently expanding the table (guards against a
 * stale poll response whose range doesn't line up with the current
 * day columns, e.g. mid-refresh).
 *
 * ROUND 2: `rows`/`columns` are seeded from FIXED_COLUMNS FIRST, in that
 * exact order, all zeroed — so every fixed column renders even when
 * `counts` is empty (a fresh poll with nothing scheduled, or Acuity
 * returning zero appointments). Each count entry is then resolved
 * (resolveColumn) onto either one of those fixed columns or a new "extra"
 * column; extra columns are ordered alphabetically by label within their
 * own group for a deterministic (if arbitrary) tie-break — Will,
 * V-T-schedule-table: "your call, but deterministic." — but a grouped
 * extra (an unusual COVID combo, currently the only kind that occurs) is
 * placed immediately adjacent to its own group's fixed run rather than at
 * the very end of the table (review fix, 2026-09-05): an ungrouped
 * alphabetical sort scattered COVID extras away from the main COVID
 * columns whenever another extra's label happened to sort between them,
 * which made buildHeaderRows (app/appointments/page.tsx) render multiple
 * disconnected "COVID" spanning header cells instead of one contiguous
 * one. ROUND 4: this is now generalized over all 4 groups (COVID, Flu,
 * Common, Other) instead of hardcoding just COVID/Flu — a genuinely
 * unmatched extra (group "Other", per resolveColumn's ROUND 4 fallback)
 * still lands at the very end, simply because "Other" is the LAST group
 * in FIXED_COLUMNS' order, not because of any special-cased branch.
 */
export function buildAppointmentTable(counts: VaccineCount[], days: string[]): AppointmentTable {
  const zeroedByDay = (): Record<string, number> => Object.fromEntries(days.map((day) => [day, 0]));

  const rowsById = new Map<string, AppointmentTableRow>();
  const columnsById = new Map<string, AppointmentTableColumn>();
  for (const fixed of FIXED_COLUMNS) {
    rowsById.set(fixed.id, { vaccineName: fixed.id, countsByDay: zeroedByDay(), total: 0 });
    columnsById.set(fixed.id, {
      vaccineName: fixed.id,
      group: fixed.group,
      subgroup: fixed.subgroup,
      label: fixed.label,
    });
  }

  const dailyTotals = zeroedByDay();
  let grandTotal = 0;

  for (const entry of counts) {
    if (!(entry.date in dailyTotals)) continue;

    const rawName = resolveVaccineName(entry);
    const resolved = resolveColumn(rawName);

    let row = rowsById.get(resolved.id);
    if (!row) {
      row = { vaccineName: resolved.id, countsByDay: zeroedByDay(), total: 0 };
      rowsById.set(resolved.id, row);
      columnsById.set(resolved.id, {
        vaccineName: resolved.id,
        group: resolved.group,
        subgroup: resolved.subgroup,
        label: resolved.label,
      });
    }

    row.countsByDay[entry.date] += entry.count;
    row.total += entry.count;
    dailyTotals[entry.date] += entry.count;
    grandTotal += entry.count;
  }

  const fixedIdSet = new Set(FIXED_COLUMNS.map((c) => c.id));
  const byLabel = (a: string, b: string) => columnsById.get(a)!.label.localeCompare(columnsById.get(b)!.label);

  // Bucket extras by group (generalized ROUND 4 over all 4 groups, not
  // just COVID/Flu) so each bucket can be inserted adjacent to its own
  // group's fixed run below, instead of one flat alphabetical sort that
  // would scatter e.g. a COVID extra away from the main COVID columns
  // whenever another extra's label happened to sort between them.
  const extraIdsByGroup: Record<AppointmentTableColumn["group"], string[]> = {
    COVID: [],
    Flu: [],
    Common: [],
    Other: [],
  };
  for (const id of rowsById.keys()) {
    if (fixedIdSet.has(id)) continue;
    extraIdsByGroup[columnsById.get(id)!.group].push(id);
  }
  for (const group of Object.keys(extraIdsByGroup) as Array<AppointmentTableColumn["group"]>) {
    extraIdsByGroup[group].sort(byLabel);
  }

  // Walk FIXED_COLUMNS in order, flushing each group's extras the moment
  // its contiguous fixed run ends — e.g. a COVID extra lands right after
  // "moderna_65+" (the last fixed COVID column) and right before
  // "flu_3-64" (the first fixed Flu column), so COVID stays one
  // contiguous header run for buildHeaderRows (app/appointments/page.tsx)
  // to group. "Other" is the LAST group in FIXED_COLUMNS, so a genuinely
  // unmatched extra (group "Other") always ends up at the very end of the
  // table without needing a separate special case.
  const orderedIds: string[] = [];
  let lastGroup: AppointmentTableColumn["group"] | null = null;
  for (const fixed of FIXED_COLUMNS) {
    if (lastGroup !== null && lastGroup !== fixed.group) orderedIds.push(...extraIdsByGroup[lastGroup]);
    orderedIds.push(fixed.id);
    lastGroup = fixed.group;
  }
  if (lastGroup !== null) orderedIds.push(...extraIdsByGroup[lastGroup]);

  const rows = orderedIds.map((id) => rowsById.get(id)!);
  const columns = orderedIds.map((id) => columnsById.get(id)!);

  return { days, rows, columns, dailyTotals, grandTotal };
}

/**
 * Per-column totals across an arbitrary VaccineCount[] list, with no `days`
 * dimension at all — used for the "After today" summary row (V-T9 answer,
 * Will 2026-09-05: "add a 'total vaccines remaining after today' row that
 * sums up all the future appointments too"), whose data comes from a
 * separate, further-out chunked fetch (see
 * lib/acuity-future-summary.ts's fetchAfterTodaySummary) rather than the
 * same `days`-bounded range buildAppointmentTable's caller uses for the
 * daily-breakdown table. Resolves each entry through the SAME
 * resolveColumn as buildAppointmentTable (so the ROUND 4 Any->Pfizer
 * merge and every fixed-column mapping apply identically here), but never
 * seeds zeroed fixed columns and never creates its own column list — a
 * caller looks values up by column id (e.g. against an existing
 * AppointmentTable's `columns`) via `byColumnId`.
 *
 * JUDGMENT CALL: if a count resolves to a column id that the caller's own
 * table doesn't have (e.g. a vaccine type that only appears in the
 * further-out future window and never in the near-term one), that count
 * still contributes to `total` but has nowhere to render as its own cell
 * — the caller's row simply won't have an entry for that id in
 * `byColumnId`. This mirrors the existing "extra columns only appear when
 * they actually have a count in the visible range" philosophy rather than
 * introducing a second column-discovery pass across two disjoint fetches;
 * documented tradeoff, not a bug, for what's still a single-pharmacy
 * prototype tool.
 */
export type ColumnTotals = {
  byColumnId: Record<string, number>;
  total: number;
};

export function buildColumnTotals(counts: VaccineCount[]): ColumnTotals {
  const byColumnId: Record<string, number> = {};
  let total = 0;

  for (const entry of counts) {
    const rawName = resolveVaccineName(entry);
    const resolved = resolveColumn(rawName);
    byColumnId[resolved.id] = (byColumnId[resolved.id] ?? 0) + entry.count;
    total += entry.count;
  }

  return { byColumnId, total };
}

/**
 * One labeled summary row for the table — "Today" and "Next 7 days" (see
 * computeTodayAndNext7Summaries below); app/appointments/page.tsx builds
 * an analogous shape for "After today" from a ColumnTotals (see that
 * type's doc comment) since that summary's data doesn't come from this
 * table's own `days` at all.
 */
export type TableSummaryRow = {
  label: string;
  byColumnId: Record<string, number>;
  total: number;
};

/**
 * Computes the "Today" and "Next 7 days" summary rows (V-T9 answer, Will
 * 2026-09-05: "So the rows should be 'Today' 'Next 7 days' 'After today'
 * then the breakdown for the next today and the following 7 days") purely
 * by slicing/summing an already-built AppointmentTable's own `days` — no
 * new Acuity data needed, since both summaries live entirely within the
 * 8-day range (today..today+7) app/api/acuity/poll/route.ts and
 * app/appointments/page.tsx already request for the daily breakdown.
 * ASSUMES `table.days[0]` is today (true for every caller today — both
 * request start=today) — degrades to an all-zero "Today" row rather than
 * throwing if `table.days` is ever empty.
 *
 * PARTITION SEMANTICS (reviewer fix, 2026-09-05, revising the original
 * ROUND 4 pick): "Today" and "Next 7 days" are a clean, non-overlapping
 * partition of this table's 8 daily-breakdown rows — "Today" is
 * `days[0]` only, "Next 7 days" is `days[1..7]` (today+1 through
 * today+7 inclusive, 7 calendar days, via `slice(1, 8)`), EXCLUDING
 * today. The original ROUND 2/4 pick (`days[0..6]`, today THROUGH
 * today+6) double-counted today in both rows — every appointment
 * scheduled today silently inflated "Next 7 days" too. "After today"
 * (computed elsewhere — see below) is NOT part of this partition: it
 * deliberately DOES overlap "Next 7 days" (both cover today+1 onward),
 * because Will's spec for it is "sums up all the future appointments,"
 * i.e. a cumulative running total from tomorrow out to the edge of the
 * extended fetch — not a third disjoint bucket. So the correct mental
 * model is: {Today} and {Next 7 days} partition today..+7 cleanly (no
 * overlap, no gap); "Next 7 days" ⊂ "After today" by design (every
 * appointment in the former is also in the latter); only "Today" is
 * disjoint from "After today".
 */
export function computeTodayAndNext7Summaries(table: AppointmentTable): {
  today: TableSummaryRow;
  next7: TableSummaryRow;
} {
  const todayDay: string | undefined = table.days[0];
  const next7Days = table.days.slice(1, 8);

  const todayByColumnId: Record<string, number> = {};
  const next7ByColumnId: Record<string, number> = {};
  for (const row of table.rows) {
    todayByColumnId[row.vaccineName] = todayDay ? (row.countsByDay[todayDay] ?? 0) : 0;
    next7ByColumnId[row.vaccineName] = next7Days.reduce((sum, day) => sum + (row.countsByDay[day] ?? 0), 0);
  }

  const todayTotal = todayDay ? (table.dailyTotals[todayDay] ?? 0) : 0;
  const next7Total = next7Days.reduce((sum, day) => sum + (table.dailyTotals[day] ?? 0), 0);

  return {
    today: { label: "Today", byColumnId: todayByColumnId, total: todayTotal },
    next7: { label: "Next 7 days", byColumnId: next7ByColumnId, total: next7Total },
  };
}

/**
 * ROUND 6 heatmap (V-T12 answer, Will 2026-09-05, verbatim): "color the
 * background a gradient based on the # of vaccines scheduled, so it's easy
 * to see when a large number vs small number are scheduled." Two pure,
 * deterministic pieces live here (client-safe, testable in isolation from
 * any React/inline-style concern) — app/appointments/page.tsx supplies the
 * per-cell `count`/`max` and turns the returned color into a cell style:
 *
 *   - heatmapCellBackground(count, max): the actual white -> green ramp.
 *   - computeHeatmapMaxes(...): the "two independent scales" split Will
 *     asked for — see its own doc comment.
 *
 * A single hue ramp (white -> a medium green) is used for BOTH scales —
 * only the max each scale normalizes against differs, never the hue —
 * per Will's own phrasing ("Use a single hue ramp").
 *
 * ROUND 6 follow-up (V-T14, Will 2026-09-05, verbatim): "Its decent. Let's
 * make the heatmap be green instead. And make sure it doesn't get so dark
 * that the black text contrast is bad." Swapped HEATMAP_PEAK_RGB from a
 * blue (rgb(30, 64, 175)) to Tailwind's green-600 (#16a34a — squarely in
 * the "medium green, 500-600 range" Will's ask suggested), and re-picked
 * HEATMAP_MAX_INTENSITY from scratch against the NEW peak rather than
 * reusing the old blue-tuned cap — a peak color swap changes the darkest
 * reachable color, so the contrast floor has to be re-verified, not
 * assumed.
 *
 * Cell text is ALWAYS plain black/default (review fix, 2026-09-05 —
 * reviewer's numerically-verified finding on the earlier blue ramp): a
 * white-text switch at a raw count/max ratio was net harmful there because
 * it didn't account for HEATMAP_MAX_INTENSITY scaling the ratio down before
 * it ever reaches the background. HEATMAP_MAX_INTENSITY is tuned below so
 * black text stays ≥4.5:1 (WCAG AA) against the background at EVERY ratio
 * from 0 to 1 — see the "heatmap contrast" test sweep in
 * tests/appointment-table.test.ts, which recomputes WCAG relative luminance
 * directly from heatmapCellBackground's own output so it keeps failing if
 * this constant (or the peak color) is ever tuned darker again — so no
 * text-color switch is needed at all; there's deliberately no
 * heatmapTextColor function.
 */

const HEATMAP_BASE_RGB = { r: 255, g: 255, b: 255 } as const;
// Full-saturation target the ramp interpolates toward — never actually
// reached at count===max because HEATMAP_MAX_INTENSITY below caps how far
// toward it a cell is allowed to go, so the darkest cell in any scale
// still leaves plain black cell text legible. Tailwind green-600 (#16a34a)
// — V-T14 (Will): "make the heatmap be green instead," "a medium green
// like the 500-600 range."
const HEATMAP_PEAK_RGB = { r: 22, g: 163, b: 74 } as const;
// Cap on how far a cell's color is allowed to travel from white toward
// HEATMAP_PEAK_RGB, even at count===max (V-T12: "cap the darkest step";
// V-T14: "make sure it doesn't get so dark that the black text contrast is
// bad"). At this green peak, 0.85 renders the darkest possible cell as
// rgb(57, 177, 101) — black-text contrast there is ~7.65:1, comfortably
// above the 4.5:1 WCAG AA floor (recomputed by hand for this exact peak —
// see the doc comment above on why the old blue-tuned cap couldn't just be
// reused) and still dark enough to read as a clear "high count" color, not
// a barely-tinted white. See the contrast regression test for the sweep
// that keeps this honest against future tweaks.
const HEATMAP_MAX_INTENSITY = 0.85;

/**
 * count<=0 or max<=0 (an all-zero scale — no division by zero) always
 * renders plain white, i.e. no tint (V-T12: "Zero = plain white"). A count
 * above max is clamped rather than overshooting the ramp.
 */
export function heatmapCellBackground(count: number, max: number): string {
  if (count <= 0 || max <= 0) return "#ffffff";
  const ratio = Math.min(count / max, 1) * HEATMAP_MAX_INTENSITY;
  const r = Math.round(HEATMAP_BASE_RGB.r + (HEATMAP_PEAK_RGB.r - HEATMAP_BASE_RGB.r) * ratio);
  const g = Math.round(HEATMAP_BASE_RGB.g + (HEATMAP_PEAK_RGB.g - HEATMAP_BASE_RGB.g) * ratio);
  const b = Math.round(HEATMAP_BASE_RGB.b + (HEATMAP_PEAK_RGB.b - HEATMAP_BASE_RGB.b) * ratio);
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * The "TWO INDEPENDENT SCALES" split (V-T12 answer, verbatim): "Today and
 * the daily breakdown would be its own scale, separate from the weekly and
 * remaining. Those would have their own scale. It wouldn't make sense to
 * have weekly numbers compared to daily numbers." So:
 *
 *   - `dailyScaleMax`: the max single-cell count across the "Today"
 *     summary row AND every day-by-day breakdown row (table.rows'
 *     countsByDay, every column, every day) — note this already fully
 *     covers "Today" on its own even without `todayByColumnId` supplied
 *     separately, since table.days[0] IS today and its own breakdown row
 *     carries the identical numbers; `todayByColumnId` is taken as an
 *     explicit input anyway so this function stays correct (and testable
 *     in isolation) even against a table that doesn't happen to include
 *     today's day.
 *   - `weeklyScaleMax`: the max single-cell count across the "Next 7 days"
 *     summary row and the (separately fetched, possibly not-yet-loaded)
 *     "After today" summary row.
 *
 * The Total column and the leftmost date-label column are deliberately
 * NEVER part of either scale (see app/appointments/page.tsx's render) —
 * totals are sums across many vaccine columns and would dwarf any single
 * vaccine's count, crushing the whole gradient into "everything near
 * zero except the Total column."
 *
 * An all-zero input (no data loaded yet, or a genuinely empty schedule)
 * returns {0, 0} rather than throwing or dividing by zero — callers pass
 * that straight into heatmapCellBackground, whose own `max <= 0` guard
 * already renders plain white for exactly this case.
 */
export function computeHeatmapMaxes(
  table: AppointmentTable,
  todayByColumnId: Record<string, number>,
  next7ByColumnId: Record<string, number>,
  afterTodayByColumnId: Record<string, number> | null
): { dailyScaleMax: number; weeklyScaleMax: number } {
  let dailyScaleMax = 0;
  for (const value of Object.values(todayByColumnId)) {
    dailyScaleMax = Math.max(dailyScaleMax, value);
  }
  for (const row of table.rows) {
    for (const day of table.days) {
      dailyScaleMax = Math.max(dailyScaleMax, row.countsByDay[day] ?? 0);
    }
  }

  let weeklyScaleMax = 0;
  for (const value of Object.values(next7ByColumnId)) {
    weeklyScaleMax = Math.max(weeklyScaleMax, value);
  }
  if (afterTodayByColumnId) {
    for (const value of Object.values(afterTodayByColumnId)) {
      weeklyScaleMax = Math.max(weeklyScaleMax, value);
    }
  }

  return { dailyScaleMax, weeklyScaleMax };
}
