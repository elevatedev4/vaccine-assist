import { normalizeNdc } from "@/lib/ndc";

/**
 * Static product lookup for the Ordering tab's new "Doses/pkg", "Order
 * (doses)", "Order (pkg)" columns (V-T26 item 7, Will 2026-09-09) — NOT
 * derived from any table in this schema (`vaccine` has no
 * doses-per-package column). Populated 2026-09-09 from a research pass
 * over the pharmacy's ~27 active catalog vaccines (CDC Adult/Influenza
 * Vaccine Price Lists, manufacturer package inserts/PI, FDA label pages
 * — see each row's `source`); a name/NDC this app's catalog doesn't
 * carry yet simply has no row, and every lookup degrades to "unknown"
 * (null) rather than guessing — the Ordering page renders "—" for an
 * unknown doses/pkg (see cloud/app/ordering/page.tsx).
 *
 * Matched first by digits-only NDC (lib/ndc.ts's normalizeNdc — same
 * normalization every other NDC comparison in this app uses, so a
 * dashed or undashed NDC from the vaccine catalog matches either form
 * here, and a comma-joined multi-NDC field like Prevnar 20's
 * "00005-2000-10, 00005-2000-02" normalizes to just its FIRST NDC), then
 * by exact catalog vaccine name (case-insensitive, trimmed) — the
 * fallback for a product with no NDC on file yet — then by `namePrefix`
 * (case-insensitive startsWith) as a last resort for a name that's
 * expected to drift (Comirnaty's on-file name is due to be renamed
 * "Comirnaty 2026-27 12+" soon; `namePrefix: "Comirnaty"` keeps matching
 * either way).
 *
 * A multi-dose series (Gardasil 1/2/3, Engerix 1/2/3, Shingrix 1/2,
 * MMR-II 1/2, Vaqta adult 1/2) needs only ONE entry here: every dose row
 * shares the same catalog name and NDC (see
 * lib/ordering-ndc-collapse.ts's own doc comment for the same fact), so
 * one name/NDC match covers the whole series.
 *
 * TO ADD A ROW: paste one CatalogEntry object into CATALOG below, e.g.:
 *   {
 *     match: { ndc: "00006-4121-02", name: "Gardasil" },
 *     productName: "Gardasil 9",
 *     ageRange: "9-45",
 *     dosesPerPackage: 10,
 *     packageNdc: "00006-4121-10",
 *     source: "Merck package insert, 2026-09",
 *   },
 * `match.ndc`/`match.name`/`match.namePrefix` are all optional but at
 * least one should be set for the row to ever match anything.
 */

export type ProductCatalogMatch = {
  ndc?: string;
  name?: string;
  /** Case-insensitive startsWith fallback, tried after an exact `name`
   * miss — for a catalog name expected to change/version over time. */
  namePrefix?: string;
  /** Additional NDCs (V-T-ordering-lots-round4, Abrysvo repack: the
   * 10-count product's real on-file NDC changed, but on-hand (Pioneer
   * BOH) lines carrying the OLD/retired NDC, or the separate 1-count
   * product's own NDC, must still resolve to this row so they keep
   * summing into the same product rather than going unmatched. Checked
   * ONLY as a fallback, after every entry's own primary `match.ndc` has
   * already missed (see findInCatalog below) — so a DIFFERENT catalog
   * row whose primary `match.ndc` equals one of these values still wins
   * that exact match first. */
  altNdcs?: string[];
};

export type ProductCatalogEntry = {
  match: ProductCatalogMatch;
  productName: string;
  ageRange?: string;
  dosesPerPackage: number;
  packageNdc?: string;
  /** Where this row's numbers came from — package insert, manufacturer
   * site, etc. Not surfaced in the UI; kept for audit/review. */
  source?: string;
};

export type ProductLookupResult = {
  productName: string;
  ageRange: string | null;
  dosesPerPackage: number;
  packageNdc: string | null;
};

