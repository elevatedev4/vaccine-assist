import { pickCurrentActiveLot, type LotStatusLike } from "@/lib/lots-table";
import { partitionProductsForLotsPage } from "@/lib/lots-grouping";
import { ORDERING_GROUP_DISPLAY_ORDER } from "@/lib/ordering-group";
import type { ProductView } from "@/lib/product-view";

/**
 * Pure logic for the /macro-codes tab (Will's brief, verbatim: "add new
 * tab 'Macro codes' that follows the setup of the attached excel file
 * and allows for one-click copying of the macro code for each dose").
 * Kept dependency-free of React/Supabase so it's directly unit-testable,
 * same posture as lib/lots-table.ts / lib/lots-grouping.ts.
 *
 * SOURCE-OF-TRUTH DISCOVERY (report this uncertainty back): the
 * formulary seed (supabase/seed/vaccines.sql, generated straight from
 * the pharmacy's real "Macro codes" Excel sheet — see
 * scripts/parse-formulary.mjs) already stores each per-dose `vaccine`
 * row's `short_code` as the FULL macro-code prefix for that specific
 * dose — e.g. Engerix's three dose rows carry short_code "engerix1" /
 * "engerix2" / "engerix3" outright, Shingrix's two rows carry
 * "shingrix1" / "shingrix2", etc. — NOT a shared undecorated base code
 * with the dose suffix added on afterward. So whenever a real `vaccine`
 * row exists for a given dose number, buildMacroRows below uses that
 * row's own short_code VERBATIM (via buildMacroCode with doseCount
 * forced to 1, i.e. no further suffixing) rather than re-appending a
 * dose suffix on top of it, which would double it up (e.g.
 * "engerix1" + "1" -> "engerix11"). buildMacroCode's own dose-suffix
 * behavior (suffix appended when doseCount > 1) is still real and
 * unit-tested as a pure function in isolation, and buildMacroRows DOES
 * use it for one deliberate fallback: if a product's configured dose
 * count (macro_dose_counts) is ever raised past the number of real
 * per-dose vaccine rows currently seeded for that product, a dose
 * number with no matching row gets a SYNTHESIZED code by stripping the
 * lowest real dose's own trailing dose-number digit (if present) to
 * recover a base, then handing that base + the target dose number to
 * buildMacroCode. This never fires with the shipped defaults (every
 * DEFAULT_DOSE_COUNTS entry matches today's actual seeded row count
 * exactly) — it only matters if Will raises a product's Doses setting
 * beyond what's currently in the `vaccine` table.
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

/**
 * Default doses-per-series for a product, keyed by the short_code BASE
 * (case-insensitive prefix match against a member vaccine's own
 * short_code) — used whenever `macro_dose_counts` (app_setting) hasn't
 * been overridden for that product yet. Matches every multi-dose series
 * currently seeded (supabase/seed/vaccines.sql) plus two not-yet-seeded
 * ones Will's brief names explicitly (twinrix, heplisav) so the tab
 * behaves correctly the moment either is added to the formulary.
 */
export const DEFAULT_DOSE_COUNTS: Readonly<Record<string, number>> = {
  shingrix: 2,
  engerix: 3,
  gardasil: 3,
  mmr: 2,
  priorix: 2,
  vaqtaadult: 2,
  twinrix: 3,
  heplisav: 2,
};

function defaultDoseCountForShortCode(shortCode: string): number {
  const lower = shortCode.toLowerCase();
  for (const [base, count] of Object.entries(DEFAULT_DOSE_COUNTS)) {
    if (lower.startsWith(base)) return count;
  }
  return 1;
}

export type MacroRowVaccine = {
  id: string;
  name: string;
  ndc: string | null;
  dose: string | null;
  short_code: string | null;
  active: boolean;
};

export type MacroLotLike = LotStatusLike & { lot_number: string };

