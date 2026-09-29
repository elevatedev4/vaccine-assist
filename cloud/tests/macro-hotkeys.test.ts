import { describe, expect, it } from "vitest";
import {
  armedHotkeyNote,
  decideEmbedEscape,
  findArmedProduct,
  hotkeyForProduct,
  hotkeyTransition,
  INITIAL_HOTKEY_STATE,
  MACRO_HOTKEYS,
  resolveHotkeyTarget,
  underlineHotkey,
  type HotkeyState,
} from "@/lib/macro-hotkeys";
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
      ["3", "b", "c", "d", "e", "f", "g", "i", "l", "m", "n", "o", "p", "r", "s", "t", "u", "v"].sort()
    );
    expect(MACRO_HOTKEYS.f).toEqual(["flucelvaxmdv", "flucelvaxpfs"]);
    expect(MACRO_HOTKEYS.i).toEqual(["mmr", "priorix"]);
    expect(MACRO_HOTKEYS["3"]).toEqual(["spikevax6mo11"]);
    // Round 2 (Will's verbatim answer, 2026-09-28): "Fluad's key is D
    // (not A)."
    expect(MACRO_HOTKEYS.d).toEqual(["fluad"]);
    expect(MACRO_HOTKEYS.a).toBeUndefined();
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
    // Round 2 (Will's verbatim answer, 2026-09-28): Fluad's key moved
    // from "a" to "d" — the underline moves to the final letter.
    expect(underlineHotkey("Fluad", "d")).toEqual({ before: "Flua", letter: "d", after: "" });
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