// ---------------------------------------------------------------------
// SEED TABLE — research pass 2026-09-09 (V-T26 item 7). Every ACTIVE
// catalog vaccine name has a row below; a name/NDC not covered here
// (e.g. a future new product) just returns null from lookupProduct,
// same as before this pass.
// ---------------------------------------------------------------------
const CATALOG: ProductCatalogEntry[] = [
  {
    // Repacked to the 10-count NDC (V-T-ordering-lots-round4, Will:
    // "Abrysvo should be NDC 00069246510 and 10 count"). altNdcs keeps the
    // OLD 1-count NDC ("00069034401", pre-repack) and the SEPARATE
    // still-stocked 1-count product's own NDC ("00069246501", see the
    // dedicated inactive row below) recognized as Abrysvo for on-hand
    // (Pioneer BOH) matching, so those lines still sum in here — see
    // ProductCatalogMatch.altNdcs's own doc comment for the matching
    // order (primary match.ndc, on ANY row, always wins first).
    match: { ndc: "00069246510", name: "Abrysvo", altNdcs: ["00069034401", "00069246501"] },
    productName: "Abrysvo",
    ageRange: "60+; pregnancy 32-36 wk",
    dosesPerPackage: 10,
    packageNdc: "00069-2465-10",
    source: "pfizermedical.com/abrysvo/storage-handling",
  },
  {
    // The 1-count Abrysvo product (V-T-ordering-lots-round4, Will: "There
    // is also 00069246501 1 count (mark as inactive)") — a SEPARATE
    // catalog row, not folded into the 10-count entry above, because the
    // corresponding `vaccine` DB row is its own inactive row (created via
    // POST /api/vaccines after this merge), not a dose of the same
    // product. Its NDC is ALSO listed in the 10-count entry's altNdcs
    // above so an on-hand line carrying it still sums into the active
    // Abrysvo bucket even before/without that DB row existing.
    match: { ndc: "00069246501" },
    productName: "Abrysvo (1 ct)",
    ageRange: "60+; pregnancy 32-36 wk",
    dosesPerPackage: 1,
    packageNdc: "00069-2465-01",
    source: "pfizermedical.com/abrysvo/storage-handling",
  },
  {
    match: { ndc: "58160084252", name: "Boostrix" },
    productName: "Boostrix",
    ageRange: "10+",
    dosesPerPackage: 10,
    packageNdc: "58160-0842-52",
    source: "CDC Adult Vaccine Price List 01-23-26",
  },
  {
    match: { name: "Capvaxive" },
    productName: "Capvaxive",
    ageRange: "18+; 2-17 high-risk",
    dosesPerPackage: 10,
    packageNdc: "00006-4347-02",
    source: "CDC Adult price list",
  },
  {
    // On-file catalog name is "Comirnaty 2025-26 12+" today, but is
    // expected to be renamed "Comirnaty 2026-27 12+" soon — namePrefix
    // keeps matching through that rename without a code change.
    match: { ndc: "00069252810", name: "Comirnaty 2025-26 12+", namePrefix: "Comirnaty" },
    productName: "Comirnaty 2026-2027 Formula",
    ageRange: "12+",
    dosesPerPackage: 10,
    packageNdc: "00069-2631-10",
    source: "primevaccines.pfizer.com F000065562",
  },
  {
    match: { ndc: "58160082152", name: "Engerix 20 (age 20+)" },
    productName: "Engerix-B (adult 20 mcg)",
    ageRange: "20+",
    dosesPerPackage: 10,
    packageNdc: "58160-0821-52",
    source: "CDC Adult price list",
  },
  {
    match: { ndc: "70461012303", name: "Fluad" },
    productName: "Fluad Trivalent (2026-27)",
    ageRange: "65+",
    dosesPerPackage: 10,
    packageNdc: "70461-0026-03",
    source: "CDC Adult Influenza Price List 09-01-26",
  },
  {
    match: { name: "Flucelvax PFS" },
    productName: "Flucelvax (2026-27, PFS)",
    ageRange: "6 mo+",
    dosesPerPackage: 10,
    packageNdc: "70461-0656-03",
    source: "CDC flu price list",
  },
  {
    match: { name: "FluMist (age 2-49)" },
    productName: "FluMist (2026-27)",
    ageRange: "2-49 yr",
    dosesPerPackage: 10,
    packageNdc: "66019-0113-10",
    source: "CDC flu price list",
  },
  {
    match: { ndc: "00006412102", name: "Gardasil" },
    productName: "Gardasil 9",
    ageRange: "9-45 yr",
    dosesPerPackage: 10,
    packageNdc: "00006-4121-02",
    source: "CDC Adult price list",
  },
  {
    match: { ndc: "58160095509", name: "Menveo" },
    productName: "Menveo (two-vial)",
    ageRange: "2 mo-55 yr",
    dosesPerPackage: 5,
    packageNdc: "58160-0955-09",
    source: "ndclist.com 58160-955-09",
  },
  {
    match: { ndc: "00006468100", name: "MMR-II" },
    productName: "M-M-R II",
    ageRange: "12 mo+",
    dosesPerPackage: 10,
    packageNdc: "00006-4681-00",
    source: "CDC Adult price list",
  },
  {
    match: { name: "mNEXSPIKE" },
    productName: "mNEXSPIKE (2026-27)",
    ageRange: "65+; 12-64 high-risk",
    dosesPerPackage: 10,
    packageNdc: "80777-0401-60",
    source: "fda.gov/media/186738",
  },
  {
    match: { name: "Pneumovax 23" },
    productName: "Pneumovax 23",
    ageRange: "50+; 19-49 high-risk",
    dosesPerPackage: 10,
    packageNdc: "00006-4837-03",
    source: "CDC Adult price list",
  },
  {
    // vaccine.ndc on file is the comma-joined "00005-2000-10,
    // 00005-2000-02" — normalizeNdc() takes only the FIRST NDC in a
    // comma list (lib/ndc.ts), which is this 10-pack, so this row's
    // `match.ndc` (also just the first NDC) always resolves to it.
    match: { ndc: "00005-2000-10", name: "Prevnar 20" },
    productName: "Prevnar 20",
    ageRange: "19+",
    dosesPerPackage: 10,
    packageNdc: "00005-2000-10",
    source: "CDC Adult price list",
  },
  {
    match: { ndc: "58160082311", name: "Shingrix" },
    productName: "Shingrix",
    ageRange: "50+; 19+ immunocompromised",
    dosesPerPackage: 10,
    packageNdc: "58160-0823-11",
    source: "CDC Adult price list",
  },
  {
    match: { name: "Spikevax" },
    productName: "Spikevax 2026-27 (6 mo-11 yr)",
    ageRange: "6 mo-11 yr",
    dosesPerPackage: 10,
    packageNdc: "80777-0115-80",
    source: "products.modernatx.com/spikevaxpro",
  },
  {
    match: { ndc: "49281079051", name: "Typhim Vi" },
    productName: "Typhim Vi",
    ageRange: "2+ yr",
    dosesPerPackage: 1,
    packageNdc: "49281-0790-51",
    source: "fda.gov/media/75993",
  },
  {
    match: { ndc: "00006409602", name: "Vaqta adult" },
    productName: "Vaqta (adult)",
    ageRange: "19+",
    dosesPerPackage: 10,
    packageNdc: "00006-4096-02",
    source: "CDC Adult price list",
  },
  {
    match: { name: "Afluria PFS" },
    productName: "Afluria (2026-27, PFS)",
    ageRange: "6 mo+",
    dosesPerPackage: 10,
    packageNdc: "33332-0125-10",
    source: "Seqirus PI (NDC low confidence)",
  },
  {
    match: { name: "Afluria MDV" },
    productName: "Afluria (2026-27, MDV)",
    ageRange: "6 mo+",
    dosesPerPackage: 10, // 5 mL MDV = 10 doses
    packageNdc: "33332-0025-03",
    source: "Seqirus PI (NDC low confidence)",
  },
  {
    match: { ndc: "58160084811", name: "Arexvy" },
    productName: "Arexvy",
    ageRange: "60+; 50-59 high-risk",
    dosesPerPackage: 10,
    packageNdc: "58160-0848-11",
    source: "CDC Adult price list",
  },
  {
    match: { name: "Fluarix PFS" },
    productName: "Fluarix (2026-27)",
    ageRange: "6 mo+",
    dosesPerPackage: 10,
    packageNdc: "58160-0725-52",
    source: "CDC flu price list",
  },
  {
    match: { ndc: "70461032303", name: "Flucelvax MDV" },
    productName: "Flucelvax (2026-27, MDV)",
    ageRange: "6 mo+",
    dosesPerPackage: 10, // 5 mL MDV = 10 doses
    packageNdc: "70461-0323-03",
    source: "Seqirus PI (on-file NDC may be the PFS)",
  },
  {
    match: { name: "Flulaval" },
    productName: "Flulaval (2026-27)",
    ageRange: "6 mo+",
    dosesPerPackage: 10,
    packageNdc: "19515-0822-52",
    source: "CDC flu price list",
  },
  {
    match: { name: "Fluzone HD" },
    productName: "Fluzone High-Dose (2026-27)",
    ageRange: "65+",
    dosesPerPackage: 10,
    packageNdc: "49281-0126-65",
    source: "CDC flu price list",
  },
  {
    match: { name: "Fluzone PFS" },
    productName: "Fluzone (2026-27, standard)",
    ageRange: "6 mo+",
    dosesPerPackage: 10,
    packageNdc: "49281-0426-50",
    source: "CDC flu price list",
  },
  {
    match: { name: "Priorix" },
    productName: "Priorix",
    ageRange: "12 mo+",
    dosesPerPackage: 10,
    packageNdc: "58160-0824-15",
    source: "CDC Adult price list",
  },
];

