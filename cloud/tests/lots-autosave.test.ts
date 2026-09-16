import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDebouncedRunner, decideDateAutosave, decideLotNumberAutosave, rowStatusLabel } from "@/lib/lots-autosave";

describe("decideDateAutosave", () => {
  it("saves a valid, complete, changed date", () => {
    expect(decideDateAutosave("09/16/2026", "")).toBe("save");
    expect(decideDateAutosave("09/16/2026", "08/01/2026")).toBe("save");
  });

  it("never saves a partial date still being typed", () => {
    expect(decideDateAutosave("09/16", "")).toBe("incomplete");
    expect(decideDateAutosave("09", "")).toBe("incomplete");
  });

  // V-lots-clear-save (Will 2026-09-16 verbatim: "if I remove something
  // (lot or exp), it needs to be saved when I remove it ... right now
  // it's flagging that it's missing, but if I refresh with the lot/exp
  // blank, it's reloading the old lot"): fully emptying a field that
  // PREVIOUSLY held a saved value is a distinct, actionable "clear" —
  // not lumped in with "incomplete" (still typing) anymore.
  it("reports 'clear' when a previously-saved date is fully emptied", () => {
    expect(decideDateAutosave("", "09/16/2026")).toBe("clear");
  });

  it("reports 'incomplete', not 'clear', while partway through retyping over a previously-saved date", () => {
    expect(decideDateAutosave("09", "09/16/2026")).toBe("incomplete");
  });

  it("never saves an 8-digit date that isn't a real calendar date", () => {
    expect(decideDateAutosave("02/30/2026", "")).toBe("invalid");
    expect(decideDateAutosave("13/01/2026", "")).toBe("invalid");
  });

  it("is unchanged when the text matches what was last saved (debounce refiring with no real edit)", () => {
    expect(decideDateAutosave("09/16/2026", "09/16/2026")).toBe("unchanged");
    expect(decideDateAutosave("", "")).toBe("unchanged");
  });
});

describe("decideLotNumberAutosave", () => {
  it("saves a non-empty, changed lot number", () => {
    expect(decideLotNumberAutosave("ABC123", "")).toBe("save");
    expect(decideLotNumberAutosave("ABC123", "XYZ789")).toBe("save");
  });

  // V-lots-clear-save (Will 2026-09-16): renamed from "empty" — clearing
  // a previously-saved lot number back to blank IS now something
  // runAutosave persists (as a fan-out DELETE of the row's current lot,
  // since lot_number is a NOT NULL column — see runAutosave's own doc
  // comment in app/lots/page.tsx), not a no-op.
  it("reports 'clear' when a previously-saved lot number is emptied", () => {
    expect(decideLotNumberAutosave("", "ABC123")).toBe("clear");
    expect(decideLotNumberAutosave("   ", "ABC123")).toBe("clear");
  });

  it("is unchanged when the text matches what was last saved", () => {
    expect(decideLotNumberAutosave("ABC123", "ABC123")).toBe("unchanged");
    expect(decideLotNumberAutosave("", "")).toBe("unchanged");
  });
});

