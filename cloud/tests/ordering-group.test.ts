import { describe, expect, it } from "vitest";
import { ORDERING_GROUP_DISPLAY_ORDER, getOrderingGroup } from "@/lib/ordering-group";

describe("ORDERING_GROUP_DISPLAY_ORDER", () => {
  it("is exactly COVID, Flu, Other, in that order, with no duplicates", () => {
    expect(ORDERING_GROUP_DISPLAY_ORDER).toEqual(["COVID", "Flu", "Other"]);
    expect(new Set(ORDERING_GROUP_DISPLAY_ORDER).size).toBe(ORDERING_GROUP_DISPLAY_ORDER.length);
  });
});

describe("getOrderingGroup", () => {
  it("keeps COVID vaccines in their own heading", () => {
    expect(getOrderingGroup("Comirnaty 2025-26 12+")).toBe("COVID");
    expect(getOrderingGroup("Spikevax")).toBe("COVID");
  });

  it("keeps Flu vaccines in their own heading", () => {
    expect(getOrderingGroup("Fluzone PFS")).toBe("Flu");
    expect(getOrderingGroup("Afluria MDV")).toBe("Flu");
  });

  it("collapses every other fine-grained group into Other", () => {
    expect(getOrderingGroup("Gardasil")).toBe("Other"); // fine-grained "HPV"
    expect(getOrderingGroup("Shingrix")).toBe("Other"); // fine-grained "Shingles"
    expect(getOrderingGroup("Prevnar 20")).toBe("Other"); // fine-grained "Pneumonia"
    expect(getOrderingGroup("Menveo")).toBe("Other"); // fine-grained "Meningitis"
  });

  it("collapses a name matching none of the fine-grained groups (the fine catalog's own Other) into Other", () => {
    expect(getOrderingGroup("Pfizer 3-4")).toBe("Other");
    expect(getOrderingGroup("Pfizer 5-11")).toBe("Other");
  });

  it("handles null/undefined the same as the fine-grained catalog does", () => {
    expect(getOrderingGroup(null)).toBe("Other");
    expect(getOrderingGroup(undefined)).toBe("Other");
  });
});
