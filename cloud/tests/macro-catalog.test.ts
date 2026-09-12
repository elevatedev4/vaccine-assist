import { describe, expect, it } from "vitest";
import {
  lookupMacroCatalog,
  macroBaseShortCode,
  macroFamilyForType,
  MACRO_CATALOG_OTHER_ORDER,
} from "@/lib/macro-catalog";

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

describe("macroFamilyForType", () => {
  it("classifies every flu/COVID sheet Type as fluCovid", () => {
    for (const type of ["Pfizer 12+", "Moderna 12+", "Moderna 3-11", "Flu (regular)", "Flu (65+)", "Flu (nasal)", "Flu mRNA (50+)"]) {
      expect(macroFamilyForType(type)).toBe("fluCovid");
    }
  });

  it("classifies every other sheet Type as other", () => {
    for (const type of ["RSV", "RSV (preg)", "Shingles", "HPV", "MMR", "Other"]) {
      expect(macroFamilyForType(type)).toBe("other");
    }
  });
});

describe("lookupMacroCatalog", () => {
  it("resolves a multi-dose per-dose code via the digit-stripped base", () => {
    expect(lookupMacroCatalog("shingrix1")).toMatchObject({ type: "Shingles", family: "other" });
    expect(lookupMacroCatalog("shingrix2")).toMatchObject({ type: "Shingles", family: "other" });
    expect(lookupMacroCatalog("gardasil3")).toMatchObject({ type: "HPV", family: "other" });
  });

  it("resolves a single-dose code whose trailing digits are part of the code itself, without stripping them", () => {
    expect(lookupMacroCatalog("comirnaty12")).toMatchObject({ type: "Pfizer 12+", family: "fluCovid", age: "12+", ageMinMonths: 144 });
    expect(lookupMacroCatalog("spikevax6mo11")).toMatchObject({ type: "Moderna 3-11", family: "fluCovid", age: "3–11", ageMinMonths: 36 });
    expect(lookupMacroCatalog("prevnar20")).toMatchObject({ type: "Pneumonia 20", family: "other" });
  });

  it("puts mFLUSIVA and FluMist in the fluCovid family (round-3: 'Add mFLUSIVA and FluMist to the flu/covid section')", () => {
    // mFLUSIVA gets its OWN type ("Flu mRNA (50+)"), not "Flu (regular)"
    // — a round-3 REVIEW fix: sharing "Flu (regular)" with the 6-mo+
    // products scattered that Type into two non-contiguous runs once
    // the fluCovid family started sorting by age.
    expect(lookupMacroCatalog("mflusiva")).toMatchObject({ type: "Flu mRNA (50+)", family: "fluCovid", age: "50+", ageMinMonths: 600 });
    expect(lookupMacroCatalog("flumist")).toMatchObject({ type: "Flu (nasal)", family: "fluCovid", age: "2–49", ageMinMonths: 24 });
  });

  it("gives the two MMR products the same type but keeps them independently keyed", () => {
    expect(lookupMacroCatalog("mmr1")).toMatchObject({ type: "MMR", family: "other" });
    expect(lookupMacroCatalog("priorix2")).toMatchObject({ type: "MMR", family: "other" });
  });

  it("falls back to 'Other' (sorted last, family 'other', no age) for an unrecognized short code", () => {
    const result = lookupMacroCatalog("somethingbrandnew");
    expect(result.type).toBe("Other");
    expect(result.sheetOrder).toBe(MACRO_CATALOG_OTHER_ORDER);
    expect(result.family).toBe("other");
    expect(result.age).toBe("");
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(lookupMacroCatalog("  Shingrix1 ")).toMatchObject({ type: "Shingles" });
  });

  it("every catalog entry (looked up by every code in the round-3 age table) carries a non-empty age label and a finite ageMinMonths", () => {
    const codes = [
      "comirnaty12",
      "mnexspike",
      "spikevax6mo11",
      "flucelvaxmdv",
      "flucelvaxpfs",
      "mflusiva",
      "afluriapfs",
      "fluad",
      "fluzonehd",
      "flumist",
      "arexvy",
      "abrysvo",
      "shingrix1",
      "engerix1",
      "prevnar20",
      "capvaxive",
      "boostrix1",
      "gardasil1",
      "menveo",
      "vaqtaadult1",
      "typhim",
      "mmr1",
      "priorix1",
    ];
    for (const code of codes) {
      const entry = lookupMacroCatalog(code);
      expect(entry.age, `${code} should have a non-empty age`).not.toBe("");
      expect(Number.isFinite(entry.ageMinMonths), `${code} should have a finite ageMinMonths`).toBe(true);
    }
  });
});
