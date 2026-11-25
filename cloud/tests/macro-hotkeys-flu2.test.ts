import { describe, expect, it } from "vitest";
import {
  hotkeyForProduct,
  hotkeyMapForProfile,
  hotkeyTransition,
  INITIAL_HOTKEY_STATE,
  MACRO_HOTKEYS,
  MACRO_HOTKEYS_FLU2,
  makeFlu2SmartResolver,
  parseHotkeyProfile,
  resolveHotkeyTarget,
  type HotkeyContext,
} from "@/lib/macro-hotkeys";
import {
  buildMacroRows,
  groupMacroRowsBySection,
  groupSectionsByTopGroup,
  type MacroRowVaccine,
  type MacroTopGroupBlock,
} from "@/lib/macro-codes";
import type { ProductView } from "@/lib/product-view";
import { DEFAULT_PREFERRED_COVID, type PreferredCovidSettingInput } from "@/lib/preferred-covid";

// Synthetic catalog fixture, same builders as tests/macro-hotkeys.test.ts.
const TODAY = "2026-01-01";

function view(productKey: string, displayName: string, vaccineIds: string[]): ProductView {
  return { productKey, displayName, vaccineIds, ndc: null, altNdcs: [], ndcSource: null, packageSize: null, group: "Other", active: true };
}

function vaccine(id: string, name: string, code: string): MacroRowVaccine {
  return { id, name, ndc: null, dose: "1", short_code: code, active: true, cash_price_cents: null };
}

const ENTRIES = [
  ["flucelvax", "Flucelvax", "flucelvaxmdv"],
  ["mflusiva", "mFLUSIVA", "mflusiva"],
  ["fluad", "Fluad", "fluad"],
  ["flumist", "FluMist", "flumist"],
  ["pfizer", "Pfizer 12+", "comirnaty12"],
  ["moderna", "Moderna 12+", "mnexspike"],
  ["modernakids", "Moderna 3-11", "spikevax6mo11"],
  ["pfizerkids", "Pfizer 5-11", "comirnaty511"],
  ["capvaxive", "Capvaxive", "capvaxive"],
  ["vaqta", "Vaqta", "vaqtaadult"],
] as const;

function fixture(): MacroTopGroupBlock[] {
  const products = ENTRIES.map(([key, name]) => view(key, name, [`${key}-id`]));
  const vaccines = ENTRIES.map(([key, name, code]) => vaccine(`${key}-id`, name, code));
  return groupSectionsByTopGroup(groupMacroRowsBySection(buildMacroRows(products, vaccines, {}, TODAY)));
}

function press(key: string, context: HotkeyContext) {
  return hotkeyTransition(INITIAL_HOTKEY_STATE, key, fixture(), context);
}

function codeOf(result: ReturnType<typeof press>): string | null {
  return result.action.type === "copy" ? result.action.row.shortCode : null;
}

function flu2(age: number | null, covid: PreferredCovidSettingInput = DEFAULT_PREFERRED_COVID): HotkeyContext {
  return { map: MACRO_HOTKEYS_FLU2, smart: makeFlu2SmartResolver(age, covid) };
}

