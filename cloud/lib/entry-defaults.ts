import { macroBaseShortCode } from "@/lib/macro-catalog";

/**
 * Pure defaults for the /entry-values tab (V-entry-values, Will's brief
 * verbatim): "The starting point for all the vaccines we currently have
 * active should be the quantity (it's already documented in our
 * software!) and the instructions should be 'For administration by
 * healthcare provider in pharmacy.' If it is a multi-dose series, add
 * 'Dose X' at the beginning of the sig."
 *
 * ROUND 2 (Will, verbatim, two messages): "See all the directions as
 * 'For administration by pharmacy provider' or whatever I said before.
 * And the quantities are already in the software... use those." /
 * "I want you to fill them in with the defaults, including the
 * quantity." Quantity now DOES get a computed default too — a static
 * table of what's already dispensed for each product in the catalog
 * (Will typed the per-product mL amounts out directly), keyed the same
 * way lib/macro-catalog.ts keys its RAW_MACRO_CATALOG (short_code,
 * exact match tried first, then the digit-stripped base for a
 * multi-dose product's per-dose codes like "shingrix1"/"shingrix2").
 *
 * Kept dependency-free of React/fetch/Supabase, same posture as
 * lib/lots-autosave.ts and lib/macro-codes.ts, so it's directly
 * unit-testable and reusable server-side (GET /api/vaccines' own
 * `directions_default`/`quantity_default` fields, for the desktop app)
 * as well as from the /entry-values page's fill-defaults buttons.
 */

const BASE_DIRECTIONS = "For administration by healthcare provider in pharmacy.";

/**
 * Default dispensed quantity (mL), keyed by short_code base — same key
 * set as lib/macro-catalog.ts's RAW_MACRO_CATALOG. Values are Will's
 * own numbers (verbatim from his catalog, 2026-09-11): mNEXSPIKE 0.2,
 * Comirnaty 12+ 0.3, Spikevax 6mo-11 0.25, FluMist 0.2 (nasal, per
 * nostril 0.1 -> quantity 0.2 total), Engerix-B adult 20mcg/1mL -> "1",
 * Vaqta adult -> "1"; everything else in the catalog is 0.5 mL. A
 * short_code with no entry here (including an unrecognized one) has NO
 * default — never invent a number for a product Will didn't specify.
 */
export const DEFAULT_QUANTITY_BY_BASE_CODE: Readonly<Record<string, string>> = {
  comirnaty12: "0.3",
  mnexspike: "0.2",
  spikevax6mo11: "0.25",
  flucelvaxmdv: "0.5",
  flucelvaxpfs: "0.5",
  mflusiva: "0.5",
  afluriapfs: "0.5",
  fluad: "0.5",
  fluzonehd: "0.5",
  flumist: "0.2",
  arexvy: "0.5",
  abrysvo: "0.5",
  shingrix: "0.5",
  engerix: "1",
  prevnar20: "0.5",
  capvaxive: "0.5",
  boostrix: "0.5",
  gardasil: "0.5",
  menveo: "0.5",
  vaqtaadult: "1",
  typhim: "0.5",
  mmr: "0.5",
  priorix: "0.5",
};

/**
 * Resolves a real vaccine row's short_code to its default quantity, if
 * any. Same exact-then-base lookup order as
 * lib/macro-catalog.ts's lookupMacroCatalog, for the same reason: a
 * single-dose code's trailing digits can be part of the code itself
 * ("comirnaty12"), so the base-stripped fallback is only tried when the
 * exact code isn't in the table. Returns null for a missing/blank/
 * unrecognized short_code — never invents a number.
 */
export function defaultQuantity(shortCode: string | null | undefined): string | null {
  if (!shortCode || !shortCode.trim()) return null;
  const lower = shortCode.trim().toLowerCase();
  return DEFAULT_QUANTITY_BY_BASE_CODE[lower] ?? DEFAULT_QUANTITY_BY_BASE_CODE[macroBaseShortCode(lower)] ?? null;
}

export type DefaultDirectionsInput = {
  doseNumber: number;
  /** Total number of dose rows in this product's series — 1 for a
   * single-dose product, e.g. 2 for Shingrix (dose1/dose2). */
  doseCount: number;
};

/**
 * The default prescription-entry directions for one dose row. A
 * multi-dose series (doseCount > 1) gets "Dose X — " prefixed; a
 * single-dose product does not.
 */
export function defaultDirections({ doseNumber, doseCount }: DefaultDirectionsInput): string {
  return doseCount > 1 ? `Dose ${doseNumber} — ${BASE_DIRECTIONS}` : BASE_DIRECTIONS;
}

function isBlank(value: string | null | undefined): boolean {
  return !value || value.trim().length === 0;
}

export type FillDefaultsRow = {
  id: string;
  shortCode: string | null;
  quantity: string | null;
  directions: string | null;
  doseNumber: number;
  doseCount: number;
};

export type FillDefaultsPatch = { id: string; quantity?: string; directions?: string };

export type FillDefaultsOptions = {
  /** false (the "Fill blanks" button): only ever fills a blank field,
   * exactly like the original planFillBlanksDirections behaviour, now
   * extended to quantity too. true (the "Reset all directions to
   * standard" button): also overwrites a row's EXISTING directions with
   * today's computed default when it differs — quantity is never
   * overwritten by this option, only ever filled when blank, since
   * there's no "reset to standard" concept for quantity. */
  overwriteDirections: boolean;
};

/**
 * Planner for the /entry-values page's two top-of-table buttons. Pure
 * so it's directly unit-testable without a fetch mock: given the
 * current rows, returns the list of {id, quantity?, directions?}
 * PATCHes to send, one per row that needs a change, id order preserved.
 *
 * - quantity: patched when blank AND defaultQuantity(shortCode) has an
 *   entry. Never overwrites an existing quantity (there's no "reset
 *   quantity" concept — Will's brief: quantity comes from what's
 *   already in the software, so a value on file is always trusted over
 *   the static table).
 * - directions: patched when blank, OR — only when
 *   options.overwriteDirections is true — when the current value is
 *   non-blank but differs from today's computed default (the "Reset all
 *   directions to standard" button).
 *
 * A row that needs neither field patched is omitted entirely.
 */
export function planFillDefaults(
  rows: readonly FillDefaultsRow[],
  options: FillDefaultsOptions
): FillDefaultsPatch[] {
  const patches: FillDefaultsPatch[] = [];

  for (const row of rows) {
    const patch: FillDefaultsPatch = { id: row.id };

    if (isBlank(row.quantity)) {
      const qDefault = defaultQuantity(row.shortCode);
      if (qDefault) patch.quantity = qDefault;
    }

    const dDefault = defaultDirections({ doseNumber: row.doseNumber, doseCount: row.doseCount });
    if (isBlank(row.directions)) {
      patch.directions = dDefault;
    } else if (options.overwriteDirections && row.directions !== dDefault) {
      patch.directions = dDefault;
    }

    if (patch.quantity !== undefined || patch.directions !== undefined) patches.push(patch);
  }

  return patches;
}
