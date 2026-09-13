/**
 * Pure, client-safe aggregation for the "Doses given" explorer
 * (V-doses-given, Will 2026-09-12 verbatim: "On the scheduling page,
 * include a data explorer link for doses given."). Pivots already-
 * ingested administered (per-dose) rows — lib/administered/store.ts's
 * AdministeredDayRow — into a day x product grid plus per-product
 * totals for a caller-selected date range.
 *
 * Deliberately has NO "server-only" import (same convention
 * lib/appointment-explorer.ts documents for its own file) so this stays
 * importable from the client page and unit-testable with plain objects
 * — the actual Supabase reads live in app/api/administered/doses-given/
 * route.ts, which calls buildDosesGivenPivot with the rows it already
 * fetched via lib/administered/store.ts's getAdministeredDay.
 */

/** The subset of lib/administered/store.ts's AdministeredDayRow this
 * file actually reads — re-declared locally (rather than imported) so
 * this module has no dependency on that "server-only" file, same reason
 * lib/appointment-explorer.ts re-declares its own row shape. */
export type DosesGivenSourceRow = {
  itemName: string;
  vaccineId: string | null;
};

export type DosesGivenSourceDay = {
  /** "YYYY-MM-DD", America/Chicago. */
  date: string;
  rows: DosesGivenSourceRow[];
};

export type DosesGivenPivot = {
  /** Every date in the requested range, ascending, including days with
   * zero doses (so the table always shows the full range, not just days
   * that happen to have data). */
  dates: string[];
  /** Every distinct product name that appears anywhere in the range,
   * alphabetical — the day x product table's columns. */
  products: string[];
  /** Dense grid: every date has an entry for every product (0 when that
   * product had no doses that day). */
  countsByDateProduct: Record<string, Record<string, number>>;
  /** Per-date total across all products — the table's "Total" column. */
  totalsByDate: Record<string, number>;
  /** Per-product total across the whole range — the table's "Total" row,
   * and the source for the "grouped by product" view. */
  totalsByProduct: Record<string, number>;
  grandTotal: number;
};

/**
 * Resolves one row's product name for the pivot: the caller-supplied
 * catalog display name for `vaccineId` when known, else the raw
 * `itemName` — same "never drop an unmatched dose, just fall back to the
 * raw name" posture as lib/administered/store.ts's own byItemName
 * bucket. `nameByVaccineId` is a plain object (rather than a Map) so
 * this function stays trivial to call with a literal in tests.
 */
export function resolveDoseProductName(
  row: DosesGivenSourceRow,
  nameByVaccineId: Record<string, string>
): string {
  if (row.vaccineId && nameByVaccineId[row.vaccineId]) return nameByVaccineId[row.vaccineId];
  return row.itemName;
}

/**
 * Pivots `days` (one entry per date in the requested range — callers
 * should include a zero-rows entry for a date with nothing ingested, so
 * `dates` in the result covers the whole range) into the day x product
 * grid described by DosesGivenPivot above. `resolveProductName` is
 * injected (rather than this function taking nameByVaccineId directly)
 * so the aggregation itself stays decoupled from how a row's product
 * name is resolved — the route wires resolveDoseProductName in.
 */
export function buildDosesGivenPivot(
  days: DosesGivenSourceDay[],
  resolveProductName: (row: DosesGivenSourceRow) => string
): DosesGivenPivot {
  const dates = days.map((day) => day.date);
  const productSet = new Set<string>();
  const rawCounts = new Map<string, Map<string, number>>(); // date -> product -> count

  for (const day of days) {
    const perProduct = new Map<string, number>();
    for (const row of day.rows) {
      const product = resolveProductName(row);
      productSet.add(product);
      perProduct.set(product, (perProduct.get(product) ?? 0) + 1);
    }
    rawCounts.set(day.date, perProduct);
  }

  const products = Array.from(productSet).sort((a, b) => a.localeCompare(b));

  const countsByDateProduct: Record<string, Record<string, number>> = {};
  const totalsByDate: Record<string, number> = {};
  const totalsByProduct: Record<string, number> = {};
  let grandTotal = 0;
  for (const product of products) totalsByProduct[product] = 0;

  for (const date of dates) {
    const perProduct = rawCounts.get(date) ?? new Map<string, number>();
    const row: Record<string, number> = {};
    let dateTotal = 0;
    for (const product of products) {
      const count = perProduct.get(product) ?? 0;
      row[product] = count;
      dateTotal += count;
      totalsProductAdd(totalsByProduct, product, count);
    }
    countsByDateProduct[date] = row;
    totalsByDate[date] = dateTotal;
    grandTotal += dateTotal;
  }

  return { dates, products, countsByDateProduct, totalsByDate, totalsByProduct, grandTotal };
}

function totalsProductAdd(totals: Record<string, number>, product: string, count: number): void {
  totals[product] = (totals[product] ?? 0) + count;
}

/** Products with a total, sorted by total descending (ties broken
 * alphabetically) — the "grouped by product" view's row order. */
export function productTotalsDescending(pivot: DosesGivenPivot): Array<{ product: string; total: number }> {
  return pivot.products
    .map((product) => ({ product, total: pivot.totalsByProduct[product] }))
    .sort((a, b) => b.total - a.total || a.product.localeCompare(b.product));
}

function csvField(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** CSV for the day x product table — one row per date plus a trailing
 * "Total" row, one column per product plus a trailing "Total" column. */
export function dosesGivenPivotToCsv(pivot: DosesGivenPivot): string {
  const lines = [["Date", ...pivot.products, "Total"].map(csvField).join(",")];
  for (const date of pivot.dates) {
    const row = pivot.countsByDateProduct[date];
    lines.push(
      [date, ...pivot.products.map((product) => String(row[product])), String(pivot.totalsByDate[date])]
        .map(csvField)
        .join(",")
    );
  }
  lines.push(
    ["Total", ...pivot.products.map((product) => String(pivot.totalsByProduct[product])), String(pivot.grandTotal)]
      .map(csvField)
      .join(",")
  );
  return lines.join("\n");
}

/** CSV for the "grouped by product" view — one row per product, sorted
 * by total descending, plus a trailing grand-total row. */
export function productTotalsToCsv(pivot: DosesGivenPivot): string {
  const lines = [["Product", "Total"].map(csvField).join(",")];
  for (const { product, total } of productTotalsDescending(pivot)) {
    lines.push([product, String(total)].map(csvField).join(","));
  }
  lines.push(["Total", String(pivot.grandTotal)].map(csvField).join(","));
  return lines.join("\n");
}
