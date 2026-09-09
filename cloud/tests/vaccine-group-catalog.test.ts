import { describe, expect, it } from "vitest";
import {
  GROUP_DISPLAY_ORDER,
  OTHER_GROUP,
  PHYSICIANS_COVID_GROUP,
  PHYSICIANS_FLU_GROUP,
  PHYSICIANS_GROUP_DISPLAY_ORDER,
  PHYSICIANS_OTHER_GROUP,
  availableGroupsFor,
  availablePhysiciansGroupsFor,
  getPhysiciansGroup,
  getVaccineGroup,
  persistedGroupForPhysiciansGroup,
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

  it("resolves a prefix collision by first-mapping-wins, not by position in the name", () => {
    // Synthetic name — no real formulary row matches two prefixes today —
    // but this locks in the "first mapping in the list wins" rule (mirrors
    // the desktop's foreach-return-on-first-match) rather than, say, the
    // LONGEST match or whichever prefix appears earliest IN THE STRING.
    // "Shingrix" (Shingles, listed after COVID in MAPPINGS) appears before
    // "Comirnaty" (COVID, listed first) in the string, yet COVID still wins.
    expect(getVaccineGroup("Shingrix Comirnaty Combo (synthetic collision test)")).toBe("COVID");
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

// V-T21 item 7: the Physicians-tab-only 3-bucket grouping layered
// additively on top of the fine-grained groups above (which stay
// untouched — see the describe blocks above, still passing unmodified).
describe("getPhysiciansGroup", () => {
  it("buckets Flu-group vaccines into 'Flu vaccines'", () => {
    expect(getPhysiciansGroup("Fluzone HD")).toBe(PHYSICIANS_FLU_GROUP);
    expect(getPhysiciansGroup("FluMist (age 2-49)")).toBe(PHYSICIANS_FLU_GROUP);
  });

  it("buckets COVID-group vaccines into 'COVID vaccines'", () => {
    expect(getPhysiciansGroup("Comirnaty 2025-26 12+")).toBe(PHYSICIANS_COVID_GROUP);
    expect(getPhysiciansGroup("mnexspike")).toBe(PHYSICIANS_COVID_GROUP);
  });

  it("buckets every other group (including the fine-grained Other) into 'Other vaccines'", () => {
    expect(getPhysiciansGroup("Boostrix")).toBe(PHYSICIANS_OTHER_GROUP); // Tetanus/whooping cough
    expect(getPhysiciansGroup("Shingrix")).toBe(PHYSICIANS_OTHER_GROUP); // Shingles
    expect(getPhysiciansGroup("Gardasil 9")).toBe(PHYSICIANS_OTHER_GROUP); // HPV
    expect(getPhysiciansGroup("Some New Vaccine")).toBe(PHYSICIANS_OTHER_GROUP); // fine-grained Other
    expect(getPhysiciansGroup(null)).toBe(PHYSICIANS_OTHER_GROUP);
  });
});

describe("availablePhysiciansGroupsFor", () => {
  it("returns only the 3 buckets present, in Flu/COVID/Other order regardless of input order", () => {
    const names = ["Boostrix", "Comirnaty 2025-26 12+", "Fluzone HD"];
    expect(availablePhysiciansGroupsFor(names)).toEqual([
      PHYSICIANS_FLU_GROUP,
      PHYSICIANS_COVID_GROUP,
      PHYSICIANS_OTHER_GROUP,
    ]);
  });

  it("omits a bucket with nothing in it", () => {
    expect(availablePhysiciansGroupsFor(["Boostrix", "Shingrix"])).toEqual([PHYSICIANS_OTHER_GROUP]);
  });

  it("never returns a group not in PHYSICIANS_GROUP_DISPLAY_ORDER", () => {
    for (const group of availablePhysiciansGroupsFor(["Comirnaty", "Fluzone", "Gardasil"])) {
      expect(PHYSICIANS_GROUP_DISPLAY_ORDER).toContain(group);
    }
  });
});

describe("persistedGroupForPhysiciansGroup", () => {
  it("maps Flu/COVID display groups back to the fine-grained persisted value", () => {
    expect(persistedGroupForPhysiciansGroup(PHYSICIANS_FLU_GROUP)).toBe("Flu");
    expect(persistedGroupForPhysiciansGroup(PHYSICIANS_COVID_GROUP)).toBe("COVID");
  });

  it("returns null for 'Other vaccines' — no wildcard rule option for that bucket", () => {
    expect(persistedGroupForPhysiciansGroup(PHYSICIANS_OTHER_GROUP)).toBeNull();
  });
});
