import { describe, expect, it } from "vitest";
import {
  GROUP_DISPLAY_ORDER,
  OTHER_GROUP,
  availableGroupsFor,
  getVaccineGroup,
} from "@/lib/vaccine-group-catalog";

describe("getVaccineGroup", () => {
  it("matches known prefixes case-insensitively", () => {
    expect(getVaccineGroup("Comirnaty 2025-26 12+")).toBe("COVID");
    expect(getVaccineGroup("mnexspike")).toBe("COVID");
    expect(getVaccineGroup("FLUZONE HD")).toBe("Flu");
    expect(getVaccineGroup("Shingrix")).toBe("Shingles");
    expect(getVaccineGroup("Gardasil 9")).toBe("HPV");
  });

  it("matches by substring, not exact equality", () => {
    expect(getVaccineGroup("Engerix 20 (age 20+)")).toBe("Hep B");
    expect(getVaccineGroup("FluMist (age 2-49)")).toBe("Flu");
  });

  it("falls back to Other for an unmapped name", () => {
    expect(getVaccineGroup("Some New Vaccine")).toBe(OTHER_GROUP);
  });

  it("falls back to Other for null/undefined/empty", () => {
    expect(getVaccineGroup(null)).toBe(OTHER_GROUP);
    expect(getVaccineGroup(undefined)).toBe(OTHER_GROUP);
    expect(getVaccineGroup("")).toBe(OTHER_GROUP);
  });
});

describe("availableGroupsFor", () => {
  it("returns only groups present, in GROUP_DISPLAY_ORDER order", () => {
    const names = ["Shingrix", "Comirnaty 2025-26 12+", "Some New Vaccine"];
    expect(availableGroupsFor(names)).toEqual(["COVID", "Shingles", OTHER_GROUP]);
  });

  it("returns an empty list for no names", () => {
    expect(availableGroupsFor([])).toEqual([]);
  });

  it("never returns a group not in GROUP_DISPLAY_ORDER", () => {
    const names = ["Comirnaty", "Fluzone", "Gardasil", "Shingrix"];
    for (const group of availableGroupsFor(names)) {
      expect(GROUP_DISPLAY_ORDER).toContain(group);
    }
  });
});
