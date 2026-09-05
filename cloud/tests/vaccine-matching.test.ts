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

  // Review fix (2026-09-05): a "covid"/"covid pfizer"/"covid moderna" ->
  // catalog-product alias set briefly lived in this SHARED table so
  // app/api/ordering/recommendation/route.ts could resolve an aggregated
  // COVID appointment composite. That was wrong — this table is also
  // consulted by lib/on-hand-parser.ts for real free-text on-hand-count
  // emails, and a manually-typed "COVID: 40" line has no way to know
  // whether Will means Comirnaty or mNEXSPIKE. That resolution now lives
  // ONLY in the ordering route's own COMPOSITE_BASE_TO_CATALOG_NAME —
  // these brand-only composite-base strings must NOT resolve here.
  it("does NOT match the brand-only composite-base strings the ordering route strips COVID composites down to (that resolution is route-local, not shared)", () => {
    expect(matchVaccineName("COVID Pfizer", CATALOG)).toBeNull();
    expect(matchVaccineName("COVID Moderna", CATALOG)).toBeNull();
    expect(matchVaccineName("COVID", CATALOG)).toBeNull();
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
