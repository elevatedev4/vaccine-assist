import { describe, expect, it } from "vitest";
import { hotkeyForProduct, MACRO_HOTKEYS, resolveHotkeyTarget, underlineHotkey } from "@/lib/macro-hotkeys";
import {
  buildMacroRows,
  filterMacroTopGroups,
  groupMacroRowsBySection,
  groupSectionsByTopGroup,
  type MacroRowVaccine,
  type MacroTopGroupBlock,
} from "@/lib/macro-codes";
import type { ProductView } from "@/lib/product-view";

// Same fixture-building posture as tests/macro-codes.test.ts (view() +
// vaccine() minimal builders, buildMacroRows -> groupMacroRowsBySection
// -> groupSectionsByTopGroup pipeline) so resolveHotkeyTarget is
// exercised against the exact same MacroTopGroupBlock[] shape the page
// renders, not a hand-rolled stand-in. Synthetic data only.
const TODAY = "2026-01-01";

function view(overrides: Partial<ProductView> & { productKey: string; vaccineIds: string[] }): ProductView {
  return {
    displayName: overrides.productKey,
    ndc: null,
    ndcSource: null,
    packageSize: null,
    group: "Other",
    active: true,
    ...overrides,
  };
}

function vaccine(overrides: Partial<MacroRowVaccine> & { id: string }): MacroRowVaccine {
  return {
    name: overrides.id,
    ndc: null,
    dose: "1",
    short_code: "code",
    active: true,
    cash_price_cents: null,
    ...overrides,
  };
}

/** Builds a full visibleTopGroups fixture from a flat list of {code,
 * name, dose?} entries — one vaccine/product per entry, dose rows of the
 * same product sharing one productKey/vaccineIds group. */
function buildVisibleTopGroups(
  entries: ReadonlyArray<{ productKey: string; name: string; code: string; dose?: string }>
): MacroTopGroupBlock[] {
  const byProduct = new Map<string, typeof entries[number][]>();
  for (const entry of entries) {
    const list = byProduct.get(entry.productKey) ?? [];
    list.push(entry);
    byProduct.set(entry.productKey, list);
  }

  const products: ProductView[] = [];
  const vaccines: MacroRowVaccine[] = [];
  for (const [productKey, group] of byProduct) {
    products.push(view({ productKey, displayName: group[0].name, vaccineIds: group.map((g) => `${productKey}-${g.code}`) }));
    for (const g of group) {
      vaccines.push(vaccine({ id: `${productKey}-${g.code}`, name: g.name, short_code: g.code, dose: g.dose ?? "1" }));
    }
  }

  const rows = buildMacroRows(products, vaccines, {}, TODAY);
  return groupSectionsByTopGroup(groupMacroRowsBySection(rows));
}

describe("MACRO_HOTKEYS", () => {
  it("maps every key from Will's brief with no letter reused across products", () => {
    expect(Object.keys(MACRO_HOTKEYS).sort()).toEqual(
      ["3", "a", "b", "c", "e", "f", "g", "i", "l", "m", "n", "o", "p", "r", "s", "t", "u", "v"].sort()
    );
    expect(MACRO_HOTKEYS.f).toEqual(["flucelvaxmdv", "flucelvaxpfs"]);
    expect(MACRO_HOTKEYS.i).toEqual(["mmr", "priorix"]);
    expect(MACRO_HOTKEYS["3"]).toEqual(["spikevax6mo11"]);
  });
});

describe("hotkeyForProduct", () => {
  it("resolves an exact single-dose short code", () => {
    expect(hotkeyForProduct("comirnaty12")).toBe("p");
    expect(hotkeyForProduct("mnexspike")).toBe("m");
    expect(hotkeyForProduct("abrysvo")).toBe("r");
  });

  it("resolves a multi-dose product's per-dose code via the digit-stripped base", () => {
    expect(hotkeyForProduct("shingrix1")).toBe("s");
    expect(hotkeyForProduct("shingrix2")).toBe("s");
    expect(hotkeyForProduct("gardasil3")).toBe("g");
    expect(hotkeyForProduct("engerix2")).toBe("e");
  });

  it("resolves both duplicate-key codes under one letter (f: flucelvaxmdv/flucelvaxpfs)", () => {
    expect(hotkeyForProduct("flucelvaxmdv")).toBe("f");
    expect(hotkeyForProduct("flucelvaxpfs")).toBe("f");
  });

  it("resolves both distinct products sharing one letter (i: mmr/priorix)", () => {
    expect(hotkeyForProduct("mmr1")).toBe("i");
    expect(hotkeyForProduct("priorix")).toBe("i");
  });

  it("is case-insensitive", () => {
    expect(hotkeyForProduct("SHINGRIX1")).toBe("s");
  });

  it("returns null for an unrecognized or empty code", () => {
    expect(hotkeyForProduct("totallyunknown")).toBeNull();
    expect(hotkeyForProduct("")).toBeNull();
  });
});

