/**
 * Pure defaults for the /entry-values tab (V-entry-values, Will's brief
 * verbatim): "The starting point for all the vaccines we currently have
 * active should be the quantity (it's already documented in our
 * software!) and the instructions should be 'For administration by
 * healthcare provider in pharmacy.' If it is a multi-dose series, add
 * 'Dose X' at the beginning of the sig."
 *
 * Quantity has NO computed default here on purpose — it should never be
 * invented, only ever what's already on file in `vaccine.quantity` (see
 * GET /api/vaccines) — so this file only covers `directions`.
 *
 * Kept dependency-free of React/fetch/Supabase, same posture as
 * lib/lots-autosave.ts and lib/macro-codes.ts, so it's directly
 * unit-testable and reusable server-side (GET /api/vaccines' own
 * `directions_default` field, for the desktop app) as well as from the
 * /entry-values page's "Fill blanks with defaults" button.
 */

const BASE_DIRECTIONS = "For administration by healthcare provider in pharmacy.";

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

export type FillBlanksRow = {
  id: string;
  directions: string | null;
  doseNumber: number;
  doseCount: number;
};

export type FillBlanksPatch = { id: string; directions: string };

/**
 * "Fill blanks with defaults" planner for the /entry-values page's
 * top-of-table button. Pure so it's directly unit-testable without a
 * fetch mock: given the current rows, returns the list of
 * {id, directions} PATCHes to send — one per row whose directions is
 * null/blank (whitespace-only counts as blank). NEVER returns a patch
 * for a row whose directions already holds any non-blank value, even if
 * that value wouldn't match today's computed default — e.g. Comirnaty's
 * own on-file text ("inject 0.2ml into the muscle once.") must be left
 * alone.
 */
export function planFillBlanksDirections(rows: readonly FillBlanksRow[]): FillBlanksPatch[] {
  return rows
    .filter((row) => !row.directions || row.directions.trim().length === 0)
    .map((row) => ({
      id: row.id,
      directions: defaultDirections({ doseNumber: row.doseNumber, doseCount: row.doseCount }),
    }));
}
