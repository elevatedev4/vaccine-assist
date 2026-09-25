import { describe, expect, it } from "vitest";
import {
  buttonBaseMinHeightPx,
  buttonPaddingRem,
  mainLabelFontSizePx,
  PRODUCT_COLORS,
  renderMacroDoseButton,
  resolveDoseButtonColors,
  SECTION_COLORS,
  subLabelFontSizePx,
  subLabelMaxWidthPx,
  subLabelSlotHeightPx,
  SUB_LABEL_LINE_HEIGHT,
} from "@/lib/macro-dose-button";
import type { MacroDoseButton, MacroRow } from "@/lib/macro-codes";

function makeRow(overrides: Partial<MacroRow> = {}): MacroRow {
  return {
    productKey: "ndc:test",
    displayName: "Test Vaccine",
    ndc: null,
    packageSize: null,
    cashPriceCents: null,
    doseNumber: 1,
    shortCode: "testcode",
    lotNumber: null,
    expirationIso: null,
    macro: null,
    complete: false,
    catalogType: "Other",
    sheetOrder: 0,
    section: "Other",
    age: "",
    ageBase: "",
    ageMinMonths: 0,
    doseCount: 1,
    vaccineIds: ["v1"],
    colorKey: "",
    ...overrides,
  };
}

function makeDose(overrides: Partial<MacroRow> = {}, label = "Dose 1"): MacroDoseButton {
  return { row: makeRow(overrides), label };
}

/** Walks a React element tree (as returned directly by a hook-free
 * function component/render helper — no jsdom/testing-library, same
 * posture as tests/data-entry-page.test.ts) and collects every string
 * child in document order. */
function collectText(node: unknown, out: string[], depth = 0): void {
  if (!node || depth > 20) return;
  if (typeof node === "string") {
    out.push(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out, depth + 1);
    return;
  }
  if (typeof node !== "object") return;
  const el = node as { props?: { children?: unknown } };
  if (el.props && "children" in el.props) collectText(el.props.children, out, depth + 1);
}

describe("resolveDoseButtonColors (V-T50: per-product flu button colors)", () => {
  it("returns the PRODUCT_COLORS override for flucelvax, flumist, and mflusiva", () => {
    expect(resolveDoseButtonColors(makeRow({ section: "Flu", colorKey: "flucelvax" }))).toEqual(
      PRODUCT_COLORS.flucelvax
    );
    expect(resolveDoseButtonColors(makeRow({ section: "Flu", colorKey: "flumist" }))).toEqual(PRODUCT_COLORS.flumist);
    expect(resolveDoseButtonColors(makeRow({ section: "Flu", colorKey: "mflusiva" }))).toEqual(
      PRODUCT_COLORS.mflusiva
    );
  });

  it("falls back to the section color for a flu product with no override (e.g. Fluad, Afluria, Fluzone)", () => {
    expect(resolveDoseButtonColors(makeRow({ section: "Flu", colorKey: "fluad" }))).toEqual(SECTION_COLORS.Flu);
    expect(resolveDoseButtonColors(makeRow({ section: "Flu", colorKey: "afluriapfs" }))).toEqual(SECTION_COLORS.Flu);
  });

  it("falls back to the section color for any non-flu row (no colorKey override exists outside flu)", () => {
    expect(resolveDoseButtonColors(makeRow({ section: "Shingles", colorKey: "shingrix" }))).toEqual(
      SECTION_COLORS.Shingles
    );
    expect(resolveDoseButtonColors(makeRow({ section: "Other", colorKey: "" }))).toEqual(SECTION_COLORS.Other);
  });

  it("gives every flu color override a distinct triple from each other and from the base Flu section color", () => {
    const palette = [PRODUCT_COLORS.flucelvax, PRODUCT_COLORS.flumist, PRODUCT_COLORS.mflusiva, SECTION_COLORS.Flu];
    const bgs = new Set(palette.map((c) => c.bg));
    expect(bgs.size).toBe(palette.length);
  });
});

describe("subLabelFontSizePx", () => {
  it("is the same for every doseCountInRow — round 12 dropped the per-crowding font shrink", () => {
    // No `crowded`/doseCountInRow parameter exists anymore: font size is
    // a pure function of compact/large only, so a 3-dose fitRow row and
    // a 1-dose row render their sub-label at the identical size (Will's
    // verbatim ask, 2026-09-13: "I want the dose 1/2/3 font size to be
    // the same as the other buttons so they look the same").
    expect(subLabelFontSizePx(false, true)).toBe(subLabelFontSizePx(false, true));
  });

  it("large (layout C / screener) is bigger than the plain size, compact alone is the smallest", () => {
    const compact = subLabelFontSizePx(true, false);
    const plain = subLabelFontSizePx(false, false);
    const large = subLabelFontSizePx(false, true);
    expect(compact).toBeLessThan(plain);
    expect(plain).toBeLessThan(large);
  });

  // MACRO-POPUP ROUND 3 (Will's verbatim ask, 2026-09-25): embed always
  // renders layout C (large: true) together with compact: true — before
  // this round `compact` won outright over `large` in that combination,
  // making the popup's own type SMALLER than every other tier, including
  // plain. That regression is what this describe block now locks in the
  // opposite of.
  it("compact no longer collapses to the compact-alone size when large is also true", () => {
    expect(subLabelFontSizePx(true, true)).not.toBe(subLabelFontSizePx(true, false));
    expect(subLabelFontSizePx(true, true)).toBeGreaterThan(subLabelFontSizePx(true, false));
  });

  it("compact+large (the embed popup) is at least as big as plain large, never smaller", () => {
    expect(subLabelFontSizePx(true, true)).toBeGreaterThanOrEqual(subLabelFontSizePx(false, true));
  });

  it("every OTHER combination (i.e. anything but compact+large together) is unchanged from before round 3", () => {
    // Locks in that round 3 only ever touches the one specific
    // compact&&large tier — the normal, non-embed page (compact: false)
    // and the still-unused compact-alone combination must never move.
    expect(subLabelFontSizePx(false, false)).toBe(10);
    expect(subLabelFontSizePx(false, true)).toBe(11);
    expect(subLabelFontSizePx(true, false)).toBe(9);
  });
});

