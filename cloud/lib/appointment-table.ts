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
 * see app/appointments/page.tsx's buildHeaderRows:
 *   - COVID column: group "COVID", subgroup the short brand label
 *     ("Pfizer"/"Mod"/"Any"), label the age bucket ("3-11"/"12-64"/"65+").
 *     Renders as a 3-row header: spanning "COVID" -> spanning brand ->
 *     leaf age.
 *   - Flu column: group "Flu", subgroup null, label the age bucket
 *     ("3-64"/"65+"/"Unk"). Renders as a 2-row header: spanning "Flu" ->
 *     leaf age (with the leaf cell's rowSpan covering the 3rd header row
 *     too, since Flu has no brand level).
 *   - Every other column: group null, subgroup null, label the short
 *     vaccine name ("MMR", "Tdap", ...). Renders as a single cell
 *     spanning all 3 header rows.
 */
export type AppointmentTableColumn = {
  vaccineName: string;
  group: "COVID" | "Flu" | null;
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
 * ROUND 2), always rendered — see buildAppointmentTable. `id` is the
 * stable column key; `label` is the leaf header text; `subgroup` is the
 * short brand label for a COVID column (null for everything else) — see
 * AppointmentTableColumn's doc comment for how these render as a nested
 * header.
 */
type FixedColumn = { id: string; label: string; group: "COVID" | "Flu" | null; subgroup: string | null };

const FIXED_COLUMNS: FixedColumn[] = [
  { id: "pfizer_12-64", label: "12-64", group: "COVID", subgroup: "Pfizer" },
  { id: "pfizer_65+", label: "65+", group: "COVID", subgroup: "Pfizer" },
  { id: "moderna_3-11", label: "3-11", group: "COVID", subgroup: "Mod" },
  { id: "moderna_12-64", label: "12-64", group: "COVID", subgroup: "Mod" },
  { id: "moderna_65+", label: "65+", group: "COVID", subgroup: "Mod" },
  { id: "any_3-11", label: "3-11", group: "COVID", subgroup: "Any" },
  { id: "any_12-64", label: "12-64", group: "COVID", subgroup: "Any" },
  { id: "any_65+", label: "65+", group: "COVID", subgroup: "Any" },
  { id: "flu_3-64", label: "3-64", group: "Flu", subgroup: null },
  { id: "flu_65+", label: "65+", group: "Flu", subgroup: null },
  { id: "flu_unknown", label: "Unk", group: "Flu", subgroup: null },
  { id: "meningitis", label: "Meningitis", group: null, subgroup: null },
  { id: "typhoid", label: "Typhoid", group: null, subgroup: null },
  { id: "mmr", label: "MMR", group: null, subgroup: null },
  { id: "shingles", label: "Shingles", group: null, subgroup: null },
  { id: "pneumonia", label: "Pneumonia", group: null, subgroup: null },
  // Short label per Will (V-T-schedule-table ROUND 2): "Don't write
  // Tetanus/whooping cough, just write Tdap" — the canonical match
  // (matchCanonicalVaccineId's "tetanus" entry below) is unchanged, only
  // the displayed header text is shorter.
  { id: "tetanus", label: "Tdap", group: null, subgroup: null },
  { id: "rsv", label: "RSV", group: null, subgroup: null },
  { id: "hpv", label: "HPV", group: null, subgroup: null },
  { id: "hepA", label: "Hep A", group: null, subgroup: null },
  { id: "hepB", label: "Hep B", group: null, subgroup: null },
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

// Short header label per brand (Will, V-T-schedule-table ROUND 2: "Use
// short brand label 'Mod' for Moderna if space-tight"). Keyed by the
// brand text covidCompositeName actually writes (COVID_BRAND_LABELS in
// lib/acuity-client.ts), not the lowercase CovidBrand union.
const COVID_BRAND_DISPLAY: Record<string, string> = { Pfizer: "Pfizer", Moderna: "Mod", Any: "Any" };

// The 8 (brand, age) combos Will's mockup lists as fixed columns —
// Pfizer only ever splits at 65 (no 3-11 column: "still no <12"); Moderna
// and Any also get a 3-11 column. Every other combo a real COVID
// composite could carry (e.g. a Pfizer with age bucket "3-11", or any
// brand's Unknown age) is NOT in this map and falls through to the
// "extra column, appended, nonzero-only" path below.
const FIXED_COVID_COMBO_IDS: Record<string, string> = {
  "Pfizer|12-64": "pfizer_12-64",
  "Pfizer|65+": "pfizer_65+",
  "Moderna|3-11": "moderna_3-11",
  "Moderna|12-64": "moderna_12-64",
  "Moderna|65+": "moderna_65+",
  "Any|3-11": "any_3-11",
  "Any|12-64": "any_12-64",
  "Any|65+": "any_65+",
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
 * Tetanus (displayed as "Tdap") is deliberately careful about "td": Tdap
 * and "tetanus" are matched as ordinary substrings, but the bare "Td"
 * answer some intake forms use is dangerously short to substring-match
 * (it would false-positive inside unrelated text) — \btd\b requires it to
 * appear as its own whole word.
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
  { id: "tetanus", test: (n) => n.includes("tetanus") || n.includes("tdap") || /\btd\b/.test(n) },
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
  group: "COVID" | "Flu" | null;
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
    const [, brand, age] = covidMatch;
    const comboId = FIXED_COVID_COMBO_IDS[`${brand}|${age}`];
    if (comboId) {
      const fixed = FIXED_COLUMN_BY_ID.get(comboId)!;
      return { id: fixed.id, label: fixed.label, group: fixed.group, subgroup: fixed.subgroup, fixed: true };
    }
    // Unusual combo (e.g. a Pfizer recorded with age bucket "3-11", or
    // any brand's Unknown age) — never hide it, but it isn't one of the
    // fixed columns Will's mockup names.
    return { id: rawName, label: age, group: "COVID", subgroup: COVID_BRAND_DISPLAY[brand] ?? brand, fixed: false };
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
  // one poll TTL. NEVER hide it — give it its own column.
  return { id: rawName, label: rawName, group: null, subgroup: null, fixed: false };
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
 * column appended after them; extra columns are ordered alphabetically by
 * label for a deterministic (if arbitrary) tie-break — Will, V-T-schedule-
 * table: "your call, but deterministic."
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

  const fixedIds = FIXED_COLUMNS.map((c) => c.id);
  const fixedIdSet = new Set(fixedIds);
  const extraIds = Array.from(rowsById.keys())
    .filter((id) => !fixedIdSet.has(id))
    .sort((a, b) => columnsById.get(a)!.label.localeCompare(columnsById.get(b)!.label));

  const orderedIds = [...fixedIds, ...extraIds];
  const rows = orderedIds.map((id) => rowsById.get(id)!);
  const columns = orderedIds.map((id) => columnsById.get(id)!);

  return { days, rows, columns, dailyTotals, grandTotal };
}