export type MacroRow = {
  productKey: string;
  displayName: string;
  ndc: string | null;
  packageSize: number | null;
  doseNumber: number;
  doseCount: number;
  shortCode: string | null;
  lotNumber: string | null;
  expirationIso: string | null;
  macro: string | null;
  complete: boolean;
  /** Every dose vaccine_id for the WHOLE product (not just this dose) —
   * the fan-out target for a lot save, matching how /lots already
   * writes the same lot across every dose row of a product. */
  vaccineIds: string[];
};

/**
 * Builds the /macro-codes tab's rows: one per (active) product's dose,
 * ordered COVID -> Flu -> Other then alphabetically by display name
 * (lib/lots-grouping.ts's partitionProductsForLotsPage — the SAME
 * ordering /ordering and /lots already use), inactive products
 * excluded entirely.
 *
 * `activeLotsByVaccineId` should map a vaccine_id to ALL of its lots
 * (any status) — this function applies lib/lots-table.ts's
 * pickCurrentActiveLot itself, the SAME rule the /lots page and the
 * desktop app use, so a macro's lot/exp always matches what those show.
 */
export function buildMacroRows(
  products: readonly ProductView[],
  vaccines: readonly MacroRowVaccine[],
  activeLotsByVaccineId: Readonly<Record<string, readonly MacroLotLike[]>>,
  doseCounts: Readonly<Record<string, number>>
): MacroRow[] {
  const vaccineById = new Map(vaccines.map((v) => [v.id, v]));
  const { sections } = partitionProductsForLotsPage(products, ORDERING_GROUP_DISPLAY_ORDER);
  const orderedActiveProducts = sections.flatMap((section) => section.products);

  const rows: MacroRow[] = [];

  for (const product of orderedActiveProducts) {
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
        doseNumber: 1,
        doseCount: 1,
        shortCode: null,
        lotNumber: null,
        expirationIso: null,
        macro: null,
        complete: false,
        vaccineIds: product.vaccineIds,
      });
      continue;
    }

    const byDoseNumber = new Map<number, MacroRowVaccine>();
    for (const v of withShortCode) {
      const parsed = Number.parseInt(v.dose ?? "1", 10);
      const doseNumber = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
      if (!byDoseNumber.has(doseNumber)) byDoseNumber.set(doseNumber, v);
    }

    const lowestDose = Math.min(...byDoseNumber.keys());
    const lowestShortCode = (byDoseNumber.get(lowestDose) as MacroRowVaccine).short_code!.trim();
    const strippedBase = lowestShortCode.endsWith(String(lowestDose))
      ? lowestShortCode.slice(0, -String(lowestDose).length)
      : lowestShortCode;

    const doseCount = doseCounts[product.productKey] ?? defaultDoseCountForShortCode(lowestShortCode);

    for (let doseNumber = 1; doseNumber <= doseCount; doseNumber++) {
      const realVaccine = byDoseNumber.get(doseNumber);
      const lots = realVaccine ? activeLotsByVaccineId[realVaccine.id] ?? [] : [];
      const currentLot = pickCurrentActiveLot(lots);
      const lotNumber = currentLot?.lot_number ?? null;
      const expirationIso = currentLot?.expiration ?? null;

      const macroResult = realVaccine
        ? buildMacroCode({ shortCode: realVaccine.short_code!.trim(), doseNumber, doseCount: 1, lotNumber, expirationIso })
        : buildMacroCode({ shortCode: strippedBase, doseNumber, doseCount, lotNumber, expirationIso });

      rows.push({
        productKey: product.productKey,
        displayName: product.displayName,
        ndc: product.ndc,
        packageSize: product.packageSize,
        doseNumber,
        doseCount,
        shortCode: realVaccine ? realVaccine.short_code!.trim() : `${strippedBase}${doseNumber}`,
        lotNumber,
        expirationIso,
        macro: macroResult.text,
        complete: macroResult.complete,
        vaccineIds: product.vaccineIds,
      });
    }
  }

  return rows;
}
