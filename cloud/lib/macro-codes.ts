import { pickCurrentActiveLot, type LotStatusLike } from "@/lib/lots-table";
import { partitionProductsForLotsPage } from "@/lib/lots-grouping";
import { ORDERING_GROUP_DISPLAY_ORDER } from "@/lib/ordering-group";
import { lookupMacroCatalog, MACRO_CATALOG_OTHER, type MacroFamily } from "@/lib/macro-catalog";
import type { ProductView } from "@/lib/product-view";

export type { MacroFamily } from "@/lib/macro-catalog";

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
 *
 * ROUND 3 (Will's verbatim feedback): "Make the 'All vaccines' section
 * be 'Other vaccines' and don't include flu/covid... Eliminate the age
 * range distinction in flu/covid and combine them. Arrange them by
 * age... combine the HPV heading instead of listing it multiple
 * times... if it's the same product, no need to list it multiple
 * times." Drops the round-2 quick-view `sections` concept for a single
 * `family` split (lib/macro-catalog.ts) and adds groupMacroRowsForFamily
 * below, which sorts+annotates one family's rows so the page can render
 * one bordered Type block and one Age/Product+price line per product
 * instead of repeating them on every dose row.
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
  /** Sort key matching the sheet's "Other vaccines" row order — see
   * lib/macro-catalog.ts. Not used to order the fluCovid family, which
   * sorts by ageMinMonths instead. */
  sheetOrder: number;
  /** "fluCovid" (combined Flu/COVID section) or "other" ("Other
   * vaccines" section) — see lib/macro-catalog.ts's macroFamilyForType. */
  family: MacroFamily;
  /** Short approved-age-range label, e.g. "12+", "3–11", "6 mo+". ""
   * for an unrecognized short code. */
  age: string;
  /** Numeric floor of `age` in months, for sorting the fluCovid family
   * youngest-eligible-first. Unrecognized codes sort last. */
  ageMinMonths: number;
  /** How many real dose rows this product has (1 for a single-dose
   * product or one with no short code at all) — used by the UI to blank
   * the Dose column for single-dose products. */
  doseCount: number;
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
        family: MACRO_CATALOG_OTHER.family,
        age: MACRO_CATALOG_OTHER.age,
        ageMinMonths: MACRO_CATALOG_OTHER.ageMinMonths,
        doseCount: 1,
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
    const doseCount = deduped.length;

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
        family: catalogEntry.family,
        age: catalogEntry.age,
        ageMinMonths: catalogEntry.ageMinMonths,
        doseCount,
        vaccineIds: product.vaccineIds,
      });
    }
  }

  return rows.sort(compareOtherOrder);
}

/** Default row order used by buildMacroRows itself, and by the "other"
 * family in groupMacroRowsForFamily below: the sheet's "Other vaccines"
 * row order, then dose number, then display name. */
function compareOtherOrder(a: MacroRow, b: MacroRow): number {
  return a.sheetOrder - b.sheetOrder || a.doseNumber - b.doseNumber || a.displayName.localeCompare(b.displayName);
}

/**
 * Type-group order for the combined Flu/COVID family (ROUND 3 REVIEW
 * FIX): sorting individual rows by ageMinMonths alone scattered a
 * multi-product Type into two separate runs whenever one of its
 * products had a much-later age than its siblings (mFLUSIVA at 50+ vs.
 * the rest of "Flu (regular)" at 6 mo+ — since fixed by giving it its
 * own type, but this keeps any future same-shaped mismatch from
 * recurring). Every catalog Type is kept as ONE contiguous block: the
 * block order is the type's OWN minimum ageMinMonths (youngest-
 * eligible-first), tie-broken by the type's minimum sheetOrder (the
 * sheet's original hand-authored type order — this is what puts
 * "Pfizer 12+" (sheetOrder 1) before "Moderna 12+" (sheetOrder 2)
 * despite both being age 12+) and then alphabetically by type name (a
 * final, deterministic guarantee that two types can never interleave
 * even if both tie on age and sheetOrder). Within one type's block,
 * rows sort by their own ageMinMonths, then product name, then dose.
 */
function sortFluCovidByTypeGroup(rows: readonly MacroRow[]): MacroRow[] {
  const typeGroupKey = new Map<string, { minAgeMinMonths: number; minSheetOrder: number }>();
  for (const row of rows) {
    const existing = typeGroupKey.get(row.catalogType);
    if (!existing) {
      typeGroupKey.set(row.catalogType, { minAgeMinMonths: row.ageMinMonths, minSheetOrder: row.sheetOrder });
    } else {
      existing.minAgeMinMonths = Math.min(existing.minAgeMinMonths, row.ageMinMonths);
      existing.minSheetOrder = Math.min(existing.minSheetOrder, row.sheetOrder);
    }
  }

  return [...rows].sort((a, b) => {
    const keyA = typeGroupKey.get(a.catalogType)!;
    const keyB = typeGroupKey.get(b.catalogType)!;
    return (
      keyA.minAgeMinMonths - keyB.minAgeMinMonths ||
      keyA.minSheetOrder - keyB.minSheetOrder ||
      a.catalogType.localeCompare(b.catalogType) ||
      a.ageMinMonths - b.ageMinMonths ||
      a.displayName.localeCompare(b.displayName) ||
      a.doseNumber - b.doseNumber
    );
  });
}

export type MacroGroupedRow = MacroRow & {
  /** True on the first row of a new catalog Type within the family —
   * the UI draws one bordered Type block per run of these. */
  showType: boolean;
  /** True on the first row of a new product within its Type block (also
   * true whenever showType is, since a new Type always starts a new
   * product) — the UI shows the Age/Product+price cells only here and
   * blanks them on the product's other dose rows. */
  showProduct: boolean;
};

/**
 * Sorts and groups `rows` (from buildMacroRows) down to one family —
 * "fluCovid" (combined Flu/COVID section, ordered by approved age) or
 * "other" ("Other vaccines" section, ordered by the sheet) — and
 * annotates each row with showType/showProduct so the page can render
 * the Type heading and the Age/Product+price cells exactly once per
 * group instead of once per dose row (Will's round-3 brief: "combine
 * the HPV heading instead of listing it multiple times... if it's the
 * same product, no need to list it multiple times").
 */
export function groupMacroRowsForFamily(rows: readonly MacroRow[], family: MacroFamily): MacroGroupedRow[] {
  const filtered = rows.filter((row) => row.family === family);
  const sorted = family === "fluCovid" ? sortFluCovidByTypeGroup(filtered) : [...filtered].sort(compareOtherOrder);

  let lastType: string | null = null;
  let lastProductKey: string | null = null;
  return sorted.map((row) => {
    const showType = row.catalogType !== lastType;
    const showProduct = showType || row.productKey !== lastProductKey;
    lastType = row.catalogType;
    lastProductKey = row.productKey;
    return { ...row, showType, showProduct };
  });
}
