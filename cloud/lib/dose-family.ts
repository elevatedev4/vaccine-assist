import type { ProductView } from "@/lib/product-view";

/**
 * Shared "regroup by cleaned display name" helper for the class of bug
 * fixed in commit 1b41fb5 (lib/macro-codes.ts's groupMacroRowsBySection,
 * NOT touched by this file — see that commit for the original fix):
 * upstream product grouping (lib/lots-grouping.ts's
 * groupVaccinesIntoProducts, keyed off the raw `vaccine` row's NDC/name)
 * can split one product's dose rows into two separate ProductViews when
 * their NDCs don't match across dose rows — Shingrix's two seeded dose
 * rows being the live example. Any downstream consumer that needs an
 * accurate per-product dose COUNT (not just the per-row `dose` column,
 * which is fine as-is) must re-group by the cleaned display name rather
 * than trusting the upstream productKey grouping, or a split product's
 * rows each see a doseCount of 1 instead of the real family size.
 *
 * Deliberately its own file (not exported from/imported into
 * lib/macro-codes.ts) so /entry-values and GET /api/vaccines (the two
 * callers below) can share this fix without touching macro-codes.ts,
 * which 1b41fb5 already fixed independently for its own MacroRow shape.
 */
export function groupByCleanedName<T>(items: readonly T[], nameOf: (item: T) => string): T[][] {
  const order: string[] = [];
  const groups = new Map<string, T[]>();

  for (const item of items) {
    const key = nameOf(item).trim().toLowerCase();
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
      order.push(key);
    }
    group.push(item);
  }

  return order.map((key) => groups.get(key) as T[]);
}

/**
 * Computes the correct doseCount for every vaccine id across a list of
 * ProductViews, regrouping by cleaned display name first so a product
 * split across multiple ProductViews (see file header) reports the
 * combined family size on every one of its dose rows instead of the
 * (wrong) single-split-group size.
 */
export function doseCountByVaccineId(products: readonly ProductView[]): Map<string, number> {
  const families = groupByCleanedName(products, (product) => product.displayName);
  const result = new Map<string, number>();

  for (const family of families) {
    const doseCount = family.reduce((sum, product) => sum + product.vaccineIds.length, 0);
    for (const product of family) {
      for (const id of product.vaccineIds) result.set(id, doseCount);
    }
  }

  return result;
}
