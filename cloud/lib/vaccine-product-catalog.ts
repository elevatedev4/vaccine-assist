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
    match: { ndc: "00069034401", name: "Abrysvo" },
    productName: "Abrysvo",
    ageRange: "60+; pregnancy 32-36 wk",
    dosesPerPackage: 1,
    packageNdc: "00069-0344-01",
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
    ageRange: "18+ (2-17 high-risk)",
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
    ageRange: "19+ (label 6 wk+)",
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

/**
 * Looks up a product by NDC first (normalized digits-only, so a dashed
 * or undashed form both match), then by exact case-insensitive name,
 * against an arbitrary catalog array — split out from lookupProduct so
 * tests can exercise the matching rules against a fixture catalog
 * without needing real rows in the (intentionally empty) seed table
 * below. Returns null when neither matches.
 */
export function findInCatalog(
  catalog: readonly ProductCatalogEntry[],
  { name, ndc }: { name?: string | null; ndc?: string | null }
): ProductLookupResult | null {
  const normalizedNdc = normalizeNdc(ndc ?? null);
  if (normalizedNdc) {
    const byNdc = catalog.find((entry) => entry.match.ndc && normalizeNdc(entry.match.ndc) === normalizedNdc);
    if (byNdc) return toResult(byNdc);
  }

  const trimmedName = (name ?? "").trim().toLowerCase();
  if (trimmedName) {
    const byName = catalog.find((entry) => entry.match.name && entry.match.name.trim().toLowerCase() === trimmedName);
    if (byName) return toResult(byName);

    const byPrefix = catalog.find(
      (entry) => entry.match.namePrefix && trimmedName.startsWith(entry.match.namePrefix.trim().toLowerCase())
    );
    if (byPrefix) return toResult(byPrefix);
  }

  return null;
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

/** The Ordering page's display name for a row: `productName (ageRange)`
 * when the catalog knows both, `productName` alone when it knows the
 * product but not its age range, else today's plain vaccine name
 * (Will's brief: "when known, else today's name"). */
export function displayNameFor(vaccineName: string, ndc: string | null): string {
  const product = lookupProduct({ name: vaccineName, ndc });
  if (!product) return vaccineName;
  return product.ageRange ? `${product.productName} (${product.ageRange})` : product.productName;
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