describe("flu2 hotkey map", () => {
  it("maps X Flucelvax, D Fluad, V mFLUSIVA; P and M unchanged", () => {
    expect(MACRO_HOTKEYS_FLU2.x).toEqual(["flucelvaxmdv", "flucelvaxpfs"]);
    expect(MACRO_HOTKEYS_FLU2.d).toEqual(["fluad"]);
    expect(MACRO_HOTKEYS_FLU2.v).toEqual(["mflusiva"]);
    expect(MACRO_HOTKEYS_FLU2.p).toEqual(["comirnaty12"]);
    expect(MACRO_HOTKEYS_FLU2.m).toEqual(["mnexspike"]);
  });

  it("maps 5 to Pfizer 5-11 (same key as the classic map)", () => {
    expect(MACRO_HOTKEYS_FLU2["5"]).toEqual(["comirnaty511"]);
    expect(MACRO_HOTKEYS["5"]).toEqual(["comirnaty511"]);
    expect(hotkeyForProduct("comirnaty511", MACRO_HOTKEYS_FLU2)).toBe("5");
  });

  it("leaves F and C to the per-patient resolver and releases L", () => {
    expect(MACRO_HOTKEYS_FLU2.f).toBeUndefined();
    expect(MACRO_HOTKEYS_FLU2.c).toBeUndefined();
    expect(MACRO_HOTKEYS_FLU2.l).toBeUndefined();
  });

  it("moves Capvaxive to A and Vaqta to Q (their old keys C and V are taken)", () => {
    expect(MACRO_HOTKEYS_FLU2.a).toEqual(["capvaxive"]);
    expect(MACRO_HOTKEYS_FLU2.q).toEqual(["vaqtaadult"]);
  });

  it("never gives one letter to two products (only MMR/Priorix share I by design)", () => {
    const owners = new Map<string, string>();
    for (const [key, codes] of Object.entries(MACRO_HOTKEYS_FLU2)) {
      for (const code of codes) {
        expect(owners.has(code)).toBe(false);
        owners.set(code, key);
      }
    }
  });

  it("changes only the keys it should relative to the classic map", () => {
    const changed = new Set<string>();
    for (const key of new Set([...Object.keys(MACRO_HOTKEYS), ...Object.keys(MACRO_HOTKEYS_FLU2)])) {
      if (JSON.stringify(MACRO_HOTKEYS[key]) !== JSON.stringify(MACRO_HOTKEYS_FLU2[key])) changed.add(key);
    }
    expect([...changed].sort()).toEqual(["a", "c", "f", "l", "q", "v", "x"]);
  });

  it("underlines each product with its flu2 key", () => {
    expect(hotkeyForProduct("flucelvaxmdv", MACRO_HOTKEYS_FLU2)).toBe("x");
    expect(hotkeyForProduct("mflusiva", MACRO_HOTKEYS_FLU2)).toBe("v");
    expect(hotkeyForProduct("capvaxive", MACRO_HOTKEYS_FLU2)).toBe("a");
  });
});

describe("hotkey profile selection", () => {
  it("only hk=flu2 opts in; everything else stays classic", () => {
    expect(parseHotkeyProfile("flu2")).toBe("flu2");
    expect(parseHotkeyProfile(" FLU2 ")).toBe("flu2");
    expect(parseHotkeyProfile(null)).toBe("classic");
    expect(parseHotkeyProfile("")).toBe("classic");
    expect(parseHotkeyProfile("zzz")).toBe("classic");
    expect(hotkeyMapForProfile("classic")).toBe(MACRO_HOTKEYS);
    expect(hotkeyMapForProfile("flu2")).toBe(MACRO_HOTKEYS_FLU2);
  });

  it("classic keys behave exactly as before when no context is passed", () => {
    expect(codeOf(press("f", {}))).toBe("flucelvaxmdv");
    expect(codeOf(press("c", {}))).toBe("capvaxive");
    expect(codeOf(press("v", {}))).toBe("vaqtaadult");
    expect(resolveHotkeyTarget("l", fixture())?.row.shortCode).toBe("mflusiva");
  });
});

describe("F (recommended flu for the age)", () => {
  it.each([
    [3, "flucelvaxmdv"],
    [11, "flucelvaxmdv"],
    [12, "flucelvaxmdv"],
    [49, "flucelvaxmdv"],
    [50, "mflusiva"],
    [64, "mflusiva"],
    [65, "fluad"],
  ])("age %s -> %s", (age, code) => {
    const result = press("f", flu2(age));
    expect(result.action.type).toBe("copy");
    expect(codeOf(result)).toBe(code);
  });

  it("does nothing but show a message for an unknown age or under 3", () => {
    const unknown = press("f", flu2(null));
    expect(unknown.action.type).toBe("notice");
    expect(unknown.state).toEqual(INITIAL_HOTKEY_STATE);
    expect(press("f", flu2(2)).action).toEqual({ type: "notice", message: "No flu vaccine under age 3." });
  });
});

describe("X / D / V pick a specific flu product regardless of age", () => {
  it("X Flucelvax, D Fluad, V mFLUSIVA", () => {
    expect(codeOf(press("x", flu2(70)))).toBe("flucelvaxmdv");
    expect(codeOf(press("d", flu2(30)))).toBe("fluad");
    expect(codeOf(press("v", flu2(30)))).toBe("mflusiva");
  });
});

