import { describe, expect, it } from "vitest";
import { lookupMacroCatalog, macroBaseShortCode, MACRO_CATALOG_OTHER_ORDER } from "@/lib/macro-catalog";

describe("macroBaseShortCode", () => {
  it("lowercases and strips a trailing run of digits", () => {
    expect(macroBaseShortCode("shingrix1")).toBe("shingrix");
    expect(macroBaseShortCode("SHINGRIX2")).toBe("shingrix");
    expect(macroBaseShortCode("engerix3")).toBe("engerix");
    expect(macroBaseShortCode("vaqtaadult1")).toBe("vaqtaadult");
  });

  it("leaves a code with no trailing digits unchanged (besides lowercasing)", () => {
    expect(macroBaseShortCode("Flucelvaxpfs")).toBe("flucelvaxpfs");
  });
});

describe("lookupMacroCatalog", () => {
  it("resolves a multi-dose per-dose code via the digit-stripped base", () => {
    expect(lookupMacroCatalog("shingrix1")).toMatchObject({ type: "Shingles" });
    expect(lookupMacroCatalog("shingrix2")).toMatchObject({ type: "Shingles" });
    expect(lookupMacroCatalog("gardasil3")).toMatchObject({ type: "HPV" });
  });

  it("resolves a single-dose code whose trailing digits are part of the code itself, without stripping them", () => {
    expect(lookupMacroCatalog("comirnaty12")).toMatchObject({ type: "Pfizer 12+", sections: ["age12plus"] });
    expect(lookupMacroCatalog("spikevax6mo11")).toMatchObject({ type: "Moderna 3-11", sections: ["age3to11"] });
    expect(lookupMacroCatalog("prevnar20")).toMatchObject({ type: "Pneumonia 20" });
  });

  it("gives the two MMR products the same type but keeps them independently keyed", () => {
    expect(lookupMacroCatalog("mmr1")).toMatchObject({ type: "MMR" });
    expect(lookupMacroCatalog("priorix2")).toMatchObject({ type: "MMR" });
  });

  it("falls back to 'Other' (sorted last) for an unrecognized short code", () => {
    const result = lookupMacroCatalog("somethingbrandnew");
    expect(result.type).toBe("Other");
    expect(result.sheetOrder).toBe(MACRO_CATALOG_OTHER_ORDER);
    expect(result.sections).toEqual([]);
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(lookupMacroCatalog("  Shingrix1 ")).toMatchObject({ type: "Shingles" });
  });
});
