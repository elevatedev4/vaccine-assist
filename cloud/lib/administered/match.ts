import { matchPioneerItemName } from "@/lib/on-hand/pioneer-boh";
import { normalizeNdc } from "@/lib/ndc";
import { lookupProduct } from "@/lib/vaccine-product-catalog";
import type { CatalogVaccine } from "@/lib/vaccine-matching";
import type { VaccinationLogRow } from "@/lib/administered/parse";

/**
 * Matches a vaccination-log row (PioneerRx's per-dose report —
 * lib/administered/parse.ts) against the vaccine catalog.
 *
 * V-administered-ndc-match (2026-09-13): some exports (the KPI-style
 * export in particular) now carry a "Dispensed Item NDC" column
 * (parse.ts's optional `ndc`, already digits-only normalized). When a
 * row has one, it's tried FIRST, mirroring the same two NDC passes
 * lib/on-hand/pioneer-boh.ts's matchPioneerBohRows uses for the BOH
 * stock report:
 *   1. Exact match against a catalog vaccine's own on-file `ndc`.
 *   2. The researched static catalog's packageNdc for that vaccine
 *      (lib/vaccine-product-catalog.ts's lookupProduct), which itself
 *      falls back to a product's known altNdcs — see
 *      ProductCatalogMatch.altNdcs and findCatalogEntry's alt-NDC
 *      fallback. Duplicated here (rather than importing
 *      pioneer-boh.ts's private catalogPackageNdcForVaccine) since that
 *      helper isn't exported — same lookupProduct call, same result.
 * A row with no NDC (the daily per-dose export never has one) or whose
 * NDC doesn't resolve falls back to the existing name matching
 * (matchPioneerItemName: Pioneer-specific name aliases, then the shared
 * free-text matcher) — unchanged from before this change.
 */

/** The researched static-catalog packageNdc for a catalog vaccine,
 * digits-only — see this file's top doc comment for why this mirrors
 * (rather than imports) lib/on-hand/pioneer-boh.ts's
 * catalogPackageNdcForVaccine. */
function catalogPackageNdcForVaccine(vaccine: CatalogVaccine): string | null {
  const match = lookupProduct({ name: vaccine.name, ndc: normalizeNdc(vaccine.ndc) });
  return match?.packageNdc ? normalizeNdc(match.packageNdc) : null;
}

/** NDC-first resolution (see top doc comment) — returns null when the
 * row's NDC doesn't match any catalog vaccine's on-file ndc or
 * researched packageNdc/altNdcs, so the caller can fall back to name
 * matching. */
function matchByNdc(ndc: string, catalog: CatalogVaccine[]): CatalogVaccine | null {
  const byExactNdc = catalog.find((vaccine) => normalizeNdc(vaccine.ndc) === ndc);
  if (byExactNdc) return byExactNdc;
  return catalog.find((vaccine) => catalogPackageNdcForVaccine(vaccine) === ndc) ?? null;
}

export type MatchedAdministeredRow = {
  at: string;
  /** The America/Chicago calendar date of `at` — carried straight from
   * VaccinationLogRow.dateLocal (not recomputed here) so
   * lib/administered/store.ts's day-key grouping always matches exactly
   * what the parser decided, rather than re-deriving it from `at` a
   * second time. */
  dateLocal: string;
  itemName: string;
  vaccineId: string | null;
};

/** Matches one row; `vaccineId` is null (not thrown/dropped) for an
 * unrecognized item name — the row is still kept (lib/administered/store.ts
 * persists it with vaccineId: null) so it counts toward `unmatched`
 * rather than silently vanishing. */
export function matchAdministeredRow(row: VaccinationLogRow, catalog: CatalogVaccine[]): MatchedAdministeredRow {
  // Defensively re-normalizes: VaccinationLogRow.ndc is documented as
  // already digits-only (parse.ts normalizes it), but normalizeNdc is
  // idempotent on an already-normalized value, so this costs nothing and
  // keeps this function correct even for a row built by some future
  // caller that skips parse.ts.
  const ndc = normalizeNdc(row.ndc ?? null);
  const byNdc = ndc ? matchByNdc(ndc, catalog) : null;
  const matched = byNdc ?? matchPioneerItemName(row.itemName, catalog);
  return { at: row.completedAt, dateLocal: row.dateLocal, itemName: row.itemName, vaccineId: matched?.id ?? null };
}

export function matchAdministeredRows(rows: VaccinationLogRow[], catalog: CatalogVaccine[]): MatchedAdministeredRow[] {
  return rows.map((row) => matchAdministeredRow(row, catalog));
}
