import { deriveProductViewFields } from "@/lib/product-view";
import { computeOrderPackages } from "@/lib/vaccine-product-catalog";
import { ORDERING_GROUP_DISPLAY_ORDER } from "@/lib/ordering-group";

/** The subset of app/ordering/page.tsx's RecommendationRow this helper
 * needs — kept as its own narrow type (rather than importing from the
 * "use client" page) so this stays a plain, page-independent lib
 * module; RecommendationRow is a structural superset, so passing
 * `data.rows` straight through from the page just works. */
export type ToOrderInputRow = {
  key: string;
  vaccineName: string;
  ndc: string | null;
  group: string;
  order: number;
};

export type ToOrderRow = {
  key: string;
  /** The SAME cleaned name every other tab shows (lib/product-view.ts). */
  displayName: string;
  /** DB ndc when present, else the researched catalog packageNdc — same
   * fallback the main recommendation table's NDC column uses. */
  ndc: string | null;
  /** Doses to order (RecommendationRow.order), always > 0 here. */
  order: number;
  /** ceil(order / dosesPerPackage), or null when the catalog doesn't
   * know this product's package size yet. */
  orderPackages: number | null;
};

function sortForToOrder(rows: readonly ToOrderInputRow[]): ToOrderInputRow[] {
  return [...rows].sort((a, b) => {
    if (a.order !== b.order) return b.order - a.order;
    return a.vaccineName.localeCompare(b.vaccineName);
  });
}

/**
 * Builds the /ordering "To order" table's rows (V-T-ordering-unify,
 * Will 2026-09-11: "a new table at the top that shows only items
 * recommended to be ordered, and includes the product name, NDC, and
 * packages to order"): every row with order > 0, grouped and sorted
 * EXACTLY like the main recommendation table below it — COVID/Flu/Other
 * display order (lib/ordering-group.ts), then within each group by
 * order desc then vaccine name (the same tie-break as the main table's
 * own sortRows in app/ordering/page.tsx) — then flattened into one
 * list. Pure/no I/O, so it's directly unit-testable and safe to call at
 * render time.
 */
export function buildToOrderRows(rows: readonly ToOrderInputRow[]): ToOrderRow[] {
  const filtered = rows.filter((row) => row.order > 0);

  const byGroup = new Map<string, ToOrderInputRow[]>();
  for (const row of filtered) {
    const list = byGroup.get(row.group);
    if (list) list.push(row);
    else byGroup.set(row.group, [row]);
  }

  const groupOrder = ORDERING_GROUP_DISPLAY_ORDER.filter((group) => byGroup.has(group));
  for (const group of byGroup.keys()) {
    if (!groupOrder.includes(group)) groupOrder.push(group);
  }

  const sorted = groupOrder.flatMap((group) => sortForToOrder(byGroup.get(group) ?? []));

  return sorted.map((row) => {
    const fields = deriveProductViewFields(row.vaccineName, row.ndc);
    return {
      key: row.key,
      displayName: fields.displayName,
      ndc: fields.ndc,
      order: row.order,
      orderPackages: computeOrderPackages(row.order, fields.packageSize),
    };
  });
}
