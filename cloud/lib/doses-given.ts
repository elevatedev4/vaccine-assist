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
 *
 * ROUND 2 (V-doses-given-layout, Will 2026-09-13, verbatim: "make the
 * formatting match our scheduling page for consistency (without the
 * green highlighting, just spacing and arrangement-wise). And it's
 * currently showing 376 doses, but my reports in my software that I
 * uploaded has 419 doses" — cause: the default range was a fixed last-14
 * -days lookback, but the store holds doses back to 8/4) adds the pure
 * range-preset/grouping helpers app/doses-given/page.tsx needs for that
 * fix, same "pure + unit-tested here, wired up in the page" split as
 * buildDosesGivenPivot above:
 *   - yesterdayInChicago/lastNDaysRange/thisMonthRange/allRange/
 *     quickPickRange: every date-range preset the page's quick-pick
 *     buttons and its new default range ("earliest day on file through
 *     yesterday", not a fixed lookback) need. Each takes an optional
 *     `today` override (defaulting to todayInChicago()) purely so these
 *     stay unit-testable against a fixed date without faking system time.
 *   - orderProductsByGroup: reorders an already-alphabetical product list
 *     (buildDosesGivenPivot's own `products`) into the Schedule page's
 *     COVID/Flu-first-then-everything-else column order (see
 *     lib/ordering-group.ts) for the "By day" table's columns — the
 *     underlying pivot's `products`/CSV export stay alphabetical
 *     unchanged, this only reorders what the page renders.
 *   - formatRangeSummary: the grand-total headline string ("527 doses ·
 *     8/4–9/11").
 */

import { addDaysToChicagoDate, todayInChicago } from "@/lib/chicago-date";
import { getOrderingGroup, ORDERING_GROUP_DISPLAY_ORDER } from "@/lib/ordering-group";

/** Default lookback when nothing has been ingested yet (allRange below
 * has no earliestDay to anchor to) — same 14-day fallback the page used
 * as its ONLY default before this round. */
export const DEFAULT_LOOKBACK_DAYS = 14;

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

/** Yesterday, "YYYY-MM-DD" — the "last COMPLETE Chicago day" convention
 * every range preset below ends on (today is still in progress, so it's
 * excluded — same convention app/api/ordering/recommendation/route.ts's
 * given7d trend uses). `today` defaults to the real today but can be
 * overridden so callers (tests, and every function below) stay
 * deterministic without faking system time. */
export function yesterdayInChicago(today: string = todayInChicago()): string {
  return addDaysToChicagoDate(today, -1);
}

/** The last `days` COMPLETE Chicago days, ending yesterday — e.g.
 * `lastNDaysRange(7)` for the "Last 7 days" quick-pick. */
export function lastNDaysRange(days: number, today: string = todayInChicago()): { start: string; end: string } {
  const end = yesterdayInChicago(today);
  const start = addDaysToChicagoDate(end, -(days - 1));
  return { start, end };
}

/** The 1st of the current Chicago calendar month through yesterday, for
 * the "This month" quick-pick. JUDGMENT CALL: if today IS the 1st,
 * yesterday falls in the PREVIOUS month, which would otherwise produce
 * an inverted start > end range — this collapses that edge case to the
 * single day [yesterday, yesterday] rather than reaching back into last
 * month (a "this month" button showing last month's data would be more
 * surprising than a one-day range). */
export function thisMonthRange(today: string = todayInChicago()): { start: string; end: string } {
  const end = yesterdayInChicago(today);
  const [year, month] = today.split("-");
  const firstOfMonth = `${year}-${month}-01`;
  return { start: firstOfMonth > end ? end : firstOfMonth, end };
}

/**
 * "All" / default range: the earliest day with any doses on file through
 * yesterday — so the page's initial load (and its "All" quick-pick) show
 * the FULL ingested history instead of an arbitrary fixed lookback (the
 * bug this round fixes: 376 shown vs. 419 actually on file, because the
 * old fixed 14-day default cut off doses from earlier in the range).
 * Falls back to `lastNDaysRange(DEFAULT_LOOKBACK_DAYS)` when
 * `earliestDay` is null (nothing ingested yet — the route's
 * `earliestOnly=1` cheap query found no `administered:*` keys at all).
 */
export function allRange(earliestDay: string | null, today: string = todayInChicago()): { start: string; end: string } {
  if (!earliestDay) return lastNDaysRange(DEFAULT_LOOKBACK_DAYS, today);
  const end = yesterdayInChicago(today);
  // Defensive: an earliestDay somehow after yesterday (clock skew, or a
  // same-day ingest before this function's own "yesterday" convention
  // catches up) still yields a valid, non-inverted range.
  return { start: earliestDay > end ? end : earliestDay, end };
}

export type QuickPickId = "all" | "last7" | "last14" | "thisMonth";

/** Resolves one of the page's quick-pick buttons to a concrete
 * [start, end] range. */
export function quickPickRange(
  id: QuickPickId,
  earliestDay: string | null,
  today: string = todayInChicago()
): { start: string; end: string } {
  switch (id) {
    case "all":
      return allRange(earliestDay, today);
    case "last7":
      return lastNDaysRange(7, today);
    case "last14":
      return lastNDaysRange(14, today);
    case "thisMonth":
      return thisMonthRange(today);
  }
}

/**
 * Reorders an already-alphabetical product list (buildDosesGivenPivot's
 * own `products`) into the Schedule page's column convention (V-doses-
 * given-layout, Will: "Vaccine columns in the same order/grouping the
 * Schedule page uses (COVID/Flu first, then the rest)") — COVID group
 * first, then Flu, then everything else, alphabetical within each group.
 * Uses lib/ordering-group.ts's getOrderingGroup — the SAME name-based
 * COVID/Flu/Other classifier Ordering already runs product display names
 * through (lib/product-view.ts), rather than a second grouping scheme,
 * so a product groups here exactly the way it already does everywhere
 * else in the app. Only reorders what the page RENDERS — the underlying
 * pivot.products (and CSV export, which reads it) stay alphabetical. */
export function orderProductsByGroup(products: string[]): string[] {
  const byGroup = new Map<string, string[]>(ORDERING_GROUP_DISPLAY_ORDER.map((group) => [group, []]));
  for (const product of products) {
    const group = getOrderingGroup(product);
    (byGroup.get(group) ?? byGroup.get(ORDERING_GROUP_DISPLAY_ORDER[ORDERING_GROUP_DISPLAY_ORDER.length - 1])!).push(
      product
    );
  }
  const ordered: string[] = [];
  for (const group of ORDERING_GROUP_DISPLAY_ORDER) {
    ordered.push(...(byGroup.get(group) ?? []).sort((a, b) => a.localeCompare(b)));
  }
  return ordered;
}

/** "8/4" from "2026-08-04" — same short month/day convention as the
 * Schedule page's formatDayLabel, minus the weekday prefix (this is a
 * compact range headline, not a table row label). */
function formatShortDate(dateStr: string): string {
  const [, month, day] = dateStr.split("-");
  return `${Number(month)}/${Number(day)}`;
}

/** The prominent grand-total headline (V-doses-given-layout, Will:
 * "Show the grand total prominently") — e.g. "527 doses · 8/4–9/11". */
export function formatRangeSummary(grandTotal: number, start: string, end: string): string {
  const doseWord = grandTotal === 1 ? "dose" : "doses";
  return `${grandTotal} ${doseWord} · ${formatShortDate(start)}–${formatShortDate(end)}`;
}
