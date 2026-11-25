import { describe, expect, it } from "vitest";
import {
  DEFAULT_PREFERRED_COVID,
  PREFERRED_COVID_KIDS511_OPTIONS,
  isValidPreferredCovid,
  normalizePreferredCovid,
  preferredCovidForAge,
} from "@/lib/preferred-covid";

describe("DEFAULT_PREFERRED_COVID", () => {
  it("is Pfizer for 12+, Pfizer 5-11 for 5-11 and Moderna (kids) for 3-4", () => {
    expect(DEFAULT_PREFERRED_COVID).toEqual({ adult: "pfizer", kids: "moderna", kids511: "pfizer" });
  });
});

describe("normalizePreferredCovid (settings fallback)", () => {
  it("falls back to the defaults when nothing is stored", () => {
    expect(normalizePreferredCovid(undefined)).toEqual(DEFAULT_PREFERRED_COVID);
    expect(normalizePreferredCovid(null)).toEqual(DEFAULT_PREFERRED_COVID);
    expect(normalizePreferredCovid("pfizer")).toEqual(DEFAULT_PREFERRED_COVID);
    expect(normalizePreferredCovid(42)).toEqual(DEFAULT_PREFERRED_COVID);
  });

  it("keeps a valid stored value", () => {
    expect(normalizePreferredCovid({ adult: "moderna", kids: "moderna", kids511: "moderna" })).toEqual({
      adult: "moderna",
      kids: "moderna",
      kids511: "moderna",
    });
  });

  it("defaults each part independently", () => {
    expect(normalizePreferredCovid({ adult: "moderna" })).toEqual({ adult: "moderna", kids: "moderna", kids511: "pfizer" });
    expect(normalizePreferredCovid({ adult: "novavax", kids: "pfizer" })).toEqual(DEFAULT_PREFERRED_COVID);
    expect(normalizePreferredCovid({ kids: "moderna" })).toEqual(DEFAULT_PREFERRED_COVID);
    expect(normalizePreferredCovid({ kids511: "moderna" })).toEqual({ ...DEFAULT_PREFERRED_COVID, kids511: "moderna" });
    expect(normalizePreferredCovid({ kids511: "novavax" })).toEqual(DEFAULT_PREFERRED_COVID);
  });

  it("an OLD saved value (before the 5-11 choice existed) still parses and gets the new default for 5-11", () => {
    const oldStored = JSON.parse('{"adult":"pfizer","kids":"moderna"}');
    expect(isValidPreferredCovid(oldStored)).toBe(true);
    expect(normalizePreferredCovid(oldStored)).toEqual({ adult: "pfizer", kids: "moderna", kids511: "pfizer" });
    const oldModerna = JSON.parse('{"adult":"moderna","kids":"moderna"}');
    expect(isValidPreferredCovid(oldModerna)).toBe(true);
    expect(normalizePreferredCovid(oldModerna)).toEqual({ adult: "moderna", kids: "moderna", kids511: "pfizer" });
  });
});

describe("isValidPreferredCovid", () => {
  it("requires adult and kids to be valid, and kids511 to be valid when present", () => {
    expect(isValidPreferredCovid({ adult: "pfizer", kids: "moderna" })).toBe(true);
    expect(isValidPreferredCovid({ adult: "moderna", kids: "moderna" })).toBe(true);
    expect(isValidPreferredCovid({ adult: "pfizer", kids: "moderna", kids511: "pfizer" })).toBe(true);
    expect(isValidPreferredCovid({ adult: "pfizer", kids: "moderna", kids511: "moderna" })).toBe(true);
    expect(isValidPreferredCovid({ adult: "pfizer", kids: "moderna", kids511: "novavax" })).toBe(false);
    expect(isValidPreferredCovid({ adult: "pfizer", kids: "moderna", kids511: null })).toBe(false);
    expect(isValidPreferredCovid({ adult: "pfizer" })).toBe(false);
    expect(isValidPreferredCovid({ adult: "pfizer", kids: "pfizer" })).toBe(false);
    expect(isValidPreferredCovid(null)).toBe(false);
  });
});