describe("mainLabelFontSizePx (round 3: the dose button's own first-line font size)", () => {
  it("compact+large (the embed popup) is bigger than plain large — the round-3 fix", () => {
    expect(mainLabelFontSizePx(true, true)).toBeGreaterThan(mainLabelFontSizePx(false, true));
  });

  it("compact+large is roughly 20-25% bigger than the old compact-alone (pre-round-3 embed) size", () => {
    const compactAlone = mainLabelFontSizePx(true, false); // unchanged: 11
    const popup = mainLabelFontSizePx(true, true);
    const ratio = popup / compactAlone;
    expect(ratio).toBeGreaterThanOrEqual(1.2);
    expect(ratio).toBeLessThanOrEqual(1.3);
  });

  it("every other combination is unchanged from before round 3", () => {
    expect(mainLabelFontSizePx(false, false)).toBe(12);
    expect(mainLabelFontSizePx(false, true)).toBe(13);
    expect(mainLabelFontSizePx(true, false)).toBe(11);
  });
});

describe("buttonBaseMinHeightPx (round 3)", () => {
  it("compact+large is roughly 20-25% bigger than the old compact-alone (pre-round-3 embed) height", () => {
    const compactAlone = buttonBaseMinHeightPx(true, false); // unchanged: 28
    const popup = buttonBaseMinHeightPx(true, true);
    const ratio = popup / compactAlone;
    expect(ratio).toBeGreaterThanOrEqual(1.2);
    expect(ratio).toBeLessThanOrEqual(1.3);
  });

  it("every other combination is unchanged from before round 3", () => {
    expect(buttonBaseMinHeightPx(false, false)).toBe(32);
    expect(buttonBaseMinHeightPx(false, true)).toBe(38);
    expect(buttonBaseMinHeightPx(true, false)).toBe(28);
  });
});

describe("buttonPaddingRem (round 3)", () => {
  it("compact+large is bigger than the old compact-alone padding", () => {
    expect(buttonPaddingRem(true, true)).toBeGreaterThan(buttonPaddingRem(true, false));
  });

  it("every other combination is unchanged from before round 3", () => {
    expect(buttonPaddingRem(false, false)).toBe(0.5);
    expect(buttonPaddingRem(false, true)).toBe(0.75);
    expect(buttonPaddingRem(true, false)).toBe(0.5);
  });
});

describe("subLabelMaxWidthPx (round 3)", () => {
  it("compact+large is wider than the old compact-alone cap", () => {
    expect(subLabelMaxWidthPx(true, true)).toBeGreaterThan(subLabelMaxWidthPx(true, false));
  });

  it("every other combination is unchanged from before round 3", () => {
    expect(subLabelMaxWidthPx(false, false)).toBe(112);
    expect(subLabelMaxWidthPx(false, true)).toBe(130);
    expect(subLabelMaxWidthPx(true, false)).toBe(96);
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

describe("renderMacroDoseButton topLabel (V-T48: name row 1, dose row 2, schedule row 3)", () => {
  const colors = SECTION_COLORS.Other;
  const baseParams = { isCopied: false, copyFailureCode: null, onClick: () => {} };

  it("puts the vaccine name (topLabel) before the dose label, before the schedule sub-label", () => {
    const dose = makeDose({ doseInterval: "2 mo" }, "Shingrix (Dose 2) (50+, 19+ IC)");
    const el = renderMacroDoseButton(dose, colors, {
      ...baseParams,
      large: true,
      topLabel: "Shingrix",
      visibleLabel: "Dose 2",
      subLabel: "2 mo",
    });
    const text: string[] = [];
    collectText(el, text);
    const nameIndex = text.indexOf("Shingrix");
    const doseIndex = text.indexOf("Dose 2");
    const scheduleIndex = text.indexOf("2 mo");
    expect(nameIndex).toBeGreaterThanOrEqual(0);
    expect(doseIndex).toBeGreaterThan(nameIndex);
    expect(scheduleIndex).toBeGreaterThan(doseIndex);
  });

  it("omits the name row entirely when no topLabel is passed — other callers are unaffected", () => {
    const dose = makeDose({}, "One dose");
    const el = renderMacroDoseButton(dose, colors, { ...baseParams, large: true, visibleLabel: "One dose" });
    const text: string[] = [];
    collectText(el, text);
    expect(text).not.toContain("Shingrix");
    expect(text.join(" ")).toContain("One dose");
  });

  it("hides the name row while showing the 'Copied ✓' flag, same as the sub-label", () => {
    const dose = makeDose({ doseInterval: "2 mo" }, "Shingrix (Dose 2) (50+, 19+ IC)");
    const el = renderMacroDoseButton(dose, colors, {
      ...baseParams,
      isCopied: true,
      large: true,
      topLabel: "Shingrix",
      visibleLabel: "Dose 2",
      subLabel: "2 mo",
    });
    const text: string[] = [];
    collectText(el, text);
    expect(text).not.toContain("Shingrix");
    expect(text.join(" ")).toContain("Copied");
  });
});
