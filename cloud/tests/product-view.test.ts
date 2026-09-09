import { describe, expect, it } from "vitest";
import { buildProductViews, deriveProductViewFields } from "@/lib/product-view";
import { ORDERING_GROUP_DISPLAY_ORDER } from "@/lib/ordering-group";

describe("deriveProductViewFields", () => {
  it("uses the DB ndc and flags ndcSource 'db' when the vaccine row has one on file", () => {
    const fields = deriveProductViewFields("Fluad", "70461012303");
    expect(fields.ndc).toBe("70461012303");
    expect(fields.ndcSource).toBe("db");
    expect(fields.packageSize).toBe(10);
  });

  it("falls back to the researched catalog packageNdc, flagged 'catalog', when the DB row has no ndc", () => {
    // "Flucelvax PFS" is seeded with ndc: null (supabase/seed/vaccines.sql)
    // but IS in lib/vaccine-product-catalog.ts's researched CATALOG.
    const fields = deriveProductViewFields("Flucelvax PFS", null);
    expect(fields.ndc).toBe("70461065603"); // normalizeNdc("70461-0656-03")
    expect(fields.ndcSource).toBe("catalog");
    expect(fields.packageSize).toBe(10);
  });

  it("returns ndc: null, ndcSource: null when neither the DB nor the catalog knows the product", () => {
    const fields = deriveProductViewFields("Some Brand-New Vaccine", null);
    expect(fields.ndc).toBeNull();
    expect(fields.ndcSource).toBeNull();
    expect(fields.packageSize).toBeNull();
    expect(fields.displayName).toBe("Some Brand-New Vaccine");
  });

  it("classifies group via lib/ordering-group.ts (COVID/Flu/Other)", () => {
    expect(deriveProductViewFields("Comirnaty 2025-26 12+", null).group).toBe("COVID");
    expect(deriveProductViewFields("Fluad", null).group).toBe("Flu");
    expect(deriveProductViewFields("Shingrix", null).group).toBe("Other");
  });
});

describe("buildProductViews", () => {
  it("a no-NDC dose row joins its named sibling's group (Vaqta adult dose 2 has no ndc)", () => {
    const vaccines = [
      { id: "v-vaqta1", name: "Vaqta adult", ndc: "00006-4096-02", active: true },
      { id: "v-vaqta2", name: "Vaqta adult", ndc: null, active: true },
    ];
    const views = buildProductViews(vaccines);
    expect(views).toHaveLength(1);
    expect(views[0].vaccineIds.sort()).toEqual(["v-vaqta1", "v-vaqta2"]);
    expect(views[0].ndc).toBe("00006409602");
    expect(views[0].ndcSource).toBe("db");
  });

  it("collapses a multi-dose series (Gardasil 1/2/3) sharing one NDC into one product view", () => {
    const vaccines = [
      { id: "v1", name: "Gardasil", ndc: "00006-4121-02", active: true },
      { id: "v2", name: "Gardasil", ndc: "00006-4121-02", active: true },
      { id: "v3", name: "Gardasil", ndc: "00006-4121-02", active: true },
    ];
    const views = buildProductViews(vaccines);
    expect(views).toHaveLength(1);
    expect(views[0].vaccineIds).toHaveLength(3);
    expect(views[0].packageSize).toBe(10);
  });

  it("flags active:true when ANY dose row in the product is active", () => {
    const vaccines = [
      { id: "v1", name: "Engerix 20 (age 20+)", ndc: "58160-0821-52", active: true },
      { id: "v2", name: "Engerix 20 (age 20+)", ndc: "58160-0821-52", active: false },
    ];
    const views = buildProductViews(vaccines);
    expect(views[0].active).toBe(true);
  });

  it("returned views can be grouped/ordered COVID, Flu, Other via lib/ordering-group.ts's display order", () => {
    const vaccines = [
      { id: "v-shingrix", name: "Shingrix", ndc: "58160-0823-11", active: true },
      { id: "v-comirnaty", name: "Comirnaty 2025-26 12+", ndc: "00069-2528-10", active: true },
      { id: "v-fluad", name: "Fluad", ndc: "70461-0123-03", active: true },
    ];
    const views = buildProductViews(vaccines);
    const byGroup = new Map<string, string[]>();
    for (const view of views) {
      const list = byGroup.get(view.group) ?? [];
      list.push(view.displayName);
      byGroup.set(view.group, list);
    }
    const presentGroups = ORDERING_GROUP_DISPLAY_ORDER.filter((g) => byGroup.has(g));
    // COVID, Flu, Other — in that order, each exactly once.
    expect(presentGroups).toEqual(["COVID", "Flu", "Other"]);
    expect(byGroup.get("COVID")?.some((name) => name.includes("Comirnaty"))).toBe(true);
    expect(byGroup.get("Flu")?.some((name) => name.includes("Fluad"))).toBe(true);
    expect(byGroup.get("Other")?.some((name) => name.includes("Shingrix"))).toBe(true);
  });
});
