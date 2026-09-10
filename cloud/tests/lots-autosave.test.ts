import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDebouncedRunner, decideDateAutosave, decideLotNumberAutosave } from "@/lib/lots-autosave";

describe("decideDateAutosave", () => {
  it("saves a valid, complete, changed date", () => {
    expect(decideDateAutosave("09/16/2026", "")).toBe("save");
    expect(decideDateAutosave("09/16/2026", "08/01/2026")).toBe("save");
  });

  it("never saves a partial date still being typed", () => {
    expect(decideDateAutosave("09/16", "")).toBe("incomplete");
    expect(decideDateAutosave("09", "")).toBe("incomplete");
    expect(decideDateAutosave("", "09/16/2026")).toBe("incomplete");
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

  it("never saves when the field is cleared to empty", () => {
    expect(decideLotNumberAutosave("", "ABC123")).toBe("empty");
    expect(decideLotNumberAutosave("   ", "ABC123")).toBe("empty");
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
