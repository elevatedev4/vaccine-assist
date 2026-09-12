import { pickCurrentActiveLot, type LotStatusLike } from "@/lib/lots-table";
import { partitionProductsForLotsPage } from "@/lib/lots-grouping";
import { ORDERING_GROUP_DISPLAY_ORDER } from "@/lib/ordering-group";
import {
  lookupMacroCatalog,
  macroBaseShortCode,
  MACRO_CATALOG_OTHER,
  MACRO_SECTION_ORDER,
  MACRO_TOP_GROUP_ORDER,
  topGroupForSection,
  type MacroSection,
  type MacroTopGroup,
} from "@/lib/macro-catalog";
import type { ProductView } from "@/lib/product-view";

export type { MacroSection, MacroTopGroup } from "@/lib/macro-catalog";

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
 * `family` split (lib/macro-catalog.ts).
 *
 * ROUND 4 (Will's verbatim feedback): "Remove the age ranges and
 * extraneous data from product names... Move age range and price to the
 * end of the row. Have a section (Flu, Pneumonia, RSV, etc) and then
 * have the product name/dose be inside a colored button... Showing the
 * product name and dose number if there are multiple doses." Replaces
 * round-3's two-family split with lib/macro-catalog.ts's per-Type
 * `section`, and replaces groupMacroRowsForFamily with
 * groupMacroRowsBySection below: one row per PRODUCT (not per dose),
 * each carrying its doses as an ordered array of button specs (label +
 * the underlying MacroRow to copy/open-modal for), with age/price
 * surfaced once per product for the page to render at the row's end.
 * Names are no longer stripped here — they arrive already cleaned via
 * ProductView.displayName (lib/product-view.ts's buildProductViews).
 *
 * ROUND 5 (Will's verbatim feedback): "Add the approved age range to
 * the end of the product name inside the button. Hide prices for now.
 * Make it all fit better." doseButtonLabel below now appends every
 * product's catalog age to its button label (not just COVID's), and
 * the page no longer renders a separate age/price cell — see
 * app/macro-codes/page.tsx.
 *
 * ROUND 6 (bug fix, Will's live screenshot): the Shingles section
 * showed two identical "Shingrix · 50+ (19+ IC)" buttons with no dose
 * number. Upstream product grouping (lib/lots-grouping.ts) had split
 * Shingrix's two seeded dose rows into two separate ProductViews, so
 * buildMacroRows saw a doseCount of 1 for each and doseButtonLabel
 * never appended a dose number to either. groupMacroRowsBySection now
 * groups by cleaned display name within a section instead of by
 * productKey, so any product split this way still numbers its buttons
 * by dose order — fixing the root cause generically rather than
 * special-casing Shingrix.
 *
 * ROUND 7 (Will's verbatim feedback, 2026-09-12 — Will's own "round 6"):
 * "'COVID/Flu' group. Pneumonia, RSV, Shingles, Tdap, HPV should go in
 * the middle under 'Common', then all others under 'Other'... Ages go
 * in parenthesis. Just put 'Engerix-B adult' for the name. I think the
 * dose needs to say '(Dose X)' after the product name." Three changes:
 * (1) groupSectionsByTopGroup below layers round-4's sections into the
 * three top-level groups (lib/macro-catalog.ts's MacroTopGroup) the page
 * renders as its three columns; (2) doseButtonLabel now emits "<name>
 * (Dose N) (<age>)" instead of round 5's "<name> N · <age>", flattening
 * an age label that already carries its own parenthetical (e.g.
 * Shingrix's "50+ (19+ IC)") to a trailing comma clause so a button
 * never nests parens two deep; (3) macroDisplayNameFor renames Engerix-B
 * to "Engerix-B adult" (dropping "20 mcg") for THIS page only — the
 * shared /lots cleaner (lib/lots-display-name.ts) keeps "20 mcg" on
 * purpose (a tested "unknown qualifier survives" guarantee, not just
 * incidental collision-avoidance for this one product) so renaming it
 * there would loosen that general contract fleet-wide for a one-page
 * ask; see MACRO_DISPLAY_NAME_OVERRIDES below.
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
  /** Sort key matching the sheet's original row order — see
   * lib/macro-catalog.ts. Used as a tie-break within a section (see
   * groupMacroRowsBySection), after ageMinMonths. */
  sheetOrder: number;
  /** Round-4 section (Flu, COVID, Pneumonia, RSV, ...) — see
   * lib/macro-catalog.ts's sectionForType. */
  section: MacroSection;
  /** Short approved-age-range label, e.g. "12+", "3–11", "6 mo+". ""
   * for an unrecognized short code. */
  age: string;
  /** Numeric floor of `age` in months, for sorting a section's products
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

/** Round-7 per-page display-name overrides (see this file's header) —
 * keyed by the catalog's digit-stripped base short code (e.g.
 * "engerix1"/"engerix2"/"engerix3" -> base "engerix"). Applied only to
 * MacroRow.displayName, never to the shared ProductView.displayName. */
const MACRO_DISPLAY_NAME_OVERRIDES: Readonly<Record<string, string>> = {
  engerix: "Engerix-B adult",
};

function macroDisplayNameFor(defaultDisplayName: string, shortCode: string): string {
  return MACRO_DISPLAY_NAME_OVERRIDES[macroBaseShortCode(shortCode)] ?? defaultDisplayName;
}

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
        section: MACRO_CATALOG_OTHER.section,
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
        displayName: macroDisplayNameFor(product.displayName, shortCode),
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
        section: catalogEntry.section,
        age: catalogEntry.age,
        ageMinMonths: catalogEntry.ageMinMonths,
        doseCount,
        vaccineIds: product.vaccineIds,
      });
    }
  }

  return rows.sort(compareOtherOrder);
}

