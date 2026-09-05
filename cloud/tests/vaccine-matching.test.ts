import { describe, expect, it } from "vitest";
import { matchVaccineName, type CatalogVaccine } from "@/lib/vaccine-matching";

const CATALOG: CatalogVaccine[] = [
  { id: "v-comirnaty", name: "Comirnaty 2025-26 12+", short_code: "pfizer12" },
  { id: "v-flu", name: "Flu Quad 2025-26", short_code: "fluquad" },
  { id: "v-mmr", name: "MMR-II", short_code: "mmrii" },
  { id: "v-mnexspike", name: "mNEXSPIKE", short_code: "mnexspike" },
  { id: "v-flumist", name: "FluMist (age 2-49)", short_code: "flumist" },
  { id: "v-shingrix", name: "Shingrix", short_code: "shingrix1" },
];

describe("matchVaccineName", () => {
  it("matches an exact (case-sensitive) catalog name", () => {
    expect(matchVaccineName("Shingrix", CATALOG)?.id).toBe("v-shingrix");
  });

  it("matches case-insensitively", () => {
    expect(matchVaccineName("shingrix", CATALOG)?.id).toBe("v-shingrix");
    expect(matchVaccineName("SHINGRIX", CATALOG)?.id).toBe("v-shingrix");
  });

  it("matches via the alias table for a known naming variant (Pfizer 12+ -> Comirnaty 2025-26 12+)", () => {
    expect(matchVaccineName("Pfizer 12+", CATALOG)?.id).toBe("v-comirnaty");
  });

  it("matches via the alias table (MMR -> MMR-II)", () => {
    expect(matchVaccineName("MMR", CATALOG)?.id).toBe("v-mmr");
  });

  it("matches via the alias table (Moderna 12+ NEXSPIKE -> mNEXSPIKE)", () => {
    expect(matchVaccineName("Moderna 12+ NEXSPIKE", CATALOG)?.id).toBe("v-mnexspike");
  });

  // V-T-schedule-table ROUND 2 follow-up (Will 2026-09-05): brand-only,
  // age-stripped forms produced by compositeNameToMatchableBase
  // (lib/appointment-table.ts) for an aggregated COVID appointment count.
  it("matches via the alias table (COVID Pfizer -> Comirnaty 2025-26 12+)", () => {
    expect(matchVaccineName("COVID Pfizer", CATALOG)?.id).toBe("v-comirnaty");
  });

  it("matches via the alias table (COVID Moderna -> mNEXSPIKE)", () => {
    expect(matchVaccineName("COVID Moderna", CATALOG)?.id).toBe("v-mnexspike");
  });

  it("matches the brandless 'COVID' composite base via the alias table (documented ambiguous default)", () => {
    expect(matchVaccineName("COVID", CATALOG)?.id).toBe("v-comirnaty");
  });

  it("matches via the alias table (FluMist -> FluMist (age 2-49))", () => {
    expect(matchVaccineName("FluMist", CATALOG)?.id).toBe("v-flumist");
  });

  it("matches a catalog short_code", () => {
    expect(matchVaccineName("fluquad", CATALOG)?.id).toBe("v-flu");
  });

  it("matches a raw name that's a superstring of a shorter catalog name via contains", () => {
    expect(matchVaccineName("Flu Quad 2025-26 (booster)", CATALOG)?.id).toBe("v-flu");
  });

  it("returns null (not a throw) when nothing matches", () => {
    expect(matchVaccineName("Some Totally Unknown Vaccine", CATALOG)).toBeNull();
  });

  it("returns null for an empty/whitespace-only name", () => {
    expect(matchVaccineName("   ", CATALOG)).toBeNull();
    expect(matchVaccineName("", CATALOG)).toBeNull();
  });
});