describe("PREFERRED_COVID_KIDS511_OPTIONS", () => {
  it("offers Pfizer 5-11 (comirnaty511, first) and Moderna 3-11 (spikevax6mo11)", () => {
    expect(PREFERRED_COVID_KIDS511_OPTIONS).toEqual([
      { value: "pfizer", label: "Pfizer 5-11", shortCode: "comirnaty511" },
      { value: "moderna", label: "Moderna 3-11", shortCode: "spikevax6mo11" },
    ]);
  });
});

describe("preferredCovidForAge", () => {
  it.each([
    [2, null],
    [3, "spikevax6mo11"],
    [4, "spikevax6mo11"],
    [5, "comirnaty511"],
    [8, "comirnaty511"],
    [11, "comirnaty511"],
    [12, "comirnaty12"],
    [49, "comirnaty12"],
    [50, "comirnaty12"],
    [64, "comirnaty12"],
    [65, "comirnaty12"],
    [100, "comirnaty12"],
  ])("default setting, age %s -> %s", (age, code) => {
    expect(preferredCovidForAge(age)?.shortCode ?? null).toBe(code);
  });

  it("follows the 12+ choice (Moderna -> mNEXSPIKE) without touching the kids bands", () => {
    const setting = { adult: "moderna", kids: "moderna", kids511: "pfizer" } as const;
    expect(preferredCovidForAge(12, setting)).toEqual({ band: "12+", label: "Moderna 12+", shortCode: "mnexspike" });
    expect(preferredCovidForAge(11, setting)).toEqual({ band: "5-11", label: "Pfizer 5-11", shortCode: "comirnaty511" });
    expect(preferredCovidForAge(4, setting)).toEqual({ band: "3-4", label: "Moderna 3-11", shortCode: "spikevax6mo11" });
  });

  it("follows the 5-11 choice (Moderna 3-11) for ages 5 through 11 only", () => {
    const setting = { adult: "pfizer", kids: "moderna", kids511: "moderna" } as const;
    expect(preferredCovidForAge(5, setting)).toEqual({ band: "5-11", label: "Moderna 3-11", shortCode: "spikevax6mo11" });
    expect(preferredCovidForAge(11, setting)).toEqual({ band: "5-11", label: "Moderna 3-11", shortCode: "spikevax6mo11" });
    expect(preferredCovidForAge(12, setting)?.shortCode).toBe("comirnaty12");
    expect(preferredCovidForAge(4, setting)?.shortCode).toBe("spikevax6mo11");
  });

  it("an old saved setting with no kids511 picks Pfizer 5-11 for 5-11 (the new default)", () => {
    const oldStored = { adult: "pfizer", kids: "moderna" } as const;
    expect(preferredCovidForAge(5, oldStored)?.shortCode).toBe("comirnaty511");
    expect(preferredCovidForAge(11, oldStored)?.shortCode).toBe("comirnaty511");
    expect(preferredCovidForAge(4, oldStored)?.shortCode).toBe("spikevax6mo11");
    expect(preferredCovidForAge(12, oldStored)?.shortCode).toBe("comirnaty12");
  });

  it("labels each band with the product names the catalog uses", () => {
    expect(preferredCovidForAge(30)).toEqual({ band: "12+", label: "Pfizer 12+", shortCode: "comirnaty12" });
    expect(preferredCovidForAge(5)).toEqual({ band: "5-11", label: "Pfizer 5-11", shortCode: "comirnaty511" });
    expect(preferredCovidForAge(3)).toEqual({ band: "3-4", label: "Moderna 3-11", shortCode: "spikevax6mo11" });
  });

  it("returns null for an unknown age or under 3", () => {
    expect(preferredCovidForAge(null)).toBeNull();
    expect(preferredCovidForAge(undefined)).toBeNull();
    expect(preferredCovidForAge(Number.NaN)).toBeNull();
    expect(preferredCovidForAge(2.9)).toBeNull();
  });

  it("bands a fractional age by whole years (4.9 is 3-4, 11.9 is 5-11, 12.0 is 12+)", () => {
    expect(preferredCovidForAge(4.9)?.band).toBe("3-4");
    expect(preferredCovidForAge(5)?.band).toBe("5-11");
    expect(preferredCovidForAge(11.9)?.band).toBe("5-11");
    expect(preferredCovidForAge(12)?.band).toBe("12+");
  });
});