describe("resolveHotkeyTarget", () => {
  it("resolves a single-dose product to its own row", () => {
    const topGroups = buildVisibleTopGroups([{ productKey: "p:comirnaty", name: "Comirnaty", code: "comirnaty12" }]);
    const target = resolveHotkeyTarget("p", topGroups);
    expect(target?.product.displayName).toBe("Comirnaty");
    expect(target?.row.shortCode).toBe("comirnaty12");
  });

  it("resolves a multi-dose product to its dose-1 row (lowest dose number), not a later dose", () => {
    const topGroups = buildVisibleTopGroups([
      { productKey: "p:shingrix", name: "Shingrix", code: "shingrix2", dose: "2" },
      { productKey: "p:shingrix", name: "Shingrix", code: "shingrix1", dose: "1" },
    ]);
    const target = resolveHotkeyTarget("s", topGroups);
    expect(target?.row.doseNumber).toBe(1);
    expect(target?.row.shortCode).toBe("shingrix1");
  });

  it("duplicate-key products: picks the first VISIBLE one in render order (mmr before priorix, both under 'i')", () => {
    const topGroups = buildVisibleTopGroups([
      { productKey: "p:mmr", name: "M-M-R II", code: "mmr1" },
      { productKey: "p:priorix", name: "Priorix", code: "priorix" },
    ]);
    const target = resolveHotkeyTarget("i", topGroups);
    expect(target?.product.displayName).toBe("M-M-R II");
  });

  it("never returns a product filtered out of visibleTopGroups", () => {
    const topGroups = buildVisibleTopGroups([
      { productKey: "p:flucelvax", name: "Flucelvax", code: "flucelvaxmdv" },
      { productKey: "p:boostrix", name: "Boostrix", code: "boostrix" },
    ]);
    // Confirm it resolves against the unfiltered list first.
    expect(resolveHotkeyTarget("f", topGroups)?.product.displayName).toBe("Flucelvax");

    // A search query that only matches Boostrix filters Flucelvax out of
    // the visible set entirely — "f" must now find nothing, not fall
    // back to the hidden product.
    const filtered = filterMacroTopGroups(topGroups, "boostrix");
    expect(resolveHotkeyTarget("f", filtered)).toBeNull();
    expect(resolveHotkeyTarget("b", filtered)?.product.displayName).toBe("Boostrix");
  });

  it("returns null for a key with no hotkey mapping at all", () => {
    const topGroups = buildVisibleTopGroups([{ productKey: "p:boostrix", name: "Boostrix", code: "boostrix" }]);
    expect(resolveHotkeyTarget("x", topGroups)).toBeNull();
    expect(resolveHotkeyTarget("", topGroups)).toBeNull();
  });

  it("returns null when the mapped product has no visible row at all (empty topGroups)", () => {
    expect(resolveHotkeyTarget("f", [])).toBeNull();
  });
});

describe("underlineHotkey", () => {
  it("splits out the first case-insensitive occurrence, preserving the name's own casing", () => {
    expect(underlineHotkey("Flucelvax", "f")).toEqual({ before: "", letter: "F", after: "lucelvax" });
    expect(underlineHotkey("Boostrix", "b")).toEqual({ before: "", letter: "B", after: "oostrix" });
  });

  it("matches a letter mid-word, not just at the start (Will's chosen substitute keys)", () => {
    expect(underlineHotkey("Fluad", "a")).toEqual({ before: "Flu", letter: "a", after: "d" });
    expect(underlineHotkey("Prevnar 20", "n")).toEqual({ before: "Prev", letter: "n", after: "ar 20" });
  });

  it("preserves the original character's casing even though the search is case-insensitive", () => {
    expect(underlineHotkey("mFLUSIVA", "l")).toEqual({ before: "mF", letter: "L", after: "USIVA" });
  });

  it("matches a digit key against a name containing that digit", () => {
    expect(underlineHotkey("Moderna 3–11", "3")).toEqual({ before: "Moderna ", letter: "3", after: "–11" });
  });

  it("returns null when the letter is absent from the name (absent-letter case)", () => {
    expect(underlineHotkey("MMR", "i")).toBeNull();
  });

  it("returns null for an empty key", () => {
    expect(underlineHotkey("Boostrix", "")).toBeNull();
  });
});