describe("hotkeyTransition (round 2: armed multi-dose flow)", () => {
  // Shingrix (2 doses, key "s"), Gardasil 9 (3 doses, key "g"), Comirnaty
  // (1 dose, key "p"), and Moderna 3-11 (1 dose, key "3") — enough to
  // cover every branch: a single-dose copy, a multi-dose arm, dose-digit
  // selection, re-arming to a different product (multi- or single-dose),
  // the "3" digit-vs-Moderna-letter overlap, and Escape.
  const topGroups = buildVisibleTopGroups([
    { productKey: "p:shingrix", name: "Shingrix", code: "shingrix1", dose: "1" },
    { productKey: "p:shingrix", name: "Shingrix", code: "shingrix2", dose: "2" },
    { productKey: "p:gardasil", name: "Gardasil 9", code: "gardasil1", dose: "1" },
    { productKey: "p:gardasil", name: "Gardasil 9", code: "gardasil2", dose: "2" },
    { productKey: "p:gardasil", name: "Gardasil 9", code: "gardasil3", dose: "3" },
    { productKey: "p:comirnaty", name: "Comirnaty", code: "comirnaty12" },
    { productKey: "p:moderna", name: "Moderna 3-11", code: "spikevax6mo11" },
  ]);
  const NOT_ARMED: HotkeyState = { armedProductKey: null };
  function armedOn(productKey: string): HotkeyState {
    return { armedProductKey: productKey };
  }

  it("a single-dose product's letter copies immediately, no arming (round 1 behavior preserved)", () => {
    const result = hotkeyTransition(NOT_ARMED, "p", topGroups);
    expect(result.action).toEqual({
      type: "copy",
      product: expect.objectContaining({ displayName: "Comirnaty" }),
      row: expect.objectContaining({ shortCode: "comirnaty12" }),
    });
    expect(result.state).toEqual(NOT_ARMED);
  });

  it("a multi-dose product's letter arms it instead of copying", () => {
    const result = hotkeyTransition(NOT_ARMED, "s", topGroups);
    expect(result.action.type).toBe("arm");
    expect(result.action).toEqual({ type: "arm", product: expect.objectContaining({ displayName: "Shingrix" }) });
    expect(result.state.armedProductKey).toBe("p:shingrix");
  });

  it("a dose digit while armed copies that dose and unarms", () => {
    const armed = armedOn("p:shingrix");
    const doseTwo = hotkeyTransition(armed, "2", topGroups);
    expect(doseTwo.action).toEqual({
      type: "copy",
      product: expect.objectContaining({ displayName: "Shingrix" }),
      row: expect.objectContaining({ shortCode: "shingrix2", doseNumber: 2 }),
    });
    expect(doseTwo.state).toEqual(NOT_ARMED);

    const doseOne = hotkeyTransition(armed, "1", topGroups);
    expect(doseOne.action).toMatchObject({ type: "copy", row: expect.objectContaining({ shortCode: "shingrix1", doseNumber: 1 }) });
  });

  it("a digit beyond the armed product's dose count does nothing and stays armed", () => {
    const armed = armedOn("p:shingrix"); // only doses 1-2
    const result = hotkeyTransition(armed, "3", topGroups);
    expect(result.action).toEqual({ type: "none" });
    expect(result.state).toEqual(armed);
  });

  it('the "3" key means Moderna 3-11 when nothing is armed, but means "dose 3" while armed (Gardasil has one)', () => {
    const unarmed = hotkeyTransition(NOT_ARMED, "3", topGroups);
    expect(unarmed.action).toEqual({
      type: "copy",
      product: expect.objectContaining({ displayName: "Moderna 3-11" }),
      row: expect.objectContaining({ shortCode: "spikevax6mo11" }),
    });

    const armedOnGardasil = armedOn("p:gardasil");
    const whileArmed = hotkeyTransition(armedOnGardasil, "3", topGroups);
    expect(whileArmed.action).toEqual({
      type: "copy",
      product: expect.objectContaining({ displayName: "Gardasil 9" }),
      row: expect.objectContaining({ shortCode: "gardasil3", doseNumber: 3 }),
    });
  });

  it("a different multi-dose letter while armed RE-ARMS to that product", () => {
    const armedOnShingrix = armedOn("p:shingrix");
    const result = hotkeyTransition(armedOnShingrix, "g", topGroups);
    expect(result.action).toEqual({ type: "arm", product: expect.objectContaining({ displayName: "Gardasil 9" }) });
    expect(result.state.armedProductKey).toBe("p:gardasil");
  });

  it("a single-dose letter while armed copies immediately instead of arming", () => {
    const armedOnShingrix = armedOn("p:shingrix");
    const result = hotkeyTransition(armedOnShingrix, "p", topGroups);
    expect(result.action).toEqual({
      type: "copy",
      product: expect.objectContaining({ displayName: "Comirnaty" }),
      row: expect.objectContaining({ shortCode: "comirnaty12" }),
    });
    expect(result.state).toEqual(NOT_ARMED);
  });

  it("Escape while armed clears the armed state and nothing else", () => {
    const armed = armedOn("p:shingrix");
    const result = hotkeyTransition(armed, "Escape", topGroups);
    expect(result.action).toEqual({ type: "clear" });
    expect(result.state).toEqual(NOT_ARMED);
  });

  it("Escape while nothing is armed is a no-op (leaves Escape to the page's other handlers)", () => {
    const result = hotkeyTransition(NOT_ARMED, "Escape", topGroups);
    expect(result.action).toEqual({ type: "none" });
    expect(result.state).toEqual(NOT_ARMED);
  });

  it("an unmapped letter does nothing and does not disturb an existing armed state", () => {
    const armed = armedOn("p:shingrix");
    const result = hotkeyTransition(armed, "x", topGroups);
    expect(result.action).toEqual({ type: "none" });
    expect(result.state).toEqual(armed);
  });

  it("hidden-product case: a letter mapped to a product the current filter hides leaves an existing armed state untouched", () => {
    const armed = armedOn("p:shingrix");
    // Filter down to just Comirnaty — Gardasil's "g" no longer resolves.
    const filtered = filterMacroTopGroups(topGroups, "comirnaty");
    const result = hotkeyTransition(armed, "g", filtered);
    expect(result.action).toEqual({ type: "none" });
    expect(result.state).toEqual(armed);
  });

  it("hidden-product case: a dose digit clears armed state instead of dangling when the armed product is no longer visible", () => {
    const armed = armedOn("p:shingrix");
    const filtered = filterMacroTopGroups(topGroups, "comirnaty"); // hides Shingrix entirely
    const result = hotkeyTransition(armed, "1", filtered);
    expect(result.action).toEqual({ type: "clear" });
    expect(result.state).toEqual(NOT_ARMED);
  });
});