/** Default row order used by buildMacroRows' own final sort: the
 * sheet's row order, then dose number, then display name. */
function compareOtherOrder(a: MacroRow, b: MacroRow): number {
  return a.sheetOrder - b.sheetOrder || a.doseNumber - b.doseNumber || a.displayName.localeCompare(b.displayName);
}

/**
 * One clickable dose button's spec within a round-4 product row: the
 * underlying MacroRow (for the click handler — copy or open the
 * lot/exp modal, exactly as before) plus its pre-computed button label.
 */
export type MacroDoseButton = {
  row: MacroRow;
  label: string;
};

/** One product's row within a round-4 section: its doses (one button
 * spec per real dose row, dose-number order) plus the age/price shown
 * once at the end of the row. */
export type MacroProductGroup = {
  productKey: string;
  displayName: string;
  /** Catalog age-range label (lib/macro-catalog.ts), e.g. "12+",
   * "3–11". "" for an unrecognized/no-short-code product. */
  age: string;
  cashPriceCents: number | null;
  doses: MacroDoseButton[];
};

/** One section's block: its heading (`section`) plus its products in
 * round-4 display order (see groupMacroRowsBySection). */
export type MacroSectionGroup = {
  section: MacroSection;
  products: MacroProductGroup[];
};

/** Flattens a single trailing parenthetical inside an age label to a
 * comma clause — e.g. "50+ (19+ IC)" -> "50+, 19+ IC" — so a round-7
 * button label never nests parens two deep ("Shingrix (Dose 1) (50+
 * (19+ IC))"). An age with no parenthetical (e.g. "12+", "60+ / preg
 * 32–36 wk") passes through unchanged. */
function flattenAgeForLabel(age: string): string {
  return age.replace(/\s*\(([^)]*)\)\s*$/, ", $1");
}

/**
 * Builds a round-7 dose button's label (Will's verbatim brief,
 * 2026-09-12): "Ages go in parenthesis... I think the dose needs to say
 * '(Dose X)' after the product name." The product's displayName, PLUS
 * " (Dose N)" when the product has more than one real dose row (e.g.
 * "Shingrix (Dose 1)"/"Shingrix (Dose 2)"), PLUS " (<age>)" (the
 * catalog age-range label — flattened per flattenAgeForLabel above) for
 * every product that has one (e.g. "Shingrix (Dose 1) (50+, 19+ IC)",
 * "Abrysvo (60+ / preg 32–36 wk)", "Comirnaty 2026-2027 (12+)",
 * "Boostrix (10+)"). A product with no catalog age (age === "", e.g. an
 * unrecognized short code) gets no age suffix at all.
 */
function doseButtonLabel(row: MacroRow, doseCount: number): string {
  let label = row.displayName;
  if (doseCount > 1) label += ` (Dose ${row.doseNumber})`;
  if (row.age) label += ` (${flattenAgeForLabel(row.age)})`;
  return label;
}