// --- V-T-ordering-lots-round4 review follow-up (reviewer, 2026-09-10):
// the /lots page's first autosave wiring closed over drafts/lastSaved/
// rawDateText/budEnabledKeys AT SCHEDULE TIME (one React render behind
// the keystroke that called schedule()), so only the timer from the
// LAST keystroke ever survived to fire, and even it read a snapshot
// missing that final keystroke — "LOT2026A" + a pause autosaved
// "LOT2026". createDebouncedRunner fixes this by construction: it owns
// only the timer, and calls `run` fresh at FIRE time with no snapshot of
// its own — these tests lock down that "reads latest at fire time, not
// at schedule time" contract using a plain mutable variable standing in
// for a React ref. ---
describe("createDebouncedRunner", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("run() sees the value as of FIRE time, not as of when schedule() was called (the review bug)", () => {
    // Stands in for a React ref (`draftsRef.current`, say): `run` reads
    // whatever `latest` holds AT CALL TIME, exactly the pattern the page
    // now uses instead of closing over component state directly.
    let latest = "LOT2026";
    const calls: string[] = [];
    const runner = createDebouncedRunner(() => calls.push(latest), 600);

    runner.schedule();
    // A further keystroke arrives before the debounce settles — in the
    // buggy version, this is exactly the keystroke that got dropped.
    latest = "LOT2026A";
    runner.schedule();

    vi.advanceTimersByTime(600);

    expect(calls).toEqual(["LOT2026A"]);
  });

  it("re-scheduling before the delay elapses cancels the previous timer — only the last schedule() fires", () => {
    const run = vi.fn();
    const runner = createDebouncedRunner(run, 600);

    runner.schedule();
    vi.advanceTimersByTime(400);
    runner.schedule(); // resets the countdown — the first timer must never fire
    vi.advanceTimersByTime(400);
    expect(run).not.toHaveBeenCalled();

    vi.advanceTimersByTime(200); // 400 + 200 = 600ms since the SECOND schedule()
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("cancel() prevents a scheduled run from ever firing", () => {
    const run = vi.fn();
    const runner = createDebouncedRunner(run, 600);

    runner.schedule();
    runner.cancel();
    vi.advanceTimersByTime(10_000);

    expect(run).not.toHaveBeenCalled();
  });

  it("flushNow() runs immediately and cancels the pending timer (no double-fire later)", () => {
    const run = vi.fn();
    const runner = createDebouncedRunner(run, 600);

    runner.schedule();
    runner.flushNow();
    expect(run).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("flushNow() with no pending timer still runs once", () => {
    const run = vi.fn();
    const runner = createDebouncedRunner(run, 600);

    runner.flushNow();

    expect(run).toHaveBeenCalledTimes(1);
  });
});

// --- V-lots-status-column (Will 2026-09-14 verbatim: "when updating, it
// shows 'saving' and messes up the formatting of the whole table... make
// it append to the end of the row"): rowStatusLabel is the pure decision
// behind the /lots page's dedicated, fixed-width trailing status column —
// these tests lock down which single status wins when more than one flag
// is true at once. ---
describe("rowStatusLabel", () => {
  it("returns null when the row has nothing to report", () => {
    expect(rowStatusLabel({ saving: false, justSaved: false, error: null })).toBeNull();
    expect(rowStatusLabel({ saving: false, justSaved: false, error: "" })).toBeNull();
    expect(rowStatusLabel({ saving: false, justSaved: false })).toBeNull();
  });

  it("shows Saving… while a request is in flight", () => {
    expect(rowStatusLabel({ saving: true, justSaved: false, error: null })).toEqual({
      kind: "saving",
      text: "Saving…",
    });
  });

  it("shows the error message once the request fails", () => {
    expect(rowStatusLabel({ saving: false, justSaved: false, error: "Network error" })).toEqual({
      kind: "error",
      text: "Network error",
    });
  });

  it("shows the Saved ✓ flash once neither saving nor error apply", () => {
    expect(rowStatusLabel({ saving: false, justSaved: true, error: null })).toEqual({
      kind: "saved",
      text: "Saved ✓",
    });
  });

  it("prioritizes saving over a lingering Saved ✓ flash from a prior save", () => {
    // e.g. a new edit's autosave starts before the previous save's ~1.5s
    // flash has finished fading out.
    expect(rowStatusLabel({ saving: true, justSaved: true, error: null })).toEqual({
      kind: "saving",
      text: "Saving…",
    });
  });

  it("prioritizes a live error over a lingering Saved ✓ flash", () => {
    expect(rowStatusLabel({ saving: false, justSaved: true, error: "Failed to save lot." })).toEqual({
      kind: "error",
      text: "Failed to save lot.",
    });
  });
});

// --- V-lots-row-status (Will 2026-09-14 verbatim: "If a lot is missing,
// highlight the row in yellow. If it's expired, highlight it in red. And
// add a note at the end of the row that shows that status."): the full
// precedence chain once lib/lots-row-status.ts's static rowStatus/
// expiredOnDisplay are folded in alongside the existing transient
// saving/error/justSaved flags — saving > error > justSaved > expired >
// missing > nothing. ---
describe("rowStatusLabel with a static row status (missing/expired)", () => {
  it("shows 'Expired MM/DD/YYYY' when the row status is expired and nothing transient is happening", () => {
    expect(
      rowStatusLabel({ saving: false, justSaved: false, error: null, rowStatus: "expired", expiredOnDisplay: "06/30/2025" })
    ).toEqual({ kind: "expired", text: "Expired 06/30/2025" });
  });

  it("shows 'No lot' when the row status is missing and nothing transient is happening", () => {
    expect(rowStatusLabel({ saving: false, justSaved: false, error: null, rowStatus: "missing" })).toEqual({
      kind: "missing",
      text: "No lot",
    });
  });

  it("shows nothing when the row status is ok and nothing transient is happening", () => {
    expect(rowStatusLabel({ saving: false, justSaved: false, error: null, rowStatus: "ok" })).toBeNull();
  });

  it("prioritizes Saving… over an expired row status", () => {
    expect(
      rowStatusLabel({ saving: true, justSaved: false, error: null, rowStatus: "expired", expiredOnDisplay: "06/30/2025" })
    ).toEqual({ kind: "saving", text: "Saving…" });
  });

  it("prioritizes Saving… over a missing row status", () => {
    expect(rowStatusLabel({ saving: true, justSaved: false, error: null, rowStatus: "missing" })).toEqual({
      kind: "saving",
      text: "Saving…",
    });
  });

  it("prioritizes a live error over an expired row status", () => {
    expect(
      rowStatusLabel({
        saving: false,
        justSaved: false,
        error: "Failed to save lot.",
        rowStatus: "expired",
        expiredOnDisplay: "06/30/2025",
      })
    ).toEqual({ kind: "error", text: "Failed to save lot." });
  });

  it("prioritizes a live error over a missing row status", () => {
    expect(
      rowStatusLabel({ saving: false, justSaved: false, error: "Failed to save lot.", rowStatus: "missing" })
    ).toEqual({ kind: "error", text: "Failed to save lot." });
  });

  it("prioritizes a just-saved flash over an expired row status", () => {
    expect(
      rowStatusLabel({ saving: false, justSaved: true, error: null, rowStatus: "expired", expiredOnDisplay: "06/30/2025" })
    ).toEqual({ kind: "saved", text: "Saved ✓" });
  });

  it("prioritizes a just-saved flash over a missing row status", () => {
    expect(rowStatusLabel({ saving: false, justSaved: true, error: null, rowStatus: "missing" })).toEqual({
      kind: "saved",
      text: "Saved ✓",
    });
  });

  it("prioritizes expired over missing (defensive — lotRowStatus never actually returns both)", () => {
    expect(
      rowStatusLabel({ saving: false, justSaved: false, error: null, rowStatus: "expired", expiredOnDisplay: "06/30/2025" })
    ).toEqual({ kind: "expired", text: "Expired 06/30/2025" });
  });

  it("falls back to a bare 'Expired' when no display date is given", () => {
    expect(rowStatusLabel({ saving: false, justSaved: false, error: null, rowStatus: "expired" })).toEqual({
      kind: "expired",
      text: "Expired",
    });
  });
});

// --- V-lots-row-status extended (Will 2026-09-14 verbatim: "Also needs
// to show if exp is missing too"): rowStatusLabel's precedence with the
// new 'missing-expiration' rowStatus folded in — saving > error >
// justSaved > expired > missing > missing-expiration > nothing. ---
describe("rowStatusLabel with a missing-expiration row status", () => {
  it("shows 'No expiration' when the row status is missing-expiration and nothing transient is happening", () => {
    expect(rowStatusLabel({ saving: false, justSaved: false, error: null, rowStatus: "missing-expiration" })).toEqual(
      { kind: "missing-expiration", text: "No expiration" }
    );
  });

  it("prioritizes Saving… over a missing-expiration row status", () => {
    expect(rowStatusLabel({ saving: true, justSaved: false, error: null, rowStatus: "missing-expiration" })).toEqual({
      kind: "saving",
      text: "Saving…",
    });
  });

  it("prioritizes a live error over a missing-expiration row status", () => {
    expect(
      rowStatusLabel({ saving: false, justSaved: false, error: "Failed to save lot.", rowStatus: "missing-expiration" })
    ).toEqual({ kind: "error", text: "Failed to save lot." });
  });

  it("prioritizes a just-saved flash over a missing-expiration row status", () => {
    expect(rowStatusLabel({ saving: false, justSaved: true, error: null, rowStatus: "missing-expiration" })).toEqual({
      kind: "saved",
      text: "Saved ✓",
    });
  });

  it("prioritizes expired over missing-expiration (defensive — lotRowStatus never actually returns both)", () => {
    expect(
      rowStatusLabel({
        saving: false,
        justSaved: false,
        error: null,
        rowStatus: "expired",
        expiredOnDisplay: "06/30/2025",
      })
    ).toEqual({ kind: "expired", text: "Expired 06/30/2025" });
  });

  it("prioritizes missing (no lot) over missing-expiration (defensive — lotRowStatus never actually returns both)", () => {
    expect(rowStatusLabel({ saving: false, justSaved: false, error: null, rowStatus: "missing" })).toEqual({
      kind: "missing",
      text: "No lot",
    });
  });
});
