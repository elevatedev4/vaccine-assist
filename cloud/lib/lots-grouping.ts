/**
 * Product-level grouping for the /lots page (V-T28, Will 2026-09-09
 * verbatim: "Website lots, the app still shows multiple lines for each
 * vaccine (ex: Engerix-B, Gardasil). Similar to the ordering logic, there
 * should be one row per item and the NDC should be displayed too.").
 *
 * DATA MODEL (unchanged by this file): `vaccine` rows exist per SERIES
 * DOSE, not per product — "Engerix 20 (age 20+)" has three rows (dose
 * 1/2/3) sharing one NDC, "Vaqta adult" has two rows where dose 2 carries
 * NO ndc at all. `lot` rows hang off a single vaccine_id, and the lot-list
 * apply script inserts the SAME lot on every dose row of a product, so
 * each dose today carries its own (normally identical) copy. This file
 * only computes the DISPLAY grouping — it never merges/deletes vaccine
 * rows themselves; the data-entry guided flow still needs the per-dose
 * rows untouched.
 *
 * Deliberately a sibling of, not an import from,
 * lib/ordering-ndc-collapse.ts (owned by another concurrent change to the
 * Ordering tab) — the grouping RULE is the same idea (NDC first, digits
 * only, first NDC of a comma list) but this file adds a second fallback
 * ordering doesn't need: a null-NDC dose (Vaqta dose 2) must still join
 * its sibling dose's NDC group by matching (stripped, case-insensitive)
 * name, not just fall back to a lone per-vaccine key.
 */

import { normalizeNdc } from "@/lib/ndc";

const DOSE_MARKER_PATTERNS: RegExp[] = [
  /\s*\(\s*\d+\s*of\s*\d+\s*\)\s*$/i, // "(2 of 3)"
  /\s*#\s*\d+\s*$/, // "#3"
  /\s+dose\s*\d+\s*$/i, // " dose 2"
];

/** Case-insensitive product-name key: trims, lowercases, and strips a
 * trailing dose-marker suffix if present (see DOSE_MARKER_PATTERNS). Real
 * seed data doesn't bake dose into the name (dose lives in its own
 * `dose` column — every real sibling row already shares the identical
 * name string), so this mostly normalizes case/whitespace; the
 * dose-marker stripping exists so a formulary that DOES encode dose in
 * the name doesn't silently mis-group. */
function normalizeProductNameKey(name: string): string {
  let result = name.trim().toLowerCase();
  for (const pattern of DOSE_MARKER_PATTERNS) {
    result = result.replace(pattern, "").trim();
  }
  return result;
}

/** Display name for a group: strip each member's dose marker, then use
 * the single common name if every stripped name agrees; otherwise fall
 * back to the SHORTEST stripped name (ties broken by first occurrence) —
 * same tie-break lib/ordering-ndc-collapse.ts's chooseCollapsedName uses,
 * duplicated here rather than imported (see file-header note). */
function chooseProductDisplayName(names: string[]): string {
  const stripped = names.map((name) => {
    let result = name.trim();
    for (const pattern of DOSE_MARKER_PATTERNS) {
      result = result.replace(pattern, "").trim();
    }
    return result;
  });
  const unique = Array.from(new Set(stripped));
  if (unique.length <= 1) return unique[0] ?? "";
  return unique.reduce((shortest, candidate) => (candidate.length < shortest.length ? candidate : shortest));
}

export type LotsCatalogVaccine = {
  id: string;
  name: string;
  ndc: string | null;
  active: boolean;
};

export type LotsProductGroup = {
  /** Stable grouping key: `ndc:<digits>` when any member has an NDC,
   * else `name:<normalized name>`. */
  key: string;
  /** Digits-only NDC shared by the group, or null if no member has one. */
  ndc: string | null;
  /** Display name (see chooseProductDisplayName). */
  name: string;
  /** true if ANY dose row in the group is active. */
  active: boolean;
  /** Every dose vaccine_id in this product — the fan-out target list for
   * lot add/edit/delete and the Active toggle (V-T28 DO item 2). */
  vaccineIds: string[];
};

/**
 * Groups a flat, per-dose vaccine catalog into one LotsProductGroup per
 * PRODUCT: keyed by normalized NDC (first NDC when a row holds a
 * comma-separated list — see lib/ndc.ts's normalizeNdc) when present,
 * else by normalized product name. A null-NDC dose (e.g. Vaqta adult's
 * dose 2 row) joins an existing NDC group whose members share its
 * (normalized) name rather than starting its own name-only group, so the
 * two Vaqta doses collapse to one product row despite only one of them
 * carrying an NDC.
 *
 * Two passes over `vaccines`: NDC-bearing rows first (so every possible
 * NDC group exists, and its name is known, before any null-NDC row needs
 * to look one up), then null-NDC rows. Group order in the returned array
 * therefore reflects first-NDC-appearance followed by first-name-only-
 * appearance, NOT strict catalog order — callers that want a specific
 * display order (e.g. alphabetical) should sort the result themselves.
 */
