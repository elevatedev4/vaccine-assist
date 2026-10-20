import { describe, expect, it } from "vitest";
import {
  FLU_PREFERRED_PRODUCTS,
  fluOrderingBandForAge,
  fluProductForOrderingBand,
  preferredFluForAge,
} from "@/lib/flu-preference";

// Will 2026-10-18: Flucelvax preferred 3-49, mFLUSIVA 50-64, Fluad 65+.
describe("preferredFluForAge", () => {
  it.each([
    [2, null],
    [3, "flucelvax"],
    [11, "flucelvax"],
    [12, "flucelvax"],
    [49, "flucelvax"],
    [50, "mflusiva"],
    [64, "mflusiva"],
    [65, "fluad"],
    [110, "fluad"],
  ])("age %s -> %s", (age, key) => {
    expect(preferredFluForAge(age)?.key ?? null).toBe(key);
  });

  it("returns null for unknown, negative or non-finite ages", () => {
    expect(preferredFluForAge(null)).toBeNull();
    expect(preferredFluForAge(undefined)).toBeNull();
    expect(preferredFluForAge(-1)).toBeNull();
    expect(preferredFluForAge(Number.NaN)).toBeNull();
  });

  it("bands a fractional age by its whole years (49.9 is 49, 2.9 is under 3)", () => {
    expect(preferredFluForAge(49.9)?.key).toBe("flucelvax");
    expect(preferredFluForAge(64.99)?.key).toBe("mflusiva");
    expect(preferredFluForAge(2.9)).toBeNull();
  });

  it("gives each product the short codes the macro catalog uses", () => {
    expect(preferredFluForAge(30)?.shortCodes).toEqual(["flucelvaxmdv", "flucelvaxpfs"]);
    expect(preferredFluForAge(55)?.shortCodes).toEqual(["mflusiva"]);
    expect(preferredFluForAge(70)?.shortCodes).toEqual(["fluad"]);
  });

  it("covers every age from 3 up with exactly one product (no gaps, no overlaps)", () => {
    for (let age = 3; age <= 110; age += 1) {
      const matches = FLU_PREFERRED_PRODUCTS.filter((p) => age >= p.minAge && (p.maxAge === null || age <= p.maxAge));
      expect(matches).toHaveLength(1);
    }
  });
});

describe("fluOrderingBandForAge (ordering recommendations agree with the preferred-flu rule)", () => {
  it.each([
    [2, null],
    [3, "3-49"],
    [11, "3-49"],
    [12, "3-49"],
    [49, "3-49"],
    [50, "50-64"],
    [64, "50-64"],
    [65, "65+"],
  ])("age %s -> %s", (age, band) => {
    expect(fluOrderingBandForAge(age)).toBe(band);
  });

  it("every band maps back to the same product the age prefers", () => {
    for (let age = 3; age <= 110; age += 1) {
      const band = fluOrderingBandForAge(age)!;
      expect(fluProductForOrderingBand(band).key).toBe(preferredFluForAge(age)!.key);
    }
  });
});
