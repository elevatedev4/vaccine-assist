import { describe, expect, it } from "vitest";
import {
  DEFAULT_PREFERRED_COVID,
  isValidPreferredCovid,
  normalizePreferredCovid,
  preferredCovidForAge,
} from "@/lib/preferred-covid";

describe("DEFAULT_PREFERRED_COVID", () => {
  it("is Pfizer for 12+ and Moderna (kids) for 3-11", () => {
    expect(DEFAULT_PREFERRED_COVID).toEqual({ adult: "pfizer", kids: "moderna" });
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
    expect(normalizePreferredCovid({ adult: "moderna", kids: "moderna" })).toEqual({ adult: "moderna", kids: "moderna" });
  });

  it("defaults each part independently", () => {
    expect(normalizePreferredCovid({ adult: "moderna" })).toEqual({ adult: "moderna", kids: "moderna" });
    expect(normalizePreferredCovid({ adult: "novavax", kids: "pfizer" })).toEqual(DEFAULT_PREFERRED_COVID);
    expect(normalizePreferredCovid({ kids: "moderna" })).toEqual(DEFAULT_PREFERRED_COVID);
  });
});

describe("isValidPreferredCovid", () => {
  it("requires both parts to be valid choices", () => {
    expect(isValidPreferredCovid({ adult: "pfizer", kids: "moderna" })).toBe(true);
    expect(isValidPreferredCovid({ adult: "moderna", kids: "moderna" })).toBe(true);
    expect(isValidPreferredCovid({ adult: "pfizer" })).toBe(false);
    expect(isValidPreferredCovid({ adult: "pfizer", kids: "pfizer" })).toBe(false);
    expect(isValidPreferredCovid(null)).toBe(false);
  });
});

describe("preferredCovidForAge", () => {
  it.each([
    [2, null],
    [3, "spikevax6mo11"],
    [11, "spikevax6mo11"],
    [12, "comirnaty12"],
    [49, "comirnaty12"],
    [50, "comirnaty12"],
    [64, "comirnaty12"],
    [65, "comirnaty12"],
    [100, "comirnaty12"],
  ])("default setting, age %s -> %s", (age, code) => {
    expect(preferredCovidForAge(age)?.shortCode ?? null).toBe(code);
  });

  it("follows the 12+ choice (Moderna -> mNEXSPIKE) without touching the kids band", () => {
    const setting = { adult: "moderna", kids: "moderna" } as const;
    expect(preferredCovidForAge(12, setting)).toEqual({ band: "12+", label: "Moderna 12+", shortCode: "mnexspike" });
    expect(preferredCovidForAge(11, setting)).toEqual({ band: "3-11", label: "Moderna 3-11", shortCode: "spikevax6mo11" });
  });

  it("labels each band with the product names the catalog uses", () => {
    expect(preferredCovidForAge(30)).toEqual({ band: "12+", label: "Pfizer 12+", shortCode: "comirnaty12" });
    expect(preferredCovidForAge(5)).toEqual({ band: "3-11", label: "Moderna 3-11", shortCode: "spikevax6mo11" });
  });

  it("returns null for an unknown age or under 3", () => {
    expect(preferredCovidForAge(null)).toBeNull();
    expect(preferredCovidForAge(undefined)).toBeNull();
    expect(preferredCovidForAge(Number.NaN)).toBeNull();
    expect(preferredCovidForAge(2.9)).toBeNull();
  });

  it("bands a fractional age by whole years (11.9 is a child, 12.0 an adult)", () => {
    expect(preferredCovidForAge(11.9)?.band).toBe("3-11");
    expect(preferredCovidForAge(12)?.band).toBe("12+");
  });
});
