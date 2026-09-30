import { describe, expect, it } from "vitest";
import { chooseCollapsedName, collapseVaccinesByNdc, stripDoseMarker, type CollapsibleVaccine } from "@/lib/ordering-ndc-collapse";

describe("stripDoseMarker", () => {
  it("strips a trailing '(N of M)' marker", () => {
    expect(stripDoseMarker("Shingrix (2 of 2)")).toBe("Shingrix");
  });

  it("strips a trailing '#N' marker", () => {
    expect(stripDoseMarker("Gardasil #3")).toBe("Gardasil");
  });

  it("strips a trailing 'dose N' marker", () => {
    expect(stripDoseMarker("Shingrix dose 2")).toBe("Shingrix");
  });

  it("leaves a name with no dose marker unchanged", () => {
    expect(stripDoseMarker("Gardasil")).toBe("Gardasil");
  });
});

describe("chooseCollapsedName", () => {
  it("uses the single common name when every raw name is identical (the real seed-data shape — Gardasil x3)", () => {
    expect(chooseCollapsedName(["Gardasil", "Gardasil", "Gardasil"])).toBe("Gardasil");
  });

  it("uses the common name once dose markers are stripped", () => {
    expect(chooseCollapsedName(["Shingrix dose 1", "Shingrix dose 2"])).toBe("Shingrix");
  });

  it("falls back to the shortest stripped name when they still disagree", () => {
    expect(chooseCollapsedName(["Comirnaty 2025-26 12+", "Comirnaty"])).toBe("Comirnaty");
  });

  it("returns '' for an empty input", () => {
    expect(chooseCollapsedName([])).toBe("");
  });
});