function toResult(entry: ProductCatalogEntry): ProductLookupResult {
  return {
    productName: entry.productName,
    ageRange: entry.ageRange ?? null,
    dosesPerPackage: entry.dosesPerPackage,
    packageNdc: entry.packageNdc ?? null,
  };
}

// Matches a "season" token anywhere in a name: "2025-26", "2026-27",
// "2026-2027" — a 4-digit year, a dash, then either 2 or 4 more digits.
const SEASON_TOKEN_PATTERN = /\b\d{4}-\d{2,4}\b/g;

/**
 * Normalizes a product name down to a season-agnostic "base" for
 * matching (review follow-up, live bug: the lot-list apply's mid-season
 * DB rename — "mNEXSPIKE" -> "mNEXSPIKE 2026-27", "Comirnaty 2025-26
 * 12+" -> "Comirnaty 2026-27 12+" — broke exact-name catalog matching,
 * dropping pkg size/age range/NDC-fallback for every renamed product).
 * Lowercases, strips any "(...)" parenthetical, strips a season token
 * ("2025-26"/"2026-27"/"2026-2027"), and collapses whitespace. Applied
 * to BOTH sides of a name comparison in findInCatalog below, so a catalog
 * row's own `match.name` ("Comirnaty 2025-26 12+") and a freshly-renamed
 * DB name ("Comirnaty 2026-27 12+") normalize to the identical base
 * ("comirnaty 12+") regardless of which season either one happens to be
 * pinned to.
 */
