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
});
