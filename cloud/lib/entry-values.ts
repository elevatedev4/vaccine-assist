import { buildProductViews, type ProductViewVaccine } from "@/lib/product-view";
import { lookupMacroCatalog } from "@/lib/macro-catalog";
import { doseCountByVaccineId } from "@/lib/dose-family";

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
  /** The product's NDC — same derivation Ordering/Lots use
   * (lib/product-view.ts's deriveProductViewFields: the DB `ndc` when
   * present, else the researched catalog packageNdc, else null), so the
   * value shown here always matches those tabs. */
  ndc: string | null;
  /** Total number of ACTIVE dose rows in this product's series — 1 for
   * a single-dose product, e.g. 2 for Shingrix. Feeds
   * lib/entry-defaults.ts's defaultDirections. Computed via
   * lib/dose-family.ts's doseCountByVaccineId, which regroups by cleaned
   * display name rather than trusting buildProductViews' own grouping —
   * a product whose dose rows carry mismatched NDCs (e.g. Shingrix) gets
   * split into separate ProductViews upstream, which would otherwise
   * report doseCount 1 for each half instead of the real family size. */
  doseCount: number;
  /** The row's own short_code, verbatim — feeds
   * lib/entry-defaults.ts's defaultQuantity (exact-then-base lookup),
   * same as this file's own catalogType lookup above. */
  shortCode: string | null;
  quantity: string | null;
  directions: string | null;
  /** Cash price in cents for the PRODUCT (not this individual dose row)
   * — Will's ask: "add cash price to all vaccines" is one price per
   * vaccine product, shared by every dose. Always the LOWEST-doseNumber
   * active dose row's cash_price_cents — resolved by parsing each dose
   * row's own `dose` column via doseNumberOf, NEVER by array/fetch order
   * (GET /api/vaccines orders by `name` only, and same-product dose rows
   * share a name, so their relative order is unspecified) — same
   * convention as lib/macro-codes.ts's MacroProductGroup.cashPriceCents
   * (`first.cashPriceCents` after sorting by doseNumber), so a price
   * entered here shows up there. Every dose row of a product carries the
   * SAME value here even though only the lowest-dose row's DB column
   * actually holds it. */
  cashPriceCents: number | null;
  /** True only for the LOWEST-doseNumber active dose row of a product
   * (see cashPriceCents above for how that row is picked) — the ONE row
   * whose cash price is actually editable/saved; every other dose row of
   * the same product shows cashPriceCents read-only (see
   * app/entry-values/page.tsx). */
  cashPriceEditable: boolean;
};

/**
 * Cents -> the plain (no "$", no thousands separator) dollar string an
 * editable cash-price input shows, e.g. 8900 -> "89.00", null -> "" (an
 * empty input = no price on file). Distinct from lib/vaccine-entry-
 * payload.ts's formatCashPrice, which formats a READ-ONLY "$89.00"/"—"
 * display string — this one round-trips with parseDollarsInputToCents
 * below for an editable field.
 */
export function centsToDollarsInputValue(cents: number | null): string {
  if (cents === null) return "";
  return (cents / 100).toFixed(2);
}

/**
 * The inverse of centsToDollarsInputValue: an editable cash-price input's
 * raw string -> cents. "" (or whitespace-only) -> null (clears the
 * price). A leading "$" is tolerated. Anything else that isn't a
 * non-negative number with at most 2 decimal places -> undefined, so the
 * caller can reject the edit rather than silently saving a wrong/garbled
 * amount.
 */
export function parseDollarsInputToCents(value: string): number | null | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const withoutDollarSign = (trimmed.startsWith("$") ? trimmed.slice(1).trim() : trimmed).replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(withoutDollarSign)) return undefined;
  const dollars = Number.parseFloat(withoutDollarSign);
  if (!Number.isFinite(dollars) || dollars < 0) return undefined;
  return Math.round(dollars * 100);
}

/** Parses the `dose` column into a 1-indexed dose number, defaulting to
 * 1 for a missing/unparseable value — same convention as
 * lib/macro-codes.ts's own (unexported) doseNumberOf. */
export function doseNumberOf(dose: string | null): number {
  const parsed = Number.parseInt(dose ?? "1", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

/**
 * Formats a dose number for display in the /entry-values Dose column
 * (Will, 2026-09-12, verbatim: "Remove 'Dose' from the dose data, it's
 * redundant since it already has that for a heading"). Display-only —
 * doesn't touch EntryValueRow.doseNumber itself, which stays the plain
 * number used for sorting, lookups, and lib/entry-defaults.ts's
 * defaultDirections. Defensively strips a leading "Dose " (any case) in
 * case a future dose value already carries it, so the column never
 * shows "Dose Dose 1".
 */
export function doseColumnLabel(doseNumber: number | string): string {
  return String(doseNumber).replace(/^dose\s+/i, "").trim();
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
  const doseCountById = doseCountByVaccineId(products);

  const rows: EntryValueRow[] = [];
  for (const product of products) {
    // The LOWEST-doseNumber dose row is the ONE place cash price is
    // actually edited/stored — see EntryValueRow.cashPriceCents's doc
    // comment. Picked by parsing each row's own `dose` column
    // (doseNumberOf), NOT by product.vaccineIds' array order, which
    // reflects GET /api/vaccines' name-only ordering and is unspecified
    // among same-named dose siblings (review fix, 2026-09-28: a
    // dose-2-then-dose-1 fetch order previously put the editable input
    // on dose 2, so a saved price never matched what lib/macro-codes.ts
    // shows via its own doseNumber-sorted `first`).
    const primaryId = [...product.vaccineIds].sort(
      (a, b) => doseNumberOf(byId.get(a)?.dose ?? null) - doseNumberOf(byId.get(b)?.dose ?? null)
    )[0];
    const productCashPriceCents = byId.get(primaryId)?.cash_price_cents ?? null;

    for (const id of product.vaccineIds) {
      const doseCount = doseCountById.get(id) ?? product.vaccineIds.length;
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
        ndc: product.ndc,
        doseCount,
        shortCode: vaccine.short_code,
        quantity: vaccine.quantity,
        directions: vaccine.directions,
        cashPriceCents: productCashPriceCents,
        cashPriceEditable: id === primaryId,
      });
    }
  }

  return rows.sort(
    (a, b) => a.sheetOrder - b.sheetOrder || a.doseNumber - b.doseNumber || a.displayName.localeCompare(b.displayName)
  );
}