export function normalizeProductBaseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(SEASON_TOKEN_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Looks up a product by NDC first (normalized digits-only, so a dashed
 * or undashed form both match), then by name — season-agnostic (see
 * normalizeProductBaseName above) — against an arbitrary catalog array —
 * split out from lookupProduct so tests can exercise the matching rules
 * against a fixture catalog without needing real rows in the
 * (intentionally empty) seed table below. Returns null when nothing
 * matches.
 *
 * Name matching, in order (NDC-first precedence is unchanged — this is
 * only reached once the NDC check above has already missed):
 *   1. Exact (trimmed, case-insensitive) `match.name` — unchanged from
 *      before this fix, still the tightest/fastest check.
 *   2. Season-agnostic base-name match: both the incoming name and the
 *      catalog row's `match.name` run through normalizeProductBaseName,
 *      then compared for EQUALITY or PREFIX (whichever of the two
 *      normalized strings is shorter must be a prefix of the longer) —
 *      prefix, not just equality, so a further rename that only ADDS
 *      words ("Fluad" -> "Fluad Trivalent") still resolves, the same
 *      tolerance the explicit `namePrefix` field below already gave
 *      Comirnaty specifically.
 *   3. The existing explicit `match.namePrefix` field, case-insensitive
 *      startsWith against the RAW (non-season-stripped) incoming name —
 *      kept for any future row that needs a prefix rule
 *      normalizeProductBaseName's season-only stripping doesn't cover.
 */
export function findCatalogEntry(
  catalog: readonly ProductCatalogEntry[],
  { name, ndc }: { name?: string | null; ndc?: string | null }
): ProductCatalogEntry | null {
  const normalizedNdc = normalizeNdc(ndc ?? null);
  if (normalizedNdc) {
    const byNdc = catalog.find((entry) => entry.match.ndc && normalizeNdc(entry.match.ndc) === normalizedNdc);
    if (byNdc) return byNdc;

    // Alt-NDC fallback (see ProductCatalogMatch.altNdcs) — only reached
    // once every entry's own PRIMARY match.ndc has already missed, so a
    // different row's exact match.ndc always takes precedence over
    // another row's altNdcs.
    const byAltNdc = catalog.find((entry) =>
      entry.match.altNdcs?.some((alt) => normalizeNdc(alt) === normalizedNdc)
    );
    if (byAltNdc) return byAltNdc;
  }

  const trimmedName = (name ?? "").trim().toLowerCase();
  if (trimmedName) {
    const byName = catalog.find((entry) => entry.match.name && entry.match.name.trim().toLowerCase() === trimmedName);
    if (byName) return byName;

    const normalizedIncoming = normalizeProductBaseName(trimmedName);
    if (normalizedIncoming) {
      const byBaseName = catalog.find((entry) => {
        if (!entry.match.name) return false;
        const normalizedCatalog = normalizeProductBaseName(entry.match.name);
        if (!normalizedCatalog) return false;
        if (normalizedCatalog === normalizedIncoming) return true;
        return normalizedCatalog.length < normalizedIncoming.length
          ? normalizedIncoming.startsWith(normalizedCatalog)
          : normalizedCatalog.startsWith(normalizedIncoming);
      });
      if (byBaseName) return byBaseName;
    }

    const byPrefix = catalog.find(
      (entry) => entry.match.namePrefix && trimmedName.startsWith(entry.match.namePrefix.trim().toLowerCase())
    );
    if (byPrefix) return byPrefix;
  }

  return null;
}

/**
 * Same matching rules as findCatalogEntry, but returns the display-ready
 * ProductLookupResult (dosesPerPackage/packageNdc/etc.) instead of the
 * raw entry — split out so tests can exercise the matching rules against
 * a fixture catalog without needing real rows in the (intentionally
 * empty) seed table below.
 */
export function findInCatalog(
  catalog: readonly ProductCatalogEntry[],
  args: { name?: string | null; ndc?: string | null }
): ProductLookupResult | null {
  const entry = findCatalogEntry(catalog, args);
  return entry ? toResult(entry) : null;
}

/**
 * Looks up a catalog product against the real (currently empty) seed
 * table above. Returns null when nothing matches — the caller (the
 * Ordering page) treats null the same as "no research done yet for this
 * product," never as an error.
 */
export function lookupProduct(args: { name?: string | null; ndc?: string | null }): ProductLookupResult | null {
  return findInCatalog(CATALOG, args);
}

/**
 * NDC-reconciliation guard (V-onhand-ndc-units review fix, reviewer
 * repro: Abrysvo's 10-count row has ndc "00069-2465-10"; a report line
 * carrying "00069246501" — the SEPARATE 1-count product's own NDC,
 * listed as an altNdc on the 10-count entry purely so on-hand matching
 * still sums it into the same product — was about to get "adopted" onto
 * the 10-count row's vaccine.ndc, silently overwriting the correct NDC
 * with a DIFFERENT real product's NDC). True when `candidateNdc` is a
 * recognized ALT ndc (ProductCatalogMatch.altNdcs) for the SAME product
 * `owner` resolves to — an altNdc is a known OLD/VARIANT identifier
 * tolerated for matching, never the product's real/current NDC, so
 * lib/on-hand/ndc-reconcile.ts must never treat one as a correction.
 */
export function isKnownAltNdc(
  catalog: readonly ProductCatalogEntry[],
  owner: { name?: string | null; ndc?: string | null },
  candidateNdc: string | null | undefined
): boolean {
  const normalizedCandidate = normalizeNdc(candidateNdc ?? null);
  if (!normalizedCandidate) return false;
  const entry = findCatalogEntry(catalog, owner);
  if (!entry) return false;
  return (entry.match.altNdcs ?? []).some((alt) => normalizeNdc(alt) === normalizedCandidate);
}

/** Real-catalog-bound convenience wrapper for isKnownAltNdc, same split
 * as lookupProduct/findInCatalog above. */
export function isKnownAltNdcForProduct(
  owner: { name?: string | null; ndc?: string | null },
  candidateNdc: string | null | undefined
): boolean {
  return isKnownAltNdc(CATALOG, owner, candidateNdc);
}

/**
 * NDC-reconciliation guard (V-onhand-ndc-units review fix): true when
 * `candidateNdc` is the PRIMARY or an ALT ndc of some catalog entry
 * OTHER than the one `owner` resolves to — i.e. this app's own static
 * research already knows the NDC identifies a DIFFERENT product, so
 * lib/on-hand/ndc-reconcile.ts must never adopt it onto `owner`'s
 * vaccine.ndc even when nothing else in the current batch/DB catches
 * the conflict.
 */
export function belongsToOtherCatalogProduct(
  catalog: readonly ProductCatalogEntry[],
  owner: { name?: string | null; ndc?: string | null },
  candidateNdc: string | null | undefined
): boolean {
  const normalizedCandidate = normalizeNdc(candidateNdc ?? null);
  if (!normalizedCandidate) return false;
  const ownerEntry = findCatalogEntry(catalog, owner);
  for (const entry of catalog) {
    if (entry === ownerEntry) continue;
    const primary = normalizeNdc(entry.match.ndc ?? null);
    if (primary && primary === normalizedCandidate) return true;
    if ((entry.match.altNdcs ?? []).some((alt) => normalizeNdc(alt) === normalizedCandidate)) return true;
  }
  return false;
}

/** Real-catalog-bound convenience wrapper for belongsToOtherCatalogProduct,
 * same split as lookupProduct/findInCatalog above. */
export function ndcBelongsToOtherProduct(
  owner: { name?: string | null; ndc?: string | null },
  candidateNdc: string | null | undefined
): boolean {
  return belongsToOtherCatalogProduct(CATALOG, owner, candidateNdc);
}

/**
 * Formats a known product's display name: `productName (ageRange)` when
 * ageRange is set AND itself contains no parentheses (every real seed
 * row's ageRange is meant to be flat — see the CATALOG comments — but
 * this guards any future row that isn't), else `productName —
 * ageRange` (em dash, no wrapping parens) so two nested "(...)" groups
 * can never stack (V-T26 followups, Will 2026-09-09: "avoid nested
 * parentheses like 'Capvaxive (18+ (2-17 high-risk))'"), else just
 * `productName` when ageRange is unknown. Split out from displayNameFor
 * below so this formatting rule is directly testable against a
 * synthetic parenthesized ageRange without needing one in the real
 * (now-flat) seed table.
 */
export function formatProductDisplayName(productName: string, ageRange: string | null): string {
  if (!ageRange) return productName;
  return ageRange.includes("(") || ageRange.includes(")") ? `${productName} — ${ageRange}` : `${productName} (${ageRange})`;
}

/** The Ordering page's display name for a row — see
 * formatProductDisplayName for the exact rendering rule. Falls back to
 * today's plain vaccine name when the catalog has no match at all
 * (Will's brief: "when known, else today's name"). */
export function displayNameFor(vaccineName: string, ndc: string | null): string {
  const product = lookupProduct({ name: vaccineName, ndc });
  if (!product) return vaccineName;
  return formatProductDisplayName(product.productName, product.ageRange);
}

/** Order (pkg) = ceil(orderDoses / dosesPerPackage), or null when
 * dosesPerPackage is unknown/not-yet-researched (the page renders null
 * as "—") — also defensively null for a non-positive dosesPerPackage,
 * which should never occur in a real catalog row but must not divide by
 * zero if it somehow did. */
export function computeOrderPackages(orderDoses: number, dosesPerPackage: number | null | undefined): number | null {
  if (!dosesPerPackage || dosesPerPackage <= 0) return null;
  return Math.ceil(orderDoses / dosesPerPackage);
}
