import { buildProductViews, type ProductViewVaccine } from "@/lib/product-view";
import { lookupMacroCatalog } from "@/lib/macro-catalog";

/**
 * Pure row-building for the /entry-values tab (V-entry-values, Will's
 * brief verbatim: "I likely need to have an editor in the cloud app
 * where I can specify all those items [quantity, instructions]... The
 * starting point for all the vaccines we currently have active should
 * be the quantity... and the instructions should be [the default sig]").
 *
 * One row per ACTIVE dose `vaccine` row (not one per product — unlike
 * /macro-codes' buildMacroRows, quantity/directions are edited PER DOSE,
 * since they're stored on the `vaccine` row itself) grouped into
 * products via the SAME lib/product-view.ts buildProductViews every
 * other tab (Ordering/Lots/Macro codes) uses, so Type/Product/Dose
 * ordering and grouping here matches those pages exactly. Kept
 * dependency-free of React/fetch/Supabase so it's directly
 * unit-testable, same posture as lib/macro-codes.ts.
 */

export type EntryValueVaccine = ProductViewVaccine & {
  dose: string | null;
  short_code: string | null;
  quantity: string | null;
  directions: string | null;
};

export type EntryValueRow = {
  id: string;
  productKey: string;
  displayName: string;
  /** Sheet "Type" column value (lib/macro-catalog.ts), e.g. "Shingles" —
   * "Other" for a dose row whose short_code isn't in that static
   * catalog. */
  catalogType: string;
  /** Sort key matching the macro-catalog sheet's row order — see
   * lib/macro-catalog.ts. */
  sheetOrder: number;
  doseNumber: number;
  /** Total number of ACTIVE dose rows in this product's series — 1 for
   * a single-dose product, e.g. 2 for Shingrix. Feeds
   * lib/entry-defaults.ts's defaultDirections. */
  doseCount: number;
  quantity: string | null;
  directions: string | null;
};

/** Parses the `dose` column into a 1-indexed dose number, defaulting to
 * 1 for a missing/unparseable value — same convention as
 * lib/macro-codes.ts's own (unexported) doseNumberOf. */
export function doseNumberOf(dose: string | null): number {
  const parsed = Number.parseInt(dose ?? "1", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

/**
 * Builds one EntryValueRow per active dose `vaccine` row, grouped into
 * products (for Type/doseCount) exactly like every other tab. Final
 * order: sheetOrder (the macro-catalog sheet's row order), then dose
 * number, then display name — matching /macro-codes' "All vaccines"
 * section order.
 */
export function buildEntryValueRows(vaccines: readonly EntryValueVaccine[]): EntryValueRow[] {
  const activeVaccines = vaccines.filter((v) => v.active);
  const byId = new Map(activeVaccines.map((v) => [v.id, v]));
  const products = buildProductViews(activeVaccines);

  const rows: EntryValueRow[] = [];
  for (const product of products) {
    const doseCount = product.vaccineIds.length;
    for (const id of product.vaccineIds) {
      const vaccine = byId.get(id);
      if (!vaccine) continue;
      const catalogEntry = lookupMacroCatalog(vaccine.short_code ?? "");
      rows.push({
        id: vaccine.id,
        productKey: product.productKey,
        displayName: product.displayName,
        catalogType: catalogEntry.type,
        sheetOrder: catalogEntry.sheetOrder,
        doseNumber: doseNumberOf(vaccine.dose),
        doseCount,
        quantity: vaccine.quantity,
        directions: vaccine.directions,
      });
    }
  }

  return rows.sort(
    (a, b) => a.sheetOrder - b.sheetOrder || a.doseNumber - b.doseNumber || a.displayName.localeCompare(b.displayName)
  );
}
