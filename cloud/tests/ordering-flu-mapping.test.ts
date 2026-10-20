import { describe, expect, it } from "vitest";
import { matchFluAgeBandToVaccine, type FluMappingCatalogVaccine } from "@/lib/ordering-flu-mapping";

describe("matchFluAgeBandToVaccine", () => {
  const catalog: FluMappingCatalogVaccine[] = [
    { id: "v-flucelvax-pfs", name: "Flucelvax PFS", active: true },
    { id: "v-flucelvax-mdv", name: "Flucelvax MDV", active: true },
    { id: "v-fluad", name: "Fluad", active: true },
    { id: "v-afluria", name: "Afluria PFS", active: false },
  ];

  it("65+ resolves to Fluad", () => {
    const match = matchFluAgeBandToVaccine("65+", catalog);
    expect(match?.id).toBe("v-fluad");
  });

  it("65+ returns null when Fluad isn't active/on file", () => {
    const withoutFluad = catalog.filter((v) => v.name !== "Fluad");
    expect(matchFluAgeBandToVaccine("65+", withoutFluad)).toBeNull();
  });

  it("3-64 resolves to the active Flucelvax PFS product", () => {
    const match = matchFluAgeBandToVaccine("3-64", catalog);
    expect(match?.id).toBe("v-flucelvax-pfs");
  });

  it("3-64 falls back to any OTHER active flu product (not Fluad) when Flucelvax PFS is inactive", () => {
    const withInactiveFlucelvax: FluMappingCatalogVaccine[] = [
      { id: "v-flucelvax-pfs", name: "Flucelvax PFS", active: false },
      { id: "v-flucelvax-mdv", name: "Flucelvax MDV", active: true },
      { id: "v-fluad", name: "Fluad", active: true },
    ];
    const match = matchFluAgeBandToVaccine("3-64", withInactiveFlucelvax);
    expect(match?.id).toBe("v-flucelvax-mdv");
  });

  it("3-64 fallback never picks Fluad (65+-only)", () => {
    const onlyFluad: FluMappingCatalogVaccine[] = [{ id: "v-fluad", name: "Fluad", active: true }];
    expect(matchFluAgeBandToVaccine("3-64", onlyFluad)).toBeNull();
  });

  it("3-64 returns null when no flu product is active at all", () => {
    const allInactive: FluMappingCatalogVaccine[] = [
      { id: "v-flucelvax-pfs", name: "Flucelvax PFS", active: false },
      { id: "v-fluad", name: "Fluad", active: false },
    ];
    expect(matchFluAgeBandToVaccine("3-64", allInactive)).toBeNull();
  });

  it("'unknown' band has no product-level mapping — returns null", () => {
    expect(matchFluAgeBandToVaccine("unknown", catalog)).toBeNull();
  });

  it("Flucelvax PFS match is exact-name, not substring — 'Flucelvax MDV' never satisfies the 3-64 primary rule", () => {
    const onlyMdv: FluMappingCatalogVaccine[] = [{ id: "v-flucelvax-mdv", name: "Flucelvax MDV", active: true }];
    // Primary rule (exact "Flucelvax PFS") misses, but the general
    // fallback (any active non-Fluad flu product) still finds MDV.
    const match = matchFluAgeBandToVaccine("3-64", onlyMdv);
    expect(match?.id).toBe("v-flucelvax-mdv");
  });

  describe("V-Q11 (2026-10-20): 50-64 orders mFLUSIVA", () => {
    const withMflusiva: FluMappingCatalogVaccine[] = [
      { id: "v-flucelvax-pfs", name: "Flucelvax PFS", active: true },
      { id: "v-mflusiva", name: "mFLUSIVA 2026-27", active: true },
      { id: "v-fluad", name: "Fluad", active: true },
    ];

    it("3-49 resolves to Flucelvax PFS", () => {
      expect(matchFluAgeBandToVaccine("3-49", withMflusiva)?.id).toBe("v-flucelvax-pfs");
    });

    it("50-64 resolves to the active mFLUSIVA product (season suffix ignored)", () => {
      expect(matchFluAgeBandToVaccine("50-64", withMflusiva)?.id).toBe("v-mflusiva");
    });

    it("65+ still resolves to Fluad", () => {
      expect(matchFluAgeBandToVaccine("65+", withMflusiva)?.id).toBe("v-fluad");
    });

    it("50-64 returns null when mFLUSIVA is inactive or not on file (never Flucelvax or Fluad)", () => {
      const inactive = withMflusiva.map((v) => (v.id === "v-mflusiva" ? { ...v, active: false } : v));
      expect(matchFluAgeBandToVaccine("50-64", inactive)).toBeNull();
      expect(matchFluAgeBandToVaccine("50-64", withMflusiva.filter((v) => v.id !== "v-mflusiva"))).toBeNull();
    });

    it("3-49 fallback never lands on mFLUSIVA or Fluad", () => {
      const onlyNewer: FluMappingCatalogVaccine[] = [
        { id: "v-mflusiva", name: "mFLUSIVA 2026-27", active: true },
        { id: "v-fluad", name: "Fluad", active: true },
      ];
      expect(matchFluAgeBandToVaccine("3-49", onlyNewer)).toBeNull();
    });

    it("the legacy cached '3-64' band keeps resolving to Flucelvax PFS", () => {
      expect(matchFluAgeBandToVaccine("3-64", withMflusiva)?.id).toBe("v-flucelvax-pfs");
    });

    it("'unknown' still has no product-level mapping", () => {
      expect(matchFluAgeBandToVaccine("unknown", withMflusiva)).toBeNull();
    });
  });
});
