import { groupVaccinesIntoProducts, type LotsCatalogVaccine } from "@/lib/lots-grouping";
import { displayNameFor, lookupProduct } from "@/lib/vaccine-product-catalog";
import { getOrderingGroup } from "@/lib/ordering-group";
import { normalizeNdc } from "@/lib/ndc";

/**
 * Shared product view (V-T-ordering-lots-round3, Will 2026-09-09
 * verbatim, Ordering: "...Look up any missing NDCs...Add Pkg size as a
 * column..."; Lots: "Make sure the data on the ordering/lots page
 * matches (NDC, name, etc) and is consistent always. It should pull
 * from the same database... Follow same groupings everywhere,
 * including on lots"). Both /ordering and /lots must show the SAME
 * name, NDC, package size, and COVID/Flu/Other group for the same
 * product, so this file is the one place that computes those four
 * fields — every caller (both pages' components, and
 * lib/on-hand/pioneer-boh.ts's NDC matching) goes through it rather
 * than re-deriving any of them locally.
 *
 * Two entry points, because the two pages start from differently-shaped
 * inputs:
 *   - buildProductViews: takes a flat, per-dose `vaccine` catalog (Lots'
 *     own GET /api/vaccines?includeInactive=true shape) and groups it
 *     into one row per PRODUCT via lib/lots-grouping.ts's
 *     groupVaccinesIntoProducts (NDC first, else matching name — a
 *     no-NDC dose row like Vaqta's second dose joins its named
 *     sibling's group rather than starting its own).
 *   - deriveProductViewFields: the lower-level per-product lookup
 *     (display name, ndc-with-catalog-fallback, package size, group)
 *     that buildProductViews layers onto each group — exported
 *     separately so Ordering's recommendation rows (already collapsed
 *     to one per product server-side, via the SEPARATE
 *     lib/ordering-ndc-collapse.ts mechanism, which needs its own
 *     upcoming7d/onHand aggregation keyed differently for a no-NDC
 *     dose) can compute IDENTICAL display fields from the same catalog
 *     data without re-running the raw-dose-row grouping a second time.
 */

export type NdcSource = "db" | "catalog" | null;

export type ProductViewFields = {
  /** productName (+ age range) from the researched static catalog
   * (lib/vaccine-product-catalog.ts) when known, else today's plain
   * vaccine/group name. */
  displayName: string;
  /** The product's NDC: the `vaccine` row's own DB ndc when present,
   * else the researched catalog packageNdc, else null when neither
   * source knows it. */
  ndc: string | null;
  /** Which source `ndc` came from — "db", "catalog", or null when
   * neither has one on file. */
  ndcSource: NdcSource;
  /** Doses per package from the researched static catalog, or null
   * when unresearched. */
  packageSize: number | null;
  /** "COVID" | "Flu" | "Other" (lib/ordering-group.ts). */
  group: string;
};

export type ProductView = ProductViewFields & {
  /** Stable grouping key — see lib/lots-grouping.ts's LotsProductGroup.key. */
  productKey: string;
  /** Every dose vaccine_id collapsed into this product. */
  vaccineIds: string[];
  /** true if ANY dose row in the group is active. */
  active: boolean;
};

/**
 * Derives the catalog-backed display fields for a single already-
 * identified product, given its name and DB-sourced ndc (digits-only,
 * or null when none on file). Pure/no I/O — see this file's header
 * comment for why it's split out from buildProductViews.
 */
export function deriveProductViewFields(name: string, dbNdc: string | null): ProductViewFields {
  const catalogMatch = lookupProduct({ name, ndc: dbNdc });
  const displayName = displayNameFor(name, dbNdc);

  let ndc = dbNdc;
  let ndcSource: NdcSource = dbNdc ? "db" : null;
  if (!ndc && catalogMatch?.packageNdc) {
    const normalized = normalizeNdc(catalogMatch.packageNdc);
    if (normalized) {
      ndc = normalized;
      ndcSource = "catalog";
    }
  }

  return {
    displayName,
    ndc,
    ndcSource,
    packageSize: catalogMatch?.dosesPerPackage ?? null,
    group: getOrderingGroup(name),
  };
}

export type ProductViewVaccine = LotsCatalogVaccine;

/**
 * Builds one ProductView per PRODUCT from a flat, per-dose vaccine
 * catalog — see this file's header comment.
 */
export function buildProductViews(vaccines: readonly ProductViewVaccine[]): ProductView[] {
  const groups = groupVaccinesIntoProducts(vaccines);
  return groups.map((group) => ({
    productKey: group.key,
    vaccineIds: group.vaccineIds,
    active: group.active,
    ...deriveProductViewFields(group.name, group.ndc),
  }));
}