export function groupVaccinesIntoProducts(vaccines: readonly LotsCatalogVaccine[]): LotsProductGroup[] {
  const order: string[] = [];
  const groups = new Map<string, { ndc: string | null; vaccines: LotsCatalogVaccine[] }>();
  // First NDC-group key seen for a given normalized name — lets a
  // later null-NDC row with the same name join that group.
  const nameKeyToGroupKey = new Map<string, string>();

  for (const vaccine of vaccines) {
    const ndc = normalizeNdc(vaccine.ndc);
    if (!ndc) continue;
    const key = `ndc:${ndc}`;
    let group = groups.get(key);
    if (!group) {
      group = { ndc, vaccines: [] };
      groups.set(key, group);
      order.push(key);
    }
    group.vaccines.push(vaccine);
    const nameKey = normalizeProductNameKey(vaccine.name);
    if (!nameKeyToGroupKey.has(nameKey)) nameKeyToGroupKey.set(nameKey, key);
  }

  for (const vaccine of vaccines) {
    const ndc = normalizeNdc(vaccine.ndc);
    if (ndc) continue; // already placed above

    const nameKey = normalizeProductNameKey(vaccine.name);
    const key = nameKeyToGroupKey.get(nameKey) ?? `name:${nameKey}`;
    let group = groups.get(key);
    if (!group) {
      group = { ndc: null, vaccines: [] };
      groups.set(key, group);
      order.push(key);
      nameKeyToGroupKey.set(nameKey, key);
    }
    group.vaccines.push(vaccine);
  }

  return order.map((key) => {
    const group = groups.get(key) as { ndc: string | null; vaccines: LotsCatalogVaccine[] };
    return {
      key,
      ndc: group.ndc,
      name: chooseProductDisplayName(group.vaccines.map((v) => v.name)),
      active: group.vaccines.some((v) => v.active),
      vaccineIds: group.vaccines.map((v) => v.id),
    };
  });
}

/** Formats a digits-only NDC as 5-4-2 with dashes ("58160082152" ->
 * "58160-0821-52"), matching the standard NDC display segmentation used
 * across the catalog's seed data. A non-11-digit value (unusual, but the
 * column allows it) is shown as its bare digits rather than guessed at —
 * silently mis-segmenting a code would be worse than showing it plain.
 * Returns an em dash for a null/missing NDC. */
export function formatNdcDisplay(ndc: string | null): string {
  if (!ndc) return "—";
  if (/^\d{11}$/.test(ndc)) {
    return `${ndc.slice(0, 5)}-${ndc.slice(5, 9)}-${ndc.slice(9)}`;
  }
  return ndc;
}

export type LotNumberLike = { lot_number: string };

/**
 * Dedupes a product group's combined lots (gathered across every dose
 * vaccine_id) down to one entry per distinct lot_number (trimmed,
 * case-insensitive) — the lot-list apply script inserts the identical
 * lot on each dose row, so under normal operation this just collapses N
 * identical copies to 1; first-occurrence wins if values ever drift
 * (e.g. mid-edit before this change's fan-out writes existed).
 */
export function dedupeLotsByNumber<T extends LotNumberLike>(lots: readonly T[]): T[] {
  const seen = new Map<string, T>();
  for (const lot of lots) {
    const key = lot.lot_number.trim().toLowerCase();
    if (!seen.has(key)) seen.set(key, lot);
  }
  return Array.from(seen.values());
}

export type LotsPageSection<T> = { group: string; products: T[] };

export type GroupedProductLike = { group: string; active: boolean; displayName: string };

/**
 * Splits/groups a flat list of already-computed product views for the
 * /lots page's display order (V-T-ordering-lots-round4, Will: "Filter
 * inactives to the bottom of the page" — replacing the previous round's
 * per-GROUP inactive placement with ONE inactive section for the whole
 * page). Generic over any product-view-shaped T (not lib/product-view.ts's
 * ProductView directly — this file is imported BY product-view.ts, so
 * importing that type back here would be circular) with at least
 * `group`/`active`/`displayName` fields.
 *
 * Returns:
 *   - `sections`: ACTIVE-only products, bucketed by `group` and ordered
 *     per `groupOrder` (same COVID/Flu/Other display order Ordering
 *     already uses) — a group name not present in `groupOrder` is
 *     appended once at the end (defensive; shouldn't happen since
 *     lib/ordering-group.ts only ever emits COVID/Flu/Other). Products
 *     within each section are sorted alphabetically by displayName.
 *   - `inactive`: every INACTIVE product from every group, combined into
 *     one flat, alphabetically-sorted list — the page renders this as a
 *     single "Inactive" section after every active group, not one
 *     per-group inactive sub-list like the previous round.
 */
export function partitionProductsForLotsPage<T extends GroupedProductLike>(
  products: readonly T[],
  groupOrder: readonly string[]
): { sections: LotsPageSection<T>[]; inactive: T[] } {
  const activeByGroup = new Map<string, T[]>();
  const inactive: T[] = [];

  for (const product of products) {
    if (!product.active) {
      inactive.push(product);
      continue;
    }
    const list = activeByGroup.get(product.group);
    if (list) list.push(product);
    else activeByGroup.set(product.group, [product]);
  }

  const order = [...groupOrder].filter((group) => activeByGroup.has(group));
  for (const group of activeByGroup.keys()) {
    if (!order.includes(group)) order.push(group);
  }

  const byName = (a: T, b: T) => a.displayName.localeCompare(b.displayName);
  const sections = order.map((group) => ({
    group,
    products: [...(activeByGroup.get(group) ?? [])].sort(byName),
  }));

  return { sections, inactive: [...inactive].sort(byName) };
}
