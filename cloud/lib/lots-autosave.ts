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

export type DebouncedRunner = {
  /** (Re-)arms the debounce: cancels any pending timer for this runner
   * and starts a fresh delayMs countdown. */
  schedule: () => void;
  /** Cancels any pending timer and calls `run()` immediately. */
  flushNow: () => void;
  /** Cancels any pending timer without calling `run()`. */
  cancel: () => void;
};

/**
 * Generic debounce timer scheduler (V-T-ordering-lots-round4 review
 * follow-up, reviewer 2026-09-10): /lots' first autosave wiring called a
 * `runAutosave(view)` closure that read `drafts`/`lastSaved`/
 * `rawDateText`/`budEnabledKeys` straight from component state at the
 * moment the timer's callback was DEFINED (i.e. at schedule() time, one
 * render behind the keystroke that just called schedule() — React state
 * updates from that same keystroke hadn't committed yet). Because every
 * later keystroke cancels the previous timer and reschedules from its
 * OWN still-one-render-behind closure, only the LAST-scheduled timer ever
 * survives to fire, and even it reads a snapshot missing the keystroke
 * that scheduled it — e.g. typing "LOT2026A" then pausing would autosave
 * "LOT2026", silently dropping the final character.
 *
 * This helper fixes that by construction: it owns ONLY the timer
 * bookkeeping (delay, cancel-and-reschedule, flush-now) and calls the
 * caller-supplied `run` callback with no snapshot of its own — `run` is
 * invoked fresh at FIRE time (whenever that turns out to be), so as long
 * as `run` itself reads the latest state at CALL time (e.g. from a ref
 * that's kept in sync on every change, not from a value captured in an
 * outer closure), the value it sees is always current. Kept
 * dependency-free of React so the timing contract itself — "the callback
 * sees state as of when it actually fires, not as of when it was
 * scheduled" — is directly unit-testable without a DOM/React harness.
 */
export type RowSaveState = {
  /** True while an autosave (or Clear lot) request is in flight for this
   * row. */
  saving: boolean;
  /** True for the short window right after a successful save during which
   * the row should flash "Saved ✓" — the fade-out timing itself is owned
   * by the caller (see /lots page's savedFlashByKey/flashSaved), this
   * function only cares whether that window is currently open. */
  justSaved: boolean;
  /** The row's current error message, if any ("" / null / undefined all
   * mean "no error"). */
  error?: string | null;
};

export type RowStatus = {
  kind: "saving" | "saved" | "error";
  text: string;
};

/**
 * Pure "what should this row's dedicated status column show right now"
 * decision (Will 2026-09-14 verbatim: "when updating, it shows 'saving'
 * and messes up the formatting of the whole table... make it append to
 * the end of the row"). The /lots page renders exactly one of these at a
 * time in a fixed-width trailing column instead of inline next to the ⚙
 * menu, so nothing else in the row ever shifts.
 *
 * Priority is saving > error > justSaved: a request that's actively in
 * flight always wins (e.g. a new edit started while a previous "Saved ✓"
 * flash was still fading), a live error always wins over a stale flash,
 * and only once neither applies does the flash show. Returns null when
 * the row has nothing to report.
 */
export function rowStatusLabel(state: RowSaveState): RowStatus | null {
  if (state.saving) return { kind: "saving", text: "Saving…" };
  if (state.error) return { kind: "error", text: state.error };
  if (state.justSaved) return { kind: "saved", text: "Saved ✓" };
  return null;
}

export function createDebouncedRunner(run: () => void, delayMs: number): DebouncedRunner {
  let timer: ReturnType<typeof setTimeout> | null = null;

  function cancel() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function schedule() {
    cancel();
    timer = setTimeout(() => {
      timer = null;
      run();
    }, delayMs);
  }

  function flushNow() {
    cancel();
    run();
  }

  return { schedule, flushNow, cancel };
}
