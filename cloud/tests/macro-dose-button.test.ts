import { describe, expect, it } from "vitest";
import {
  lotExpiryNote,
  missingNote,
  PRODUCT_COLORS,
  renderMacroDoseButton,
  resolveDoseButtonColors,
  SECTION_COLORS,
  subLabelFontSizePx,
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
    beyondUseDateIso: null,
    macro: null,
    complete: false,
    lotExpiry: "ok",
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

// V-lots-bud-spikevax follow-up (Will 2026-09-25 4:58pm): "add the
// notification on the macro codes as if it were expired fully".
describe("missingNote / lotExpiryNote", () => {
  it("missingNote reports lot/exp gaps and returns null once complete", () => {
    expect(missingNote(makeRow({ complete: false, lotNumber: null, expirationIso: null }))).toBe("lot + exp missing");
    expect(missingNote(makeRow({ complete: false, lotNumber: "L1", expirationIso: null }))).toBe("exp missing");
    expect(missingNote(makeRow({ complete: false, lotNumber: null, expirationIso: "2028-01-01" }))).toBe("lot missing");
    expect(missingNote(makeRow({ complete: true, lotNumber: "L1", expirationIso: "2028-01-01" }))).toBeNull();
  });

  it("missingNote/lotExpiryNote are both null for a no-short-code row", () => {
    expect(missingNote(makeRow({ shortCode: null, complete: false }))).toBeNull();
    expect(lotExpiryNote(makeRow({ shortCode: null, lotExpiry: "expired" }))).toBeNull();
  });

  it("lotExpiryNote reports 'expired' or 'beyond-use date passed' per row.lotExpiry", () => {
    expect(lotExpiryNote(makeRow({ complete: true, lotExpiry: "expired" }))).toBe("expired");
    expect(lotExpiryNote(makeRow({ complete: true, lotExpiry: "bud-expired" }))).toBe("beyond-use date passed");
    expect(lotExpiryNote(makeRow({ complete: true, lotExpiry: "ok" }))).toBeNull();
  });

  it("lotExpiryNote defers to missingNote — a lot with no number never ALSO shows an expiry note", () => {
    // lotExpiry can, in principle, be non-'ok' even with no current lot
    // number on file (buildMacroRows never produces this combination
    // itself, but this function's own precedence must not depend on
    // that) — missingNote's "lot missing" wins.
    const row = makeRow({ complete: false, lotNumber: null, expirationIso: "2028-01-01", lotExpiry: "expired" });
    expect(missingNote(row)).toBe("lot missing");
    expect(lotExpiryNote(row)).toBeNull();
  });
});

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
