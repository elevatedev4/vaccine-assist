import { describe, expect, it } from "vitest";
import { dedupeLotsByNumber, formatNdcDisplay, groupVaccinesIntoProducts } from "@/lib/lots-grouping";

describe("groupVaccinesIntoProducts", () => {
  it("groups same-NDC dose rows into one product (Engerix 20, three doses)", () => {
    const vaccines = [
      { id: "e1", name: "Engerix 20 (age 20+)", ndc: "58160-0821-52", active: true },
      { id: "e2", name: "Engerix 20 (age 20+)", ndc: "58160-0821-52", active: true },
      { id: "e3", name: "Engerix 20 (age 20+)", ndc: "58160-0821-52", active: true },
    ];
    const groups = groupVaccinesIntoProducts(vaccines);
    expect(groups).toHaveLength(1);
    expect(groups[0].ndc).toBe("58160082152");
    expect(groups[0].name).toBe("Engerix 20 (age 20+)");
    expect(groups[0].vaccineIds).toEqual(["e1", "e2", "e3"]);
    expect(groups[0].active).toBe(true);
  });

  it("groups Gardasil's three dose rows by NDC", () => {
    const vaccines = [
      { id: "g1", name: "Gardasil", ndc: "00006-4121-02", active: true },
      { id: "g2", name: "Gardasil", ndc: "00006-4121-02", active: true },
      { id: "g3", name: "Gardasil", ndc: "00006-4121-02", active: true },
    ];
    const groups = groupVaccinesIntoProducts(vaccines);
    expect(groups).toHaveLength(1);
    expect(groups[0].vaccineIds).toEqual(["g1", "g2", "g3"]);
  });

  it("takes the FIRST NDC when a row's ndc column holds a comma-separated list", () => {
    const vaccines = [
      { id: "m1", name: "Multi-pack", ndc: "00005-2000-10, 00005-2000-02", active: true },
      { id: "m2", name: "Multi-pack", ndc: "00005-2000-10", active: true },
    ];
    const groups = groupVaccinesIntoProducts(vaccines);
    expect(groups).toHaveLength(1);
    expect(groups[0].ndc).toBe("00005200010");
    expect(groups[0].vaccineIds).toEqual(["m1", "m2"]);
  });

  it("falls back to normalized name when NDC is null, without merging distinct products", () => {
    const vaccines = [
      { id: "a1", name: "Some New Vaccine", ndc: null, active: true },
      { id: "a2", name: "some new vaccine", ndc: null, active: true },
      { id: "b1", name: "Other Vaccine", ndc: null, active: true },
    ];
    const groups = groupVaccinesIntoProducts(vaccines);
    expect(groups).toHaveLength(2);
    const someNew = groups.find((g) => g.vaccineIds.includes("a1"));
    expect(someNew?.vaccineIds).toEqual(["a1", "a2"]);
    expect(someNew?.ndc).toBeNull();
  });

  it("joins a null-NDC dose (Vaqta adult dose 2, no ndc) to its NDC-bearing sibling dose by name", () => {
    const vaccines = [
      { id: "vaqta1", name: "Vaqta adult", ndc: "00006-4831-41", active: true },
      { id: "vaqta2", name: "Vaqta adult", ndc: null, active: true },
    ];
    const groups = groupVaccinesIntoProducts(vaccines);
    expect(groups).toHaveLength(1);
    expect(groups[0].ndc).toBe("00006483141");
    expect(groups[0].vaccineIds).toEqual(["vaqta1", "vaqta2"]);
  });

  it("matches the Vaqta name join case-insensitively and regardless of catalog order", () => {
    const vaccines = [
      { id: "vaqta2", name: "VAQTA Adult", ndc: null, active: true },
      { id: "vaqta1", name: "vaqta adult", ndc: "00006-4831-41", active: true },
    ];
    const groups = groupVaccinesIntoProducts(vaccines);
    expect(groups).toHaveLength(1);
    expect(groups[0].vaccineIds.sort()).toEqual(["vaqta1", "vaqta2"]);
  });

  it("marks a group active if ANY dose row is active", () => {
    const vaccines = [
      { id: "s1", name: "Shingrix", ndc: "58160-0821-52", active: false },
      { id: "s2", name: "Shingrix", ndc: "58160-0821-52", active: true },
    ];
    const groups = groupVaccinesIntoProducts(vaccines);
    expect(groups[0].active).toBe(true);
  });

  it("keeps two different products separate even with identical dose count", () => {
    const vaccines = [
      { id: "m1", name: "MMR-II", ndc: "00006-4681-00", active: true },
      { id: "m2", name: "MMR-II", ndc: "00006-4681-00", active: true },
      { id: "sh1", name: "Shingrix", ndc: "58160-0821-52", active: true },
      { id: "sh2", name: "Shingrix", ndc: "58160-0821-52", active: true },
    ];
    const groups = groupVaccinesIntoProducts(vaccines);
    expect(groups).toHaveLength(2);
  });

  it("returns an empty array for an empty catalog", () => {
    expect(groupVaccinesIntoProducts([])).toEqual([]);
  });
});

describe("formatNdcDisplay", () => {
  it("formats an 11-digit NDC as 5-4-2 with dashes", () => {
    expect(formatNdcDisplay("58160082152")).toBe("58160-0821-52");
    expect(formatNdcDisplay("00006412102")).toBe("00006-4121-02");
  });

  it("returns an em dash for null", () => {
    expect(formatNdcDisplay(null)).toBe("—");
  });

  it("shows a non-11-digit value plain rather than guessing at segmentation", () => {
    expect(formatNdcDisplay("123456789")).toBe("123456789");
  });
});

describe("dedupeLotsByNumber", () => {
  it("collapses identical lot_number entries across dose rows to one, first-occurrence wins", () => {
    const lots = [
      { id: "l1", vaccine_id: "e1", lot_number: "ABC123" },
      { id: "l2", vaccine_id: "e2", lot_number: "ABC123" },
      { id: "l3", vaccine_id: "e3", lot_number: "ABC123" },
    ];
    const deduped = dedupeLotsByNumber(lots);
    expect(deduped).toEqual([{ id: "l1", vaccine_id: "e1", lot_number: "ABC123" }]);
  });

  it("treats lot_number case/whitespace-insensitively", () => {
    const lots = [
      { id: "l1", vaccine_id: "e1", lot_number: "abc123" },
      { id: "l2", vaccine_id: "e2", lot_number: " ABC123 " },
    ];
    expect(dedupeLotsByNumber(lots)).toEqual([{ id: "l1", vaccine_id: "e1", lot_number: "abc123" }]);
  });

  it("keeps genuinely distinct lot numbers separate", () => {
    const lots = [
      { id: "l1", vaccine_id: "e1", lot_number: "ABC123" },
      { id: "l2", vaccine_id: "e1", lot_number: "XYZ789" },
    ];
    expect(dedupeLotsByNumber(lots)).toHaveLength(2);
  });

  it("returns an empty array for no lots", () => {
    expect(dedupeLotsByNumber([])).toEqual([]);
  });
});
