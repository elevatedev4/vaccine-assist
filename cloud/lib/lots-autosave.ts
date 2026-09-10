import { digitsToIso, onlyDigits } from "@/lib/date-mask";

/**
 * Pure "should this field autosave right now" decisions for the /lots
 * page (V-T-ordering-lots-round4, Will 2026-09-09/10 verbatim: "Remove
 * save button... make it autosave anytime new typing occurs, with date
 * validation happening on the date fields prior to saving, of course.").
 * Kept dependency-free of React/fetch so it's directly unit-testable —
 * same posture as lib/lots-table.ts and lib/date-mask.ts. The page wires
 * these into a per-row debounce (~600ms after the last keystroke, also
 * flushed on blur) and only fires the actual save request (reusing the
 * existing POST/PATCH /api/lots calls) when one of these returns "save".
 */

export type DateAutosaveDecision = "save" | "incomplete" | "invalid" | "unchanged";

/**
 * Whether a date field (Expiration / Beyond-use date) should autosave.
 * `text` is the field's current raw MM/DD/YYYY-in-progress display text
 * (DateTextInput's own masked text, NOT the ISO value — see that
 * component's onRawTextChange); `previousSavedText` is the masked text of
 * the value last confirmed saved (or loaded).
 *
 *   - "unchanged": text === previousSavedText — nothing to do, even if a
 *     debounce timer happens to fire again.
 *   - "incomplete": fewer than 8 digits typed so far — the user is still
 *     typing; never sent, never flagged invalid.
 *   - "invalid": exactly 8 digits typed but they don't form a real
 *     calendar date (e.g. "02/30/2026") — never sent. DateTextInput
 *     already shows its own subtle red-border style for this case.
 *   - "save": a complete, valid calendar date that differs from what was
 *     last saved.
 */
export function decideDateAutosave(text: string, previousSavedText: string): DateAutosaveDecision {
  if (text === previousSavedText) return "unchanged";
  const digits = onlyDigits(text);
  if (digits.length < 8) return "incomplete";
  return digitsToIso(digits) ? "save" : "invalid";
}

export type LotNumberAutosaveDecision = "save" | "empty" | "unchanged";

/**
 * Whether the Lot # field should autosave — "Lot # saves when non-empty
 * change settles" (Will's brief): non-empty (trimmed) AND different from
 * what was last saved. Clearing the field to empty is never itself an
 * autosave trigger (deleting a lot on file is the separate, explicit
 * "Clear lot" action in the ⚙ menu).
 */
export function decideLotNumberAutosave(text: string, previousSavedText: string): LotNumberAutosaveDecision {
  if (text === previousSavedText) return "unchanged";
  return text.trim().length > 0 ? "save" : "empty";
}
