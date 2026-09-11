import { pickCurrentActiveLot, type LotStatusLike } from "@/lib/lots-table";
import { partitionProductsForLotsPage } from "@/lib/lots-grouping";
import { ORDERING_GROUP_DISPLAY_ORDER } from "@/lib/ordering-group";
import { lookupMacroCatalog, MACRO_CATALOG_OTHER, type MacroSection } from "@/lib/macro-catalog";
import type { ProductView } from "@/lib/product-view";

/**
 * Pure logic for the /macro-codes tab (Will's brief, verbatim: "add new
 * tab 'Macro codes' that follows the setup of the attached excel file
 * and allows for one-click copying of the macro code for each dose").
 * Kept dependency-free of React/Supabase so it's directly unit-testable,
 * same posture as lib/lots-table.ts / lib/lots-grouping.ts.
 *
 * ROUND 2 (Will's verbatim feedback): "Remove the entry box for dose.
 * It's always set already... Shingrix is currently showing up with 4
 * lines due to some weird error... follow the same format as the excel
 * file." This rewrite drops the round-1 "Doses" setting entirely
 * (formerly lib/macro-codes-settings.ts + its API route, now deleted) —
 * buildMacroRows below emits exactly one row per REAL `vaccine` row that
 * carries a short_code, never a synthesized dose beyond what's actually
 * seeded. The round-1 4-line Shingrix bug was that mechanism: a
 * per-product "Doses" number input (persisted to app_setting as
 * macro_dose_counts) could be raised past the product's real seeded row
 * count — e.g. to 4 for Shingrix, which only ever has 2 real dose rows —
 * and the old buildMacroRows synthesized the extra dose numbers with a
 * blank/incomplete macro. Deleting the whole override mechanism removes
 * that failure mode outright. As a second, independent safeguard (in
 * case the underlying `vaccine` table itself ever grows a genuine
 * duplicate row for one short_code — e.g. two rows during an NDC
 * transition), buildMacroRows also de-dupes by short_code, preferring
 * whichever duplicate is active AND has a lot on file (see
 * pickBetterDuplicate below).
 */

/** "YYYY-MM-DD" (or a longer ISO timestamp with that prefix) -> the
 * macro format's "MMDDYYYY", or "" for a null/missing/unparseable
 * value. Deliberately never emits a placeholder date — a missing
 * expiration renders as an empty segment in the macro text, per Will's
 * brief ("do NOT emit the 12301899 placeholder"). */
export function expToMacroDate(isoDate: string | null | undefined): string {
  if (!isoDate) return "";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  if (!match) return "";
  const [, yyyy, mm, dd] = match;
  return `${mm}${dd}${yyyy}`;
}

export type BuildMacroCodeInput = {
  /** The code to use as the macro's prefix. Treated as a BASE code that
   * gets the dose number appended when doseCount > 1 — pass an
   * already-fully-qualified code (e.g. a real vaccine row's own
   * short_code) together with doseCount: 1 to use it as-is. */
  shortCode: string;
  doseNumber: number;
  doseCount: number;
  lotNumber: string | null | undefined;
  expirationIso: string | null | undefined;
};

export type MacroCodeResult = { text: string; complete: boolean };

/**
 * Builds one macro's text: `<shortCode><suffix>,<LOT>,<MMDDYYYY>` — the
 * dose-number suffix is appended only when doseCount > 1 (single-dose
 * products/rows never get one). `complete` is false whenever the lot
 * number or expiration is missing; the text is still fully built with
 * blank segments in that case (e.g. "flucelvaxmdv,,") so the UI can show
 * exactly what's missing rather than hiding the row.
 */
export function buildMacroCode({ shortCode, doseNumber, doseCount, lotNumber, expirationIso }: BuildMacroCodeInput): MacroCodeResult {
  const suffix = doseCount > 1 ? String(doseNumber) : "";
  const code = `${shortCode}${suffix}`;
  const lot = (lotNumber ?? "").trim();
  const exp = expToMacroDate(expirationIso);
  return { text: `${code},${lot},${exp}`, complete: lot.length > 0 && exp.length > 0 };
}

export type MacroRowVaccine = {
  id: string;
  name: string;
  ndc: string | null;
  dose: string | null;
  short_code: string | null;
  active: boolean;
  cash_price_cents?: number | null;
};

export type MacroLotLike = LotStatusLike & { lot_number: string };

export type MacroRow = {
  productKey: string;
  displayName: string;
  ndc: string | null;
  packageSize: number | null;
  cashPriceCents: number | null;
  doseNumber: number;
  shortCode: string | null;
  lotNumber: string | null;
  expirationIso: string | null;
  macro: string | null;
  complete: boolean;
  /** Sheet "Type" column value (lib/macro-catalog.ts), e.g. "Shingles". */
  catalogType: string;
  /** Sort key matching the sheet's "All vaccines" row order — see
   * lib/macro-catalog.ts. */
  sheetOrder: number;
  /** Which quick-view sections (age3to11/age12plus/altFlu) this row
   * belongs to, per lib/macro-catalog.ts — empty when the product is
   * only in "All vaccines". */
  sections: readonly MacroSection[];
  /** Every dose vaccine_id for the WHOLE product (not just this dose) —
   * the fan-out target for a lot save, matching how /lots already
   * writes the same lot across every dose row of a product. */
  vaccineIds: string[];
};

