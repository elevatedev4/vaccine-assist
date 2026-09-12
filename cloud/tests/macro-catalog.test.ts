import { describe, expect, it } from "vitest";
import {
  lookupMacroCatalog,
  macroBaseShortCode,
  MACRO_CATALOG_OTHER_ORDER,
  MACRO_SECTION_ORDER,
  macroSectionOrderIndex,
  sectionForType,
  type MacroSection,
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

describe("sectionForType", () => {
  it("classifies every COVID sheet Type as COVID", () => {
    for (const type of ["Pfizer 12+", "Moderna 12+", "Moderna 3-11"]) {
      expect(sectionForType(type)).toBe("COVID");
    }
  });

  it("classifies every flu sheet Type (incl. mFLUSIVA and FluMist) as Flu", () => {
    for (const type of ["Flu (regular)", "Flu (65+)", "Flu (nasal)", "Flu mRNA (50+)"]) {
      expect(sectionForType(type)).toBe("Flu");
    }
  });

  it("classifies every remaining catalog Type into its round-4 section", () => {
    const expected: Record<string, MacroSection> = {
      "Pneumonia 20": "Pneumonia",
      "Pneumonia 21": "Pneumonia",
      RSV: "RSV",
      "RSV (preg)": "RSV",
      Shingles: "Shingles",
      "Hep B (adult)": "Hep B",
      "Tetanus (TDaP)": "Tetanus",
      HPV: "HPV",
      Meningitis: "Meningitis",
      "Hepatitis A (19+)": "Hep A",
      Typhoid: "Typhoid",
      MMR: "MMR",
    };
    for (const [type, section] of Object.entries(expected)) {
      expect(sectionForType(type)).toBe(section);
    }
  });

  it("classifies an unrecognized Type as Other", () => {
    expect(sectionForType("Other")).toBe("Other");
    expect(sectionForType("Something Brand New")).toBe("Other");
  });

  it("every catalog Type maps to exactly one section (no type is silently dropped to Other)", () => {
    const allTypes = [
      "Pfizer 12+",
      "Moderna 12+",
      "Moderna 3-11",
      "Flu (regular)",
      "Flu (65+)",
      "Flu (nasal)",
      "Flu mRNA (50+)",
      "RSV",
      "RSV (preg)",
      "Shingles",
      "Hep B (adult)",
      "Pneumonia 20",
      "Pneumonia 21",
      "Tetanus (TDaP)",
      "HPV",
      "Meningitis",
      "Hepatitis A (19+)",
      "Typhoid",
      "MMR",
    ];
    for (const type of allTypes) {
      expect(sectionForType(type)).not.toBe("Other");
    }
  });
});

describe("MACRO_SECTION_ORDER / macroSectionOrderIndex", () => {
  it("orders Flu first, then COVID, then the rest in the sheet's row order, Other last", () => {
    expect(MACRO_SECTION_ORDER).toEqual([
      "Flu",
      "COVID",
      "RSV",
      "Shingles",
      "Hep B",
      "Pneumonia",
      "Tetanus",
      "HPV",
      "Meningitis",
      "Hep A",
      "Typhoid",
      "MMR",
      "Other",
    ]);
  });

  it("gives Flu a lower index than COVID, and every other section a lower index than Other", () => {
    expect(macroSectionOrderIndex("Flu")).toBeLessThan(macroSectionOrderIndex("COVID"));
    for (const section of MACRO_SECTION_ORDER) {
      if (section === "Other") continue;
      expect(macroSectionOrderIndex(section)).toBeLessThan(macroSectionOrderIndex("Other"));
    }
  });
});

describe("lookupMacroCatalog", () => {
  it("resolves a multi-dose per-dose code via the digit-stripped base", () => {
    expect(lookupMacroCatalog("shingrix1")).toMatchObject({ type: "Shingles", section: "Shingles" });
    expect(lookupMacroCatalog("shingrix2")).toMatchObject({ type: "Shingles", section: "Shingles" });
    expect(lookupMacroCatalog("gardasil3")).toMatchObject({ type: "HPV", section: "HPV" });
  });

  it("resolves a single-dose code whose trailing digits are part of the code itself, without stripping them", () => {
    expect(lookupMacroCatalog("comirnaty12")).toMatchObject({ type: "Pfizer 12+", section: "COVID", age: "12+", ageMinMonths: 144 });
    expect(lookupMacroCatalog("spikevax6mo11")).toMatchObject({ type: "Moderna 3-11", section: "COVID", age: "3–11", ageMinMonths: 36 });
    expect(lookupMacroCatalog("prevnar20")).toMatchObject({ type: "Pneumonia 20", section: "Pneumonia" });
  });

  it("puts mFLUSIVA and FluMist in the Flu section (round-3: 'Add mFLUSIVA and FluMist to the flu/covid section')", () => {
    // mFLUSIVA gets its OWN type ("Flu mRNA (50+)"), not "Flu (regular)"
    // — a round-3 REVIEW fix kept for its own age-label coverage.
    expect(lookupMacroCatalog("mflusiva")).toMatchObject({ type: "Flu mRNA (50+)", section: "Flu", age: "50+", ageMinMonths: 600 });
    expect(lookupMacroCatalog("flumist")).toMatchObject({ type: "Flu (nasal)", section: "Flu", age: "2–49", ageMinMonths: 24 });
  });

  it("gives the two MMR products the same type/section but keeps them independently keyed", () => {
    expect(lookupMacroCatalog("mmr1")).toMatchObject({ type: "MMR", section: "MMR" });
    expect(lookupMacroCatalog("priorix2")).toMatchObject({ type: "MMR", section: "MMR" });
  });

  it("falls back to 'Other' (sorted last, section 'Other', no age) for an unrecognized short code", () => {
    const result = lookupMacroCatalog("somethingbrandnew");
    expect(result.type).toBe("Other");
    expect(result.sheetOrder).toBe(MACRO_CATALOG_OTHER_ORDER);
    expect(result.section).toBe("Other");
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