describe("collapseVaccinesByNdc", () => {
  it("collapses a real-shaped 3-dose series (Gardasil) sharing one NDC into a single group", () => {
    const catalog: CollapsibleVaccine[] = [
      { id: "v1", name: "Gardasil", ndc: "00006-4121-02", active: true },
      { id: "v2", name: "Gardasil", ndc: "00006-4121-02", active: true },
      { id: "v3", name: "Gardasil", ndc: "00006-4121-02", active: true },
    ];
    const groups = collapseVaccinesByNdc(catalog);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      key: "00006412102",
      ndc: "00006412102",
      vaccineName: "Gardasil",
      active: true,
      vaccineIds: ["v1", "v2", "v3"],
    });
  });

  it("never collapses two null-NDC vaccines together, even with the same name", () => {
    const catalog: CollapsibleVaccine[] = [
      { id: "v1", name: "Priorix", ndc: null, active: true },
      { id: "v2", name: "Priorix", ndc: null, active: true },
    ];
    const groups = collapseVaccinesByNdc(catalog);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.key)).toEqual(["vaccine:v1", "vaccine:v2"]);
  });

  // V-T66 round 3 (reviewer REQUEST_CHANGES 2026-09-30): this is the
  // ORIGINAL test, restored — round 2 briefly flipped it to "merges" for
  // ANY same-name pair, which the reviewer correctly flagged as broader
  // than Ordering has ever allowed (this file's own header quotes Will's
  // rule, be8b2e7: "Each one in the ordering recommendations queue
  // should be for the product itself, NDC specific"). Afluria has no
  // lib/canonical-ndc.ts CANONICAL_NDC entry, so two rows that merely
  // share its name but carry genuinely different NDCs (two package
  // sizes) stay separate — only a CANONICAL_NDC-vetted name (Shingrix,
  // see the tests below) merges across mismatched NDCs.
  it("keeps two different NDCs separate even with an identical name", () => {
    const catalog: CollapsibleVaccine[] = [
      { id: "v1", name: "Afluria 2025-2026 Syr (3yr Up)", ndc: "33332-0025-03", active: true },
      { id: "v2", name: "Afluria 2025-2026 Syr (3yr Up)", ndc: "33332-0025-04", active: true },
    ];
    const groups = collapseVaccinesByNdc(catalog);
    expect(groups).toHaveLength(2);
  });

  it("active is true if ANY constituent vaccine is active", () => {
    const catalog: CollapsibleVaccine[] = [
      { id: "v1", name: "Gardasil", ndc: "00006-4121-02", active: false },
      { id: "v2", name: "Gardasil", ndc: "00006-4121-02", active: true },
    ];
    const groups = collapseVaccinesByNdc(catalog);
    expect(groups[0].active).toBe(true);
  });

  it("dashed and undashed NDCs normalize to the same group", () => {
    const catalog: CollapsibleVaccine[] = [
      { id: "v1", name: "Fluad", ndc: "70461-0123-03", active: true },
      { id: "v2", name: "Fluad", ndc: "70461012303", active: true },
    ];
    const groups = collapseVaccinesByNdc(catalog);
    expect(groups).toHaveLength(1);
  });

  // V-T26 followups (Will 2026-09-09 — live bug: "Vaqta (adult)" showed
  // up TWICE on /ordering) — a null-NDC dose row now joins its
  // NDC-bearing sibling by (stripped, case-insensitive) name, mirroring
  // lib/lots-grouping.ts's groupVaccinesIntoProducts rule for the same
  // mixed NDC/no-NDC series shape.
  it("joins a null-NDC dose row to its NDC-bearing sibling by name (Vaqta adult dose 1 + dose 2)", () => {
    const catalog: CollapsibleVaccine[] = [
      { id: "v-vaqta1", name: "Vaqta adult", ndc: "00006-4096-02", active: true },
      { id: "v-vaqta2", name: "Vaqta adult", ndc: null, active: true },
    ];
    const groups = collapseVaccinesByNdc(catalog);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      key: "00006409602",
      ndc: "00006409602",
      vaccineName: "Vaqta adult",
      active: true,
      vaccineIds: ["v-vaqta1", "v-vaqta2"],
    });
  });

  it("still joins by name when the null-NDC dose row appears BEFORE its NDC-bearing sibling in catalog order", () => {
    const catalog: CollapsibleVaccine[] = [
      { id: "v-vaqta2", name: "Vaqta adult", ndc: null, active: true },
      { id: "v-vaqta1", name: "Vaqta adult", ndc: "00006-4096-02", active: true },
    ];
    const groups = collapseVaccinesByNdc(catalog);
    expect(groups).toHaveLength(1);
    expect(groups[0].vaccineIds).toEqual(["v-vaqta1", "v-vaqta2"]); // NDC-bearing row still placed first (pass 1)
  });

  it("matches the sibling name case-insensitively and after stripping a dose marker", () => {
    const catalog: CollapsibleVaccine[] = [
      { id: "v1", name: "Engerix 20 (age 20+)", ndc: "58160-0821-52", active: true },
      { id: "v2", name: "engerix 20 (age 20+) dose 2", ndc: null, active: true },
    ];
    const groups = collapseVaccinesByNdc(catalog);
    expect(groups).toHaveLength(1);
    expect(groups[0].vaccineIds).toEqual(["v1", "v2"]);
  });

  it("a null-NDC row with NO NDC-bearing sibling of the same name still gets its own vaccine:<id> row (unchanged)", () => {
    const catalog: CollapsibleVaccine[] = [
      { id: "v1", name: "Vaqta adult", ndc: "00006-4096-02", active: true },
      { id: "v2", name: "Some Unrelated Product", ndc: null, active: true },
    ];
    const groups = collapseVaccinesByNdc(catalog);
    expect(groups).toHaveLength(2);
    const unrelated = groups.find((g) => g.vaccineName === "Some Unrelated Product");
    expect(unrelated).toMatchObject({ key: "vaccine:v2", ndc: null });
  });

  it("a null-NDC dose row inherits `active` correctly after joining its NDC sibling's group", () => {
    const catalog: CollapsibleVaccine[] = [
      { id: "v1", name: "Vaqta adult", ndc: "00006-4096-02", active: false },
      { id: "v2", name: "Vaqta adult", ndc: null, active: true },
    ];
    const groups = collapseVaccinesByNdc(catalog);
    expect(groups).toHaveLength(1);
    expect(groups[0].active).toBe(true); // ANY member active (dose 2) keeps the group active
  });

  // --- V-T66 round 2 (reviewer finding 2026-09-30: the lots-page
  // Shingrix fix didn't reach Ordering — Shingrix's two dose rows carry
  // DIFFERENT, both non-null, NDCs, so Ordering showed two Shingrix
  // rows). Mirrors tests/lots-grouping.test.ts's equivalent cases. ---
  it("merges Shingrix's two mismatched-NDC dose rows into one Ordering group, using the CANONICAL_NDC override as primary", () => {
    const catalog: CollapsibleVaccine[] = [
      { id: "sh1", name: "Shingrix", ndc: "58160-0823-11", active: true },
      { id: "sh2", name: "Shingrix", ndc: "58160-0849-52", active: true },
    ];
    const groups = collapseVaccinesByNdc(catalog);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      key: "58160084952",
      ndc: "58160084952",
      vaccineName: "Shingrix",
      vaccineIds: ["sh1", "sh2"],
    });
  });

  it("merges Shingrix's mismatched-NDC dose rows regardless of catalog order (order-independent)", () => {
    const rowsFirstOrder: CollapsibleVaccine[] = [
      { id: "sh1", name: "Shingrix", ndc: "58160-0823-11", active: true },
      { id: "sh2", name: "Shingrix", ndc: "58160-0849-52", active: true },
    ];
    const rowsSecondOrder: CollapsibleVaccine[] = [
      { id: "sh2", name: "Shingrix", ndc: "58160-0849-52", active: true },
      { id: "sh1", name: "Shingrix", ndc: "58160-0823-11", active: true },
    ];
    const [groupFirst] = collapseVaccinesByNdc(rowsFirstOrder);
    const [groupSecond] = collapseVaccinesByNdc(rowsSecondOrder);
    expect(groupFirst.key).toBe(groupSecond.key);
    expect(groupFirst.ndc).toBe(groupSecond.ndc);
    expect(groupFirst.key).toBe("58160084952");
  });

  it("sums upcoming7d/given7d-style per-vaccine quantities across Shingrix's merged dose rows (the math path route.ts relies on)", () => {
    // Mirrors how app/api/ordering/recommendation/route.ts actually
    // computes upcoming7d/given7d/onHand: sum a per-vaccine-id quantity
    // map over group.vaccineIds. Once both dose rows land in one group
    // (asserted above), that sum is automatically correct — this test
    // verifies the vaccineIds list is exactly the set route.ts would
    // reduce over, for both the canonical-primary and reversed-order cases.
    const catalog: CollapsibleVaccine[] = [
      { id: "sh1", name: "Shingrix", ndc: "58160-0823-11", active: true },
      { id: "sh2", name: "Shingrix", ndc: "58160-0849-52", active: true },
    ];
    const quantityByVaccineId = new Map([
      ["sh1", 4],
      ["sh2", 7],
    ]);
    const [group] = collapseVaccinesByNdc(catalog);
    const summed = group.vaccineIds.reduce((sum, id) => sum + (quantityByVaccineId.get(id) ?? 0), 0);
    expect(summed).toBe(11);
  });

  it("falls back to the smallest-NDC rule when the canonical value isn't among the group's own recorded NDCs", () => {
    const catalog: CollapsibleVaccine[] = [
      { id: "sh1", name: "Shingrix", ndc: "58160-0823-11", active: true },
      { id: "sh2", name: "Shingrix", ndc: "58160-0821-52", active: true },
    ];
    const groups = collapseVaccinesByNdc(catalog);
    expect(groups).toHaveLength(1);
    expect(groups[0].ndc).toBe("58160082152");
  });

  it("does not steal an unrelated product's own NDC group just because a mismatched-NDC Shingrix row happens to share it", () => {
    const catalog: CollapsibleVaccine[] = [
      { id: "o1", name: "Other Product", ndc: "00003-3333-33", active: true },
      { id: "sh1", name: "Shingrix", ndc: "58160-0823-11", active: true },
      { id: "sh2", name: "Shingrix", ndc: "00003-3333-33", active: true },
    ];
    const groups = collapseVaccinesByNdc(catalog);
    const groupOf = (id: string) => groups.find((g) => g.vaccineIds.includes(id));
    expect(groupOf("o1")).not.toBe(groupOf("sh1"));
    expect(groupOf("o1")?.vaccineIds).toContain("sh2");
  });
});