describe("C (preferred COVID from the location setting)", () => {
  it("default setting: 12+ -> Pfizer 12+, 5-11 -> Pfizer 5-11, 3-4 -> Moderna kids", () => {
    expect(codeOf(press("c", flu2(12)))).toBe("comirnaty12");
    expect(codeOf(press("c", flu2(40)))).toBe("comirnaty12");
    expect(codeOf(press("c", flu2(11)))).toBe("comirnaty511");
    expect(codeOf(press("c", flu2(5)))).toBe("comirnaty511");
    expect(codeOf(press("c", flu2(4)))).toBe("spikevax6mo11");
    expect(codeOf(press("c", flu2(3)))).toBe("spikevax6mo11");
  });

  it("follows a changed 12+ setting without moving the kids picks", () => {
    const moderna12 = { adult: "moderna", kids: "moderna", kids511: "pfizer" } as const;
    expect(codeOf(press("c", flu2(30, moderna12)))).toBe("mnexspike");
    expect(codeOf(press("c", flu2(11, moderna12)))).toBe("comirnaty511");
    expect(codeOf(press("c", flu2(4, moderna12)))).toBe("spikevax6mo11");
  });

  it("follows a changed 5-11 setting (Moderna 3-11) for ages 5 through 11 only", () => {
    const modernaKids = { adult: "pfizer", kids: "moderna", kids511: "moderna" } as const;
    expect(codeOf(press("c", flu2(5, modernaKids)))).toBe("spikevax6mo11");
    expect(codeOf(press("c", flu2(11, modernaKids)))).toBe("spikevax6mo11");
    expect(codeOf(press("c", flu2(12, modernaKids)))).toBe("comirnaty12");
  });

  it("an old saved setting (no kids511) picks Pfizer 5-11 for ages 5-11", () => {
    const oldStored = { adult: "pfizer", kids: "moderna" } as const;
    expect(codeOf(press("c", flu2(8, oldStored)))).toBe("comirnaty511");
    expect(codeOf(press("c", flu2(3, oldStored)))).toBe("spikevax6mo11");
  });

  it("the 5 key picks Pfizer 5-11 whatever the age or setting", () => {
    expect(codeOf(press("5", flu2(40)))).toBe("comirnaty511");
    expect(codeOf(press("5", { map: MACRO_HOTKEYS }))).toBe("comirnaty511");
    expect(codeOf(press("5", flu2(8, { adult: "pfizer", kids: "moderna", kids511: "moderna" })))).toBe("comirnaty511");
  });

  it("does nothing but show a message for an unknown age or under 3", () => {
    expect(press("c", flu2(null)).action.type).toBe("notice");
    expect(press("c", flu2(2)).action).toEqual({ type: "notice", message: "No COVID vaccine under age 3." });
    expect(press("c", flu2(null)).state).toEqual(INITIAL_HOTKEY_STATE);
  });

  it("says so when the preferred product is not on the visible list", () => {
    const empty = hotkeyTransition(INITIAL_HOTKEY_STATE, "c", [], flu2(30));
    expect(empty.action).toEqual({ type: "notice", message: "Pfizer 12+ isn't on the list right now." });
    const emptyKids = hotkeyTransition(INITIAL_HOTKEY_STATE, "c", [], flu2(8));
    expect(emptyKids.action).toEqual({ type: "notice", message: "Pfizer 5-11 isn't on the list right now." });
  });

  it("P and M still pick Pfizer and Moderna", () => {
    expect(codeOf(press("p", flu2(30)))).toBe("comirnaty12");
    expect(codeOf(press("m", flu2(30)))).toBe("mnexspike");
  });
});

describe("makeFlu2SmartResolver", () => {
  it("returns null for keys that are not smart keys", () => {
    expect(makeFlu2SmartResolver(30, DEFAULT_PREFERRED_COVID)("x")).toBeNull();
    expect(makeFlu2SmartResolver(30, DEFAULT_PREFERRED_COVID)("p")).toBeNull();
  });
});
