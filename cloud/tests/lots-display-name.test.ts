import { describe, expect, it } from "vitest";
import { lotsDisplayName } from "@/lib/lots-display-name";

describe("lotsDisplayName", () => {
  it("strips a trailing '+' age token while keeping the season", () => {
    expect(lotsDisplayName("Comirnaty 2026-27 12+")).toBe("Comirnaty 2026-27");
  });

  it("strips a mo-yr age range", () => {
    expect(lotsDisplayName("Spikevax 6mo-11")).toBe("Spikevax");
  });

  it("strips an '(age N-N)' parenthetical", () => {
    expect(lotsDisplayName("FluMist (age 2-49)")).toBe("FluMist");
  });

  it("strips only the age parenthetical, keeping a bare product number", () => {
    expect(lotsDisplayName("Engerix 20 (age 20+)")).toBe("Engerix 20");
  });

  it("strips a bare small-number age range", () => {
    expect(lotsDisplayName("Pfizer 3-4")).toBe("Pfizer");
  });

  it("keeps a non-age qualifier word", () => {
    expect(lotsDisplayName("Vaqta adult")).toBe("Vaqta adult");
  });

  it("leaves a name with no qualifiers unchanged", () => {
    expect(lotsDisplayName("Fluad")).toBe("Fluad");
  });

  it("keeps a dose-form qualifier", () => {
    expect(lotsDisplayName("Flucelvax PFS")).toBe("Flucelvax PFS");
  });

  it("keeps a plain product number that isn't an age marker", () => {
    expect(lotsDisplayName("Prevnar 20")).toBe("Prevnar 20");
  });

  it("strips a parenthetical age marker without the literal word 'age'", () => {
    expect(lotsDisplayName("Something (19+)")).toBe("Something");
  });

  it("collapses double spaces left behind by a removed token", () => {
    expect(lotsDisplayName("Product  6mo-11  extra")).toBe("Product extra");
  });

  // Round 5 (Will verbatim): "There is still a lot of random text
  // there. Ex: (; immunocompromised), (2 mo-55 yr), ( yr), (;
  // pregnancy wk), (; high-risk), 'Formula'. Get rid of those and
  // others." Round 4 only stripped age-shaped parenthetical content,
  // which left these fragments whenever a parenthetical held more
  // than an age expression. Round 5 drops every parenthetical
  // outright. These use the REAL catalog productName + ageRange
  // combos (via formatProductDisplayName) that produced Will's
  // fragments — see lib/vaccine-product-catalog.ts.

  it("drops a parenthetical with age + immunocompromised note (real Shingrix combo)", () => {
    // productName "Shingrix", ageRange "50+; 19+ immunocompromised"
    expect(lotsDisplayName("Shingrix (50+; 19+ immunocompromised)")).toBe("Shingrix");
  });

  it("drops a parenthetical with a mo-yr age range (real Menveo combo)", () => {
    // productName "Menveo (two-vial)", ageRange "2 mo-55 yr"
    expect(lotsDisplayName("Menveo (two-vial) (2 mo-55 yr)")).toBe("Menveo");
  });

  it("drops a parenthetical with age + pregnancy week note (real Abrysvo combo)", () => {
    // productName "Abrysvo", ageRange "60+; pregnancy 32-36 wk"
    expect(lotsDisplayName("Abrysvo (60+; pregnancy 32-36 wk)")).toBe("Abrysvo");
  });

  it("drops a parenthetical with age + high-risk note (real Capvaxive combo)", () => {
    // productName "Capvaxive", ageRange "18+; 2-17 high-risk"
    expect(lotsDisplayName("Capvaxive (18+; 2-17 high-risk)")).toBe("Capvaxive");
  });

  it("drops the standalone word 'Formula' while keeping the season and age token", () => {
    expect(lotsDisplayName("Comirnaty 2026-27 Formula 12+")).toBe("Comirnaty 2026-27");
  });

  it("drops a bare age parenthetical", () => {
    expect(lotsDisplayName("Fluad (65+)")).toBe("Fluad");
  });

  it("drops a range + high-risk parenthetical", () => {
    expect(lotsDisplayName("Bexsero (10-25 yr; high-risk)")).toBe("Bexsero");
  });

  it("drops an age + pregnancy-week parenthetical", () => {
    expect(lotsDisplayName("Abrysvo (60+; pregnancy 32-36 wk)")).toBe("Abrysvo");
  });

  it("drops a mo-yr parenthetical while keeping the season outside it", () => {
    expect(lotsDisplayName("Spikevax 2026-27 (6 mo-11 yr)")).toBe("Spikevax 2026-27");
  });

  it("keeps a plain product number with no qualifiers", () => {
    expect(lotsDisplayName("Prevnar 20")).toBe("Prevnar 20");
  });

  it("leaves a hyphenated product name with no qualifiers unchanged", () => {
    expect(lotsDisplayName("MMR-II")).toBe("MMR-II");
  });

  it("drops a nested parenthetical entirely", () => {
    expect(lotsDisplayName("Capvaxive (18+ (2-17 high-risk))")).toBe("Capvaxive");
  });

  it("drops everything from a dangling unclosed '(' onward", () => {
    expect(lotsDisplayName("Something (age 20+")).toBe("Something");
  });
});
