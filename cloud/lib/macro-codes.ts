import { pickCurrentActiveLot, type LotStatusLike } from "@/lib/lots-table";
import { lotExpiryState, type LotExpiryState } from "@/lib/lot-expiry";
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
import { covidVaccineMaker, stripCovidMakerPrefix, vaccineDisplayName } from "@/lib/vaccine-display-name";
import { parseAgeRange, ageRangeIncludes } from "@/lib/age-range";

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
 *
 * ROUND 8 (Will's verbatim feedback, 2026-09-12, replying to round 7):
 * "I don't like the layout where you have a heading then next row the
 * buttons. Instead, have the heading be in 1 column, then the buttons
 * next to it stacked vertically... I want to see two versions as well:
 * one that has another column after type (ex: tdap), then product (ex
 * Boostrix (with age range)) > Dose 1 button... If you have any other
 * ideas to make this user friendly... feel free to research the best
 * way and make another version." Adds three pure helpers the page's new
 * A/B/C layout switcher uses, none of which change buildMacroRows/
 * groupMacroRowsBySection/groupSectionsByTopGroup's data shape — only
 * how the page renders it: (1) macroSectionDisplayName, the section-level
 * counterpart to MACRO_DISPLAY_NAME_OVERRIDES above, so a family/section
 * heading can read "Tdap" instead of the catalog's "Tetanus" wherever a
 * version shows it; (2) macroProductNameWithAge, a product-level (not
 * per-dose) "<name> (<age>)" label reusing doseButtonLabel's age-
 * flattening for version B's plain-text product-name column; (3)
 * filterMacroTopGroups, version C's live-filter-as-you-type matching
 * logic. Also adds the view-mode switcher's tiny localStorage
 * read/write pair (readMacroViewMode/writeMacroViewMode), factored out
 * of the page so it's unit-testable without a DOM (see this file's
 * MacroViewModeStorage doc comment) — Will's brief requires the
 * read/write be wrapped so an unavailable/blocked store never throws.
 *
 * ROUND 9 (Will's verbatim feedback, 2026-09-13, replying to round 8 —
 * "I like C so far... let's work on improving C"): polishes version C
 * only (A/B untouched). MacroRow/MacroProductGroup grow two new fields,
 * `ageBase`/`note`, piped straight through from lib/macro-catalog.ts's
 * same-named MacroCatalogEntry fields — `age` itself is NOT touched, so
 * doseButtonLabel/macroProductNameWithAge (and hence every version-A/B
 * label and this file's own existing tests) stay byte-identical to
 * round 8. Version C's page renderer (app/macro-codes/page.tsx) uses
 * `ageBase` for its compact "age · price" line and `note` for its ⓘ
 * tooltip; filterMacroTopGroups now also matches a query against
 * `note`, per Will's brief ("filter box should also match the note
 * text").
 *
 * ROUND 10 (Will's verbatim feedback, 2026-09-13): "Change 'Copy' to
 * 'One dose.' Add one tiny deemphasized line on the buttons for 1-3
 * dose items that includes the schedule for when to get those doses."
 * Two changes, both to version B/C's short per-dose button label (the
 * embed popup reuses C, so it inherits both automatically):
 * (1) doseButtonShortLabel (moved here from app/macro-codes/page.tsx,
 * exported, so it's unit-testable like doseButtonLabel/
 * macroProductNameWithAge above) now returns "One dose" instead of
 * "Copy" for a single-dose product; (2) MacroRow grows `doseInterval`,
 * piped straight from lib/macro-catalog.ts's new MacroCatalogEntry.
 * doseSchedule, keyed by THIS row's dose number — undefined for dose 1
 * and for any single-dose product, regardless of whether the catalog
 * even has a doseSchedule for it. The page renders this as a second,
 * muted line on the dose button (page.tsx's renderDoseButton `subLabel`
 * option); this file only computes the value, same "pure data, page
 * renders it" split as ageBase/note above.
 *
 * ROUND 14 (V-T48, Will's verbatim brief, 2026-09-16): "Make C the
 * default view. Delete the other views." Versions A/B and the round-8
 * switcher's persisted localStorage choice are gone — see
 * getMacroViewMode/MACRO_VIEW_MODE below (replacing readMacroViewMode/
 * writeMacroViewMode/MacroViewMode's old "A"|"B"|"C" union/
 * MACRO_VIEW_MODES/MACRO_VIEW_MODE_STORAGE_KEY/DEFAULT_MACRO_VIEW_MODE/
 * MacroViewModeStorage).
 *
 * ROUND 15 (Will's verbatim ask, 2026-09-24, follow-up to the maker-name
 * feature: "vaccine macro codes: follow up to brand covnetion. Make it
 * look liek this: Pfizer 12+ (Comirnaty 2026-27)"): for COVID products
 * ONLY (Comirnaty/Spikevax/mNEXSPIKE), every name shown on this page —
 * doseButtonLabel's per-dose button text, and the page's bare
 * product-name sites (product-name row, dose button `topLabel`, the ⚙
 * menu aria-label, the lot/exp modal heading, and the postToHost
 * `product` field) — now reads "<Maker> <age> (<DrugName> <season>)"
 * (e.g. "Pfizer 12+ (Comirnaty 2026-27)", "Moderna 3–11 (Spikevax
 * 2026-27)") instead of round 7's "<Maker> <DrugName> <season> (<age>)"
 * ("Pfizer Comirnaty 2026-2027 (12+)"). covidMacroLabel below builds
 * this composite (maker via lib/vaccine-display-name.ts's new
 * covidVaccineMaker export, reused rather than duplicated); a
 * multi-dose product's "(Dose N)" clause — defensive, no COVID product
 * is multi-dose today — lands after the maker+age, before the
 * parenthesized drug name, per Will's brief. doseButtonLabel and the
 * new macroProductDisplayLabel (the page's non-per-dose sites) both
 * call it for a COVID name; every non-COVID name is untouched (still
 * round 7/8's plain composition below, and vaccineDisplayName's
 * identity no-op).
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

// V-lots-bud-spikevax follow-up (Will 2026-09-25 4:58pm): "if a beyond
// use date is expired... stop them from copying the code... just like
// if it were expired" — macro-codes' lot map needs beyond_use_date too,
// not just expiration, so buildMacroRows can compute lotExpiry below via
// lib/lot-expiry.ts's lotExpiryState (the SAME expired/bud-expired rule
// the desktop data-entry gate now uses). Optional, not required, since
// the underlying `lot` table column itself is additive/degradable (see
// app/api/lots/route.ts's beyond_use_date doc comment) — a caller on an
// old schema can still omit it entirely.
export type MacroLotLike = LotStatusLike & { lot_number: string; beyond_use_date?: string | null };

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
  /** The current lot's beyond-use date, or null when unset/no lot — see
   * MacroLotLike's doc comment. Independent of whether the product's
   * BUD setting is "on" (lib/lots-bud-defaults.ts) — this is just
   * whatever's on file, which app/macro-codes/page.tsx's "update the
   * lot" modal uses to decide whether to show a BUD field for THIS row. */
  beyondUseDateIso: string | null;
  macro: string | null;
  complete: boolean;
  /** V-lots-bud-spikevax follow-up (Will 2026-09-25 4:58pm): 'expired'
   * or 'bud-expired' (lib/lot-expiry.ts's lotExpiryState) blocks a copy
   * exactly like a missing lot/exp does — see app/macro-codes/page.tsx's
   * handleCopy and lib/macro-dose-button.tsx's lotExpiryNote for the two
   * consumers. Computed once here (needs `today`, which buildMacroRows
   * now takes) rather than re-derived per-render. */
  lotExpiry: LotExpiryState;
  /** Sheet "Type" column value (lib/macro-catalog.ts), e.g. "Shingles". */
  catalogType: string;
  /** Sort key matching the sheet's original row order — see
   * lib/macro-catalog.ts. Used as a tie-break within a section (see
   * groupMacroRowsBySection), after ageMinMonths. */
  sheetOrder: number;
  /** Round-4 section (Flu, COVID, Pneumonia, RSV, ...) — see
   * lib/macro-catalog.ts's sectionForType. */
  section: MacroSection;
  /** Short approved-age-range label, INCLUDING any qualifier clause,
   * e.g. "12+", "3–11", "6 mo+", "50+ (19+ IC)". "" for an unrecognized
   * short code. See lib/macro-catalog.ts's MacroCatalogEntry.age doc
   * comment — this is the FULL label version A/B render. */
  age: string;
  /** ROUND 9: version C's compact base age range with any qualifier
   * clause stripped (lib/macro-catalog.ts's MacroCatalogEntry.ageBase).
   * Equal to `age` verbatim when the product has no qualifier. */
  ageBase: string;
  /** ROUND 9: special-qualification note for version C's ⓘ tooltip
   * (lib/macro-catalog.ts's MacroCatalogEntry.note). Undefined when the
   * product has no qualification. */
  note?: string;
  /** Numeric floor of `age` in months, for sorting a section's products
   * youngest-eligible-first. Unrecognized codes sort last. */
  ageMinMonths: number;
  /** ROUND 10: the interval text for THIS dose, stated as time after
   * the previous dose (lib/macro-catalog.ts's MacroCatalogEntry.
   * doseSchedule, keyed by doseNumber). Undefined for dose 1, for a
   * single-dose product (doseCount === 1), and for a product with no
   * doseSchedule entry for this dose number at all. */
  doseInterval?: string;
  /** How many real dose rows this product has (1 for a single-dose
   * product or one with no short code at all) — used by the UI to blank
   * the Dose column for single-dose products. */
  doseCount: number;
  /** Every dose vaccine_id for the WHOLE product (not just this dose) —
   * the fan-out target for a lot save, matching how /lots already
   * writes the same lot across every dose row of a product. */
  vaccineIds: string[];
  /** V-T50: the resolved macro-catalog product color key (lib/
   * macro-catalog.ts's MacroCatalogEntry.colorKey) — lib/
   * macro-dose-button.tsx's PRODUCT_COLORS looks a dose button's color
   * up by this before falling back to the section color. "" for an
   * unrecognized short code (MACRO_CATALOG_OTHER). */
  colorKey: string;
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

/** Round-8 per-page section/family heading display-name overrides — same
 * posture as MACRO_DISPLAY_NAME_OVERRIDES above, but keyed by
 * MacroSection rather than a short code. Applied only where a version's
 * layout shows the family/section name itself (e.g. version B/C's
 * "type" column, version A's family cell); the section's own identity
 * (MacroSectionGroup.section, used for grouping/sorting/color lookup)
 * is never touched. Will's verbatim example: "another column after type
 * (ex: tdap)" — Tetanus is the section that contains Boostrix (TDaP). */
const MACRO_SECTION_DISPLAY_NAME_OVERRIDES: Readonly<Partial<Record<MacroSection, string>>> = {
  Tetanus: "Tdap",
};

/** Resolves a section's display label for a version's family/type
 * column or heading — "Tdap" for Tetanus, every other section's own
 * name otherwise. */
export function macroSectionDisplayName(section: MacroSection): string {
  return MACRO_SECTION_DISPLAY_NAME_OVERRIDES[section] ?? section;
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
 *
 * `today` ("YYYY-MM-DD", pass lib/chicago-date.ts's todayInChicago()) is
 * used to compute each row's MacroRow.lotExpiry via lib/lot-expiry.ts's
 * lotExpiryState (V-lots-bud-spikevax follow-up, Will 2026-09-25).
 */
export function buildMacroRows(
  products: readonly ProductView[],
  vaccines: readonly MacroRowVaccine[],
  activeLotsByVaccineId: Readonly<Record<string, readonly MacroLotLike[]>>,
  today: string
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
        beyondUseDateIso: null,
        macro: null,
        complete: false,
        lotExpiry: "ok",
        catalogType: MACRO_CATALOG_OTHER.type,
        sheetOrder: MACRO_CATALOG_OTHER.sheetOrder,
        section: MACRO_CATALOG_OTHER.section,
        age: MACRO_CATALOG_OTHER.age,
        ageBase: MACRO_CATALOG_OTHER.ageBase,
        note: MACRO_CATALOG_OTHER.note,
        ageMinMonths: MACRO_CATALOG_OTHER.ageMinMonths,
        doseInterval: undefined,
        doseCount: 1,
        vaccineIds: product.vaccineIds,
        colorKey: MACRO_CATALOG_OTHER.colorKey,
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
      const beyondUseDateIso = currentLot?.beyond_use_date ?? null;
      const lotExpiry = lotExpiryState({ expiration: expirationIso, beyond_use_date: beyondUseDateIso }, today);
      const macroResult = buildMacroCode({ shortCode, doseNumber, doseCount: 1, lotNumber, expirationIso });
      const catalogEntry = lookupMacroCatalog(shortCode, realVaccine.name);
      // ROUND 10: only a dose past the first, of a genuinely multi-dose
      // product, ever carries an interval — see MacroRow.doseInterval's
      // doc comment above.
      const doseInterval = doseCount > 1 && doseNumber > 1 ? catalogEntry.doseSchedule?.[doseNumber] : undefined;

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
        beyondUseDateIso,
        macro: macroResult.text,
        complete: macroResult.complete,
        lotExpiry,
        catalogType: catalogEntry.type,
        sheetOrder: catalogEntry.sheetOrder,
        section: catalogEntry.section,
        age: catalogEntry.age,
        ageBase: catalogEntry.ageBase,
        note: catalogEntry.note,
        ageMinMonths: catalogEntry.ageMinMonths,
        doseInterval,
        doseCount,
        vaccineIds: product.vaccineIds,
        colorKey: catalogEntry.colorKey,
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
  /** ROUND 9: version C's compact base age range with any qualifier
   * clause stripped (see MacroRow.ageBase). Equal to `age` verbatim
   * when the product has no qualifier. */
  ageBase: string;
  /** ROUND 9: special-qualification note for version C's ⓘ tooltip
   * (see MacroRow.note). Undefined when the product has no
   * qualification. */
  note?: string;
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
 * (19+ IC))"). An age with no parenthetical (e.g. "12+", "2–49")
 * passes through unchanged. */
function flattenAgeForLabel(age: string): string {
  return age.replace(/\s*\(([^)]*)\)\s*$/, ", $1");
}

// A "YYYY-YY"/"YYYY-YYYY" season token, optionally wrapped in its own
// parens — "2026-27", "2026-2027", "(2026-27)". Captures the two year
// halves so splitCovidDrugNameAndSeason below can normalize a 4-digit
// end year down to 2 digits.
const SEASON_TOKEN = /\(?\s*(\d{4})-(\d{4}|\d{2})\s*\)?/;

/** Splits a COVID product's stored display name into its base product
 * word (in the name's own stored casing — "Comirnaty", "mNEXSPIKE",
 * "Spikevax") and a normalized "YYYY-YY" season, if the name carries
 * one — "Comirnaty 2026-2027" -> {drugWord: "Comirnaty", season:
 * "2026-27"}, "mNEXSPIKE (2026-27)" -> {drugWord: "mNEXSPIKE", season:
 * "2026-27"}, "Comirnaty 2025-26 12+" -> {drugWord: "Comirnaty",
 * season: "2025-26"} (the embedded "12+" age token is never consulted —
 * covidMacroLabel takes age from its own `age` parameter, the same
 * catalog age doseButtonLabel already used, not from the name), the
 * standalone word "Formula" is dropped, and "Comirnaty" (no season in
 * the name) -> {drugWord: "Comirnaty", season: null}.
 *
 * ROUND 16 (reviewer finding, 2026-09-24): an already maker-prefixed
 * name — "Pfizer Comirnaty 2026-27" (unreachable from any of today's
 * real render sites, which always pass the RAW catalog name, but this
 * function is exported and its input isn't otherwise constrained) —
 * used to take "Pfizer" itself as the drug word, dropping "Comirnaty"
 * entirely ("Pfizer 12+ (Pfizer 2026-27)"). lib/vaccine-display-name.
 * ts's stripCovidMakerPrefix (reused, not duplicated) now strips a
 * leading "Pfizer "/"Moderna " off the name FIRST, so the drug word is
 * always the real product word regardless of whether the caller passed
 * an already-prefixed or a raw name. */
function splitCovidDrugNameAndSeason(displayName: string): { drugWord: string; season: string | null } {
  const trimmed = stripCovidMakerPrefix(displayName.trim());
  const drugWordMatch = /^\S+/.exec(trimmed);
  const drugWord = drugWordMatch ? drugWordMatch[0] : trimmed;

  const remainder = trimmed
    .slice(drugWord.length)
    .replace(/\bformula\b/gi, "")
    .trim();

  const seasonMatch = SEASON_TOKEN.exec(remainder);
  const season = seasonMatch ? `${seasonMatch[1]}-${seasonMatch[2].length === 4 ? seasonMatch[2].slice(2) : seasonMatch[2]}` : null;

  return { drugWord, season };
}

/**
 * ROUND 15: builds a COVID product's (Comirnaty/Spikevax/mNEXSPIKE)
 * label as "<Maker> <age> (<DrugName> <season>)" — Will's verbatim
 * example, "Pfizer 12+ (Comirnaty 2026-27)" — instead of round 7's
 * "<Maker> <DrugName> <season> (<age>)". `age` empty drops the age
 * clause ("Pfizer (Comirnaty)"); a name with no season in it drops the
 * season clause the same way ("Pfizer 12+ (Comirnaty)"). Defensive
 * `doseNumber`/`doseCount` (no COVID product is multi-dose today) add
 * a "(Dose N)" clause after the maker+age, before the parenthesized
 * drug name — "Pfizer 12+ (Dose 1) (Comirnaty 2026-27)" — matching
 * where "(Dose N)" already sits in every other product's label below.
 * Pure; not itself gated on the name being a COVID product — callers
 * (doseButtonLabel, macroProductDisplayLabel below) check
 * covidVaccineMaker first and only call this for a COVID name.
 */
export function covidMacroLabel(input: {
  displayName: string;
  age: string;
  doseNumber?: number;
  doseCount?: number;
}): string {
  const maker = covidVaccineMaker(input.displayName);
  const { drugWord, season } = splitCovidDrugNameAndSeason(input.displayName);
  const drugName = season ? `${drugWord} ${season}` : drugWord;

  const prefixParts: string[] = [];
  if (maker) prefixParts.push(maker);
  if (input.age) prefixParts.push(flattenAgeForLabel(input.age));
  if (input.doseCount && input.doseCount > 1 && input.doseNumber) prefixParts.push(`(Dose ${input.doseNumber})`);

  const prefix = prefixParts.join(" ");
  return prefix ? `${prefix} (${drugName})` : `(${drugName})`;
}

/**
 * Builds a round-7 dose button's label (Will's verbatim brief,
 * 2026-09-12): "Ages go in parenthesis... I think the dose needs to say
 * '(Dose X)' after the product name." The product's displayName, PLUS
 * " (Dose N)" when the product has more than one real dose row (e.g.
 * "Shingrix (Dose 1)"/"Shingrix (Dose 2)"), PLUS " (<age>)" (the
 * catalog age-range label — flattened per flattenAgeForLabel above) for
 * every product that has one (e.g. "Shingrix (Dose 1) (50+, 19+ IC)",
 * "Abrysvo (75+, 18+ high-risk)", "Boostrix (10+)"). A product with no
 * catalog age (age === "", e.g. an unrecognized short code) gets no age
 * suffix at all.
 *
 * ROUND 15: a COVID product (Comirnaty/Spikevax/mNEXSPIKE) instead
 * gets covidMacroLabel's "<Maker> <age> (<DrugName> <season>)" —
 * "Comirnaty 2026-2027 (12+)" is now "Pfizer 12+ (Comirnaty 2026-27)"
 * — see covidMacroLabel above for why.
 */
function doseButtonLabel(row: MacroRow, doseCount: number): string {
  if (covidVaccineMaker(row.displayName)) {
    return covidMacroLabel({ displayName: row.displayName, age: row.age, doseNumber: row.doseNumber, doseCount });
  }
  let label = vaccineDisplayName(row.displayName);
  if (doseCount > 1) label += ` (Dose ${row.doseNumber})`;
  if (row.age) label += ` (${flattenAgeForLabel(row.age)})`;
  return label;
}

/**
 * ROUND 15: the same COVID-aware composite as doseButtonLabel above,
 * for the macro-codes page's non-per-dose sites — the product-name
 * row, a dose button's `topLabel`, the ⚙ menu's aria-label, the lot/exp
 * modal heading, and the postToHost `product` field — all of which show
 * one product name (not a per-dose one), so covidMacroLabel is called
 * with no doseNumber/doseCount. Non-COVID names are untouched
 * (vaccineDisplayName is a no-op for them).
 */
export function macroProductDisplayLabel(displayName: string, age: string): string {
  return covidVaccineMaker(displayName) ? covidMacroLabel({ displayName, age }) : vaccineDisplayName(displayName);
}

/**
 * Round-8 product-level (not per-dose) label for version B's plain-text
 * "product (with age range)" column: "<name> (<age>)", e.g. "Boostrix
 * (10+)", "Shingrix (50+, 19+ IC)" — same age-flattening as
 * doseButtonLabel above, minus the "(Dose N)" clause (a product-name
 * cell names the product once, not per dose). A product with no catalog
 * age (age === "") gets no suffix, same as doseButtonLabel.
 */
export function macroProductNameWithAge(product: Pick<MacroProductGroup, "displayName" | "age">): string {
  return product.age ? `${product.displayName} (${flattenAgeForLabel(product.age)})` : product.displayName;
}

/**
 * Round-8 version B/C's short per-dose button label (Will's verbatim
 * brief: "Dose 1 button... for a single-dose product, one button — pick
 * either 'Copy' or the product's short code as its label and use that
 * choice consistently across the whole version, don't mix"). Moved here
 * from app/macro-codes/page.tsx in ROUND 10 so it's unit-testable, same
 * posture as doseButtonLabel/macroProductNameWithAge above.
 *
 * ROUND 10 (Will's verbatim feedback, 2026-09-13): "Change 'Copy' to
 * 'One dose.'" — a single-dose product's button now reads "One dose"
 * instead of round 8's "Copy"; a multi-dose product's buttons are
 * unchanged ("Dose 1"/"Dose 2"/"Dose 3").
 */
export function doseButtonShortLabel(row: MacroRow, doseCount: number): string {
  return doseCount > 1 ? `Dose ${row.doseNumber}` : "One dose";
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
        ageBase: first.ageBase,
        note: first.note,
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

/**
 * Round-8 version C's live-filter-as-you-type matching logic: narrows
 * groupSectionsByTopGroup's output down to products matching `query`.
 * Chosen over an alphabetical index (see page.tsx's version-C comment
 * for the full rationale) because a pharmacy tech usually knows the
 * product or short code they're after, so a few typed characters gets
 * there faster than scanning an A–Z rail across ~25 products.
 *
 * Matches a product if `query` (trimmed, case-insensitive) is a
 * substring of the product's display name, its section's display name
 * (either the catalog name or the round-8 override, e.g. "Tdap"
 * matches Tetanus), its round-9 special-qualification note (Will's
 * verbatim brief, 2026-09-13: "make the table... filter box should
 * also match the note text" — e.g. "high-risk" or "immunocompromised"
 * finds every product with that qualifier), or any of its real doses'
 * short codes — so typing a code ("shingrix") or a family alias
 * ("tdap") finds the product even when it isn't in the display name.
 * Matching a section's name keeps every product in that section
 * (typing "flu" shows the whole Flu section) rather than requiring
 * each product name to also contain the word.
 *
 * An empty/whitespace-only query returns `topGroups` UNCHANGED, by
 * reference — a cleared search box is a no-op, not a rebuild. A
 * section left with zero matching products, and a group left with zero
 * remaining sections, are omitted entirely (same "omit if empty"
 * posture as groupMacroRowsBySection / groupSectionsByTopGroup above).
 */
export function filterMacroTopGroups(topGroups: readonly MacroTopGroupBlock[], query: string): MacroTopGroupBlock[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return topGroups as MacroTopGroupBlock[];

  function productMatches(product: MacroProductGroup): boolean {
    if (product.displayName.toLowerCase().includes(needle)) return true;
    if ((product.note ?? "").toLowerCase().includes(needle)) return true;
    return product.doses.some((dose) => (dose.row.shortCode ?? "").toLowerCase().includes(needle));
  }

  const filteredGroups: MacroTopGroupBlock[] = [];
  for (const block of topGroups) {
    const filteredSections: MacroSectionGroup[] = [];
    for (const section of block.sections) {
      const sectionNameMatches =
        section.section.toLowerCase().includes(needle) || macroSectionDisplayName(section.section).toLowerCase().includes(needle);
      const products = sectionNameMatches ? section.products : section.products.filter(productMatches);
      if (products.length > 0) filteredSections.push({ ...section, products });
    }
    if (filteredSections.length > 0) filteredGroups.push({ ...block, sections: filteredSections });
  }
  return filteredGroups;
}

/**
 * V-macro-age-filter (Will's verbatim ask, 2026-09-25): backs the
 * desktop's new Ctrl+Numpad4 flow — it asks a patient's age, then opens
 * /macro-codes?embed=1&age=N filtered to only the vaccines that age is
 * eligible for. Same shape/posture as filterMacroTopGroups above
 * (narrows groupSectionsByTopGroup's output, omits an empty section/
 * group entirely) but matches by lib/age-range.ts's ageRangeIncludes
 * against each product's catalog `age` label instead of a text query.
 *
 * `ageYears === null` (no age filter active) returns `topGroups`
 * UNCHANGED, by reference — same "no-op on nothing to filter by" as
 * filterMacroTopGroups' empty-query case.
 *
 * A product whose age label doesn't parse at all (parseAgeRange
 * returns `[]` — "" for an unrecognized short code, or any other
 * unparseable text) is never excluded (ageRangeIncludes's own
 * documented behavior) but per Will's brief is not a CONFIRMED match
 * either, so it's sorted after every product that genuinely matched,
 * within its section — a tech filtering by age sees the vaccines known
 * to fit first, with anything unrecognized still visible but out of
 * the way at the bottom rather than mixed in at its normal age-sorted
 * position.
 */
export function filterMacroProductsByAge(topGroups: readonly MacroTopGroupBlock[], ageYears: number | null): MacroTopGroupBlock[] {
  if (ageYears === null) return topGroups as MacroTopGroupBlock[];

  const filteredGroups: MacroTopGroupBlock[] = [];
  for (const block of topGroups) {
    const filteredSections: MacroSectionGroup[] = [];
    for (const section of block.sections) {
      const matched: MacroProductGroup[] = [];
      const unknown: MacroProductGroup[] = [];
      for (const product of section.products) {
        if (parseAgeRange(product.age).length === 0) {
          unknown.push(product);
        } else if (ageRangeIncludes(product.age, ageYears)) {
          matched.push(product);
        }
      }
      const products = [...matched, ...unknown];
      if (products.length > 0) filteredSections.push({ ...section, products });
    }
    if (filteredSections.length > 0) filteredGroups.push({ ...block, sections: filteredSections });
  }
  return filteredGroups;
}

/**
 * ROUND 14 (V-T48, Will's verbatim brief, 2026-09-16): "Make C the
 * default view. Delete the other views." Replaces the round-8 A/B/C
 * switcher's persisted localStorage choice (formerly MacroViewMode/
 * MACRO_VIEW_MODES/MACRO_VIEW_MODE_STORAGE_KEY/DEFAULT_MACRO_VIEW_MODE/
 * MacroViewModeStorage/readMacroViewMode/writeMacroViewMode, all deleted
 * here) — versions A and B no longer exist for a stored preference to
 * select, so nothing persists a view choice anymore. `getMacroViewMode`
 * is a trivial pure function (same "pure logic here, page renders it"
 * split as the rest of this file) so a test can assert the only-layout
 * decision without touching React/DOM/localStorage.
 */
export type MacroViewMode = "C";

export const MACRO_VIEW_MODE: MacroViewMode = "C";

export function getMacroViewMode(): MacroViewMode {
  return MACRO_VIEW_MODE;
}