function doseNumberOf(vaccine: MacroRowVaccine): number {
  const parsed = Number.parseInt(vaccine.dose ?? "1", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

/**
 * Picks the "real" row when two `vaccine` rows share the same
 * short_code (a genuine data-hygiene issue, e.g. leftover rows from an
 * NDC transition) — prefers active over inactive, then whichever has a
 * current lot on file, then whichever came first. Never fires under
 * normal operation (short_code is unique per real dose today); exists
 * so a future duplicate can't silently double a product's row count
 * again the way the round-1 dose-count override did.
 */
function pickBetterDuplicate(
  candidate: MacroRowVaccine,
  current: MacroRowVaccine,
  activeLotsByVaccineId: Readonly<Record<string, readonly MacroLotLike[]>>
): MacroRowVaccine {
  if (candidate.active !== current.active) return candidate.active ? candidate : current;
  const candidateHasLot = pickCurrentActiveLot(activeLotsByVaccineId[candidate.id] ?? []) !== null;
  const currentHasLot = pickCurrentActiveLot(activeLotsByVaccineId[current.id] ?? []) !== null;
  if (candidateHasLot !== currentHasLot) return candidateHasLot ? candidate : current;
  return current; // keep first occurrence
}

/**
 * Builds the /macro-codes tab's rows: exactly one row per REAL,
 * short_code-bearing `vaccine` row of every active product (never a
 * synthesized dose — see this file's header comment), each annotated
 * with its macro-catalog type/section membership so the page can slot it
 * into the right quick-view section(s). Final order: sheetOrder (the
 * Excel sheet's row order), then dose number, then display name.
 *
 * `activeLotsByVaccineId` should map a vaccine_id to ALL of its lots
 * (any status) — this function applies lib/lots-table.ts's
 * pickCurrentActiveLot itself, the SAME rule the /lots page and the
 * desktop app use, so a macro's lot/exp always matches what those show.
 */
export function buildMacroRows(
  products: readonly ProductView[],
  vaccines: readonly MacroRowVaccine[],
  activeLotsByVaccineId: Readonly<Record<string, readonly MacroLotLike[]>>
): MacroRow[] {
  const vaccineById = new Map(vaccines.map((v) => [v.id, v]));
  const { sections } = partitionProductsForLotsPage(products, ORDERING_GROUP_DISPLAY_ORDER);
  const activeProducts = sections.flatMap((section) => section.products);

  const rows: MacroRow[] = [];

  for (const product of activeProducts) {
    const memberVaccines = product.vaccineIds
      .map((id) => vaccineById.get(id))
      .filter((v): v is MacroRowVaccine => Boolean(v));
    const withShortCode = memberVaccines.filter((v) => v.short_code && v.short_code.trim().length > 0);

    if (withShortCode.length === 0) {
      rows.push({
        productKey: product.productKey,
        displayName: product.displayName,
        ndc: product.ndc,
        packageSize: product.packageSize,
        cashPriceCents: null,
        doseNumber: 1,
        shortCode: null,
        lotNumber: null,
        expirationIso: null,
        macro: null,
        complete: false,
        catalogType: MACRO_CATALOG_OTHER.type,
        sheetOrder: MACRO_CATALOG_OTHER.sheetOrder,
        sections: MACRO_CATALOG_OTHER.sections,
        vaccineIds: product.vaccineIds,
      });
      continue;
    }

    // De-dupe by short_code (trimmed, case-insensitive) — see
    // pickBetterDuplicate's doc comment.
    const bestByShortCode = new Map<string, MacroRowVaccine>();
    for (const v of withShortCode) {
      const key = v.short_code!.trim().toLowerCase();
      const existing = bestByShortCode.get(key);
      bestByShortCode.set(key, existing ? pickBetterDuplicate(v, existing, activeLotsByVaccineId) : v);
    }
    const deduped = Array.from(bestByShortCode.values()).sort((a, b) => doseNumberOf(a) - doseNumberOf(b));

    for (const realVaccine of deduped) {
      const doseNumber = doseNumberOf(realVaccine);
      const shortCode = realVaccine.short_code!.trim();
      const lots = activeLotsByVaccineId[realVaccine.id] ?? [];
      const currentLot = pickCurrentActiveLot(lots);
      const lotNumber = currentLot?.lot_number ?? null;
      const expirationIso = currentLot?.expiration ?? null;
      const macroResult = buildMacroCode({ shortCode, doseNumber, doseCount: 1, lotNumber, expirationIso });
      const catalogEntry = lookupMacroCatalog(shortCode);

      rows.push({
        productKey: product.productKey,
        displayName: product.displayName,
        ndc: product.ndc,
        packageSize: product.packageSize,
        cashPriceCents: realVaccine.cash_price_cents ?? null,
        doseNumber,
        shortCode,
        lotNumber,
        expirationIso,
        macro: macroResult.text,
        complete: macroResult.complete,
        catalogType: catalogEntry.type,
        sheetOrder: catalogEntry.sheetOrder,
        sections: catalogEntry.sections,
        vaccineIds: product.vaccineIds,
      });
    }
  }

  return rows.sort(
    (a, b) => a.sheetOrder - b.sheetOrder || a.doseNumber - b.doseNumber || a.displayName.localeCompare(b.displayName)
  );
}
