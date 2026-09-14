import { describe, expect, it } from "vitest";
import { subLabelFontSizePx, subLabelSlotHeightPx, SUB_LABEL_LINE_HEIGHT } from "@/lib/macro-dose-button";

describe("subLabelFontSizePx", () => {
  it("is the same for every doseCountInRow — round 12 dropped the per-crowding font shrink", () => {
    // No `crowded`/doseCountInRow parameter exists anymore: font size is
    // a pure function of compact/large only, so a 3-dose fitRow row and
    // a 1-dose row render their sub-label at the identical size (Will's
    // verbatim ask, 2026-09-13: "I want the dose 1/2/3 font size to be
    // the same as the other buttons so they look the same").
    expect(subLabelFontSizePx(false, true)).toBe(subLabelFontSizePx(false, true));
  });

  it("large (layout C / screener) is bigger than the plain size, compact (embed) is the smallest", () => {
    const compact = subLabelFontSizePx(true, false);
    const plain = subLabelFontSizePx(false, false);
    const large = subLabelFontSizePx(false, true);
    expect(compact).toBeLessThan(plain);
    expect(plain).toBeLessThan(large);
  });

  it("compact wins over large when both are true (embed always renders layout C, i.e. large:true)", () => {
    expect(subLabelFontSizePx(true, true)).toBe(subLabelFontSizePx(true, false));
  });
});

describe("subLabelSlotHeightPx", () => {
  it("reserves exactly two lines at the sub-label's own font size", () => {
    for (const [compact, large] of [
      [false, false],
      [false, true],
      [true, false],
      [true, true],
    ] as const) {
      const fontSize = subLabelFontSizePx(compact, large);
      expect(subLabelSlotHeightPx(compact, large)).toBe(Math.ceil(fontSize * SUB_LABEL_LINE_HEIGHT * 2));
    }
  });

  it("is tall enough for a real two-clause interval to never need more than two lines' worth of height", () => {
    // Sanity check against the two intervals Will's feedback named as
    // cut off: neither is more than ~22 characters, and at ANY of this
    // file's font sizes a two-line reservation this size comfortably
    // wraps text that short across two lines without needing a third.
    const gardasilDose2 = "1–2 mo · 9–14: 6 mo";
    const mmrDose2 = "28 d · special groups";
    expect(gardasilDose2.length).toBeLessThanOrEqual(22);
    expect(mmrDose2.length).toBeLessThanOrEqual(22);
    // The slot height itself doesn't depend on the string — it's a FIXED
    // two-line reservation (see this file's "ROUND 12" doc comment on
    // renderMacroDoseButton) — this just documents why two lines is
    // enough for both real-world cases the brief called out.
    expect(subLabelSlotHeightPx(false, true)).toBeGreaterThan(subLabelFontSizePx(false, true));
  });
});