describe("findArmedProduct", () => {
  // ROUND 2 FOLLOW-UP (reviewer, code review on 5a39605): app/macro-codes/
  // page.tsx now calls this directly to decide whether to clear armed
  // state, instead of clearing on every `visibleTopGroups` reference
  // change (which fired on background refetches too, e.g. the 60s
  // heartbeat / window-focus refetch — see this file's own follow-up
  // note in lib/macro-hotkeys.ts). The key behavior these tests pin
  // down: a REBUILT-but-still-present product (a fresh array from a
  // same-data refetch, new object identities throughout) still resolves,
  // while a genuinely filtered-out product does not.
  const topGroups = buildVisibleTopGroups([
    { productKey: "p:shingrix", name: "Shingrix", code: "shingrix1", dose: "1" },
    { productKey: "p:shingrix", name: "Shingrix", code: "shingrix2", dose: "2" },
    { productKey: "p:comirnaty", name: "Comirnaty", code: "comirnaty12" },
  ]);

  it("resolves the armed product when it's still in the visible set", () => {
    const found = findArmedProduct("p:shingrix", topGroups);
    expect(found?.displayName).toBe("Shingrix");
    expect(found?.doses).toHaveLength(2);
  });

  it("still resolves after a same-data rebuild that gives every array/object a new reference (a background refetch, not a real filter change)", () => {
    // Rebuilding from the exact same source entries simulates a
    // heartbeat/focus refetch that returns unchanged data: none of the
    // objects below are the SAME references as `topGroups`' — only the
    // productKey strings match — which is exactly what tripped up the
    // old `useEffect(..., [visibleTopGroups])` clear.
    const rebuilt = buildVisibleTopGroups([
      { productKey: "p:shingrix", name: "Shingrix", code: "shingrix1", dose: "1" },
      { productKey: "p:shingrix", name: "Shingrix", code: "shingrix2", dose: "2" },
      { productKey: "p:comirnaty", name: "Comirnaty", code: "comirnaty12" },
    ]);
    expect(rebuilt).not.toBe(topGroups);
    const found = findArmedProduct("p:shingrix", rebuilt);
    expect(found?.displayName).toBe("Shingrix");
  });

  it("returns null once the armed product is genuinely filtered out", () => {
    const filtered = filterMacroTopGroups(topGroups, "comirnaty"); // hides Shingrix
    expect(findArmedProduct("p:shingrix", filtered)).toBeNull();
  });

  it("returns null against an empty visible set", () => {
    expect(findArmedProduct("p:shingrix", [])).toBeNull();
  });
});

describe("armedHotkeyNote", () => {
  it("formats the dose-count hint verbatim", () => {
    expect(armedHotkeyNote(2)).toBe("Press 1–2 for the dose · Esc to clear");
    expect(armedHotkeyNote(3)).toBe("Press 1–3 for the dose · Esc to clear");
  });
});

describe("decideEmbedEscape (V-T64: Escape must back out of an armed dose, not close the popup)", () => {
  it("posts macro-cancel when nothing is armed and no modal/menu is open (second Escape)", () => {
    expect(decideEmbedEscape({ modalOpen: false, anyMenuOpen: false, armedProductKey: null })).toBe("post-cancel");
  });

  it("does nothing while a product is armed, leaving the keypress to the hotkeys effect's own Escape-clears-armed handling (first Escape)", () => {
    expect(decideEmbedEscape({ modalOpen: false, anyMenuOpen: false, armedProductKey: "p:shingrix" })).toBe("none");
  });

  it("does nothing while the lot/exp modal is open (that effect owns Escape for its own close)", () => {
    expect(decideEmbedEscape({ modalOpen: true, anyMenuOpen: false, armedProductKey: null })).toBe("none");
  });

  it("does nothing while a ⚙ menu is open (that effect owns Escape for its own close)", () => {
    expect(decideEmbedEscape({ modalOpen: false, anyMenuOpen: true, armedProductKey: null })).toBe("none");
  });

  it("armed state wins even if a modal/menu flag is also somehow set", () => {
    expect(decideEmbedEscape({ modalOpen: true, anyMenuOpen: true, armedProductKey: "p:gardasil" })).toBe("none");
  });
});