/**
 * Sorts and groups `rows` (from buildMacroRows) into round-4's
 * section -> product -> dose-buttons shape (Will's brief, verbatim):
 * "Have a section (Flu, Pneumonia, RSV, etc) and then have the product
 * name/dose be inside a colored button... Showing the product name and
 * dose number if there are multiple doses." One MacroProductGroup per
 * PRODUCT (not per dose row) within each section, each carrying its
 * doses as ordered button specs; the page renders one button per dose
 * plus the product's age/price once at the row's end.
 *
 * Section order is MACRO_SECTION_ORDER (Flu, COVID, then the rest in
 * sheet order, Other last); an empty section is omitted. Within a
 * section, products sort by ageMinMonths, then sheetOrder, then
 * displayName (using the product's first/lowest-dose-number row as
 * representative — every dose of one product shares the same catalog
 * entry today).
 */
export function groupMacroRowsBySection(rows: readonly MacroRow[]): MacroSectionGroup[] {
  const bySection = new Map<MacroSection, Map<string, MacroRow[]>>();
  for (const row of rows) {
    const productsInSection = bySection.get(row.section) ?? new Map<string, MacroRow[]>();
    bySection.set(row.section, productsInSection);
    // Grouped by cleaned display name (not productKey): upstream grouping
    // (lib/lots-grouping.ts's groupVaccinesIntoProducts, keyed by the raw
    // `vaccine` row's NDC/name) can split one product's dose rows into
    // two separate ProductViews — e.g. Shingrix's two seeded dose rows
    // carrying mismatched NDCs — which previously surfaced here as two
    // single-dose product groups (doseCount 1 each, so doseButtonLabel
    // never appended a dose number: two identical "Shingrix · 50+ (19+
    // IC)" buttons instead of "Shingrix 1"/"Shingrix 2"). Re-grouping by
    // name within a section fixes that at the root — any two rows the
    // page would otherwise show side by side under the same product name
    // get numbered by dose order — without special-casing Shingrix.
    const nameKey = row.displayName.trim().toLowerCase();
    const productRows = productsInSection.get(nameKey) ?? [];
    productRows.push(row);
    productsInSection.set(nameKey, productRows);
  }

  const sections: MacroSectionGroup[] = [];
  for (const section of MACRO_SECTION_ORDER) {
    const productsInSection = bySection.get(section);
    if (!productsInSection || productsInSection.size === 0) continue;

    const products: MacroProductGroup[] = Array.from(productsInSection.values()).map((productRows) => {
      const sortedRows = [...productRows].sort((a, b) => a.doseNumber - b.doseNumber);
      const doseCount = sortedRows.length;
      const first = sortedRows[0];
      return {
        productKey: first.productKey,
        displayName: first.displayName,
        age: first.age,
        cashPriceCents: first.cashPriceCents,
        doses: sortedRows.map((row) => ({ row, label: doseButtonLabel(row, doseCount) })),
      };
    });

    products.sort((a, b) => {
      const rowA = a.doses[0].row;
      const rowB = b.doses[0].row;
      return (
        rowA.ageMinMonths - rowB.ageMinMonths ||
        rowA.sheetOrder - rowB.sheetOrder ||
        a.displayName.localeCompare(b.displayName)
      );
    });

    sections.push({ section, products });
  }

  return sections;
}

/** One round-7 top-level group's block: its group heading plus its
 * member section groups, in MACRO_SECTION_ORDER's relative order. */
export type MacroTopGroupBlock = {
  group: MacroTopGroup;
  sections: MacroSectionGroup[];
};

/**
 * Layers groupMacroRowsBySection's flat section list into round-7's
 * three top-level groups (Will's verbatim brief, 2026-09-12): "'COVID/
 * Flu' group. Pneumonia, RSV, Shingles, Tdap, HPV should go in the
 * middle under 'Common', then all others under 'Other'." Group order is
 * MACRO_TOP_GROUP_ORDER; within a group, sections keep the relative
 * order groupMacroRowsBySection already gave them (MACRO_SECTION_ORDER).
 * A group with no sections in it is omitted, same posture as an empty
 * section being omitted above.
 */
export function groupSectionsByTopGroup(sections: readonly MacroSectionGroup[]): MacroTopGroupBlock[] {
  const byGroup = new Map<MacroTopGroup, MacroSectionGroup[]>();
  for (const section of sections) {
    const group = topGroupForSection(section.section);
    const list = byGroup.get(group) ?? [];
    list.push(section);
    byGroup.set(group, list);
  }

  return MACRO_TOP_GROUP_ORDER.map((group) => ({ group, sections: byGroup.get(group) ?? [] })).filter(
    (block) => block.sections.length > 0
  );
}
