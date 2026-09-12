import { describe, expect, it } from "vitest";
import { lotsDisplayName } from "@/lib/lots-display-name";
import { formatProductDisplayName, listCatalogEntries } from "@/lib/vaccine-product-catalog";

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

  it("drops the age parenthetical but KEEPS the SKU qualifier in the other one (real Menveo combo)", () => {
    // productName "Menveo (two-vial)", ageRange "2 mo-55 yr" — reviewer
    // blocking fix: round 5's first pass dropped "two-vial" too, which
    // isn't age/eligibility noise, it's the SKU qualifier itself.
    expect(lotsDisplayName("Menveo (two-vial) (2 mo-55 yr)")).toBe("Menveo two-vial");
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

  // Reviewer blocking fix (REQUEST_CHANGES on deb2a9f): deleting whole
  // parentheticals collided distinct catalog SKUs onto the same /lots
  // name. Each case below is the REAL formatProductDisplayName output
  // (productName + ageRange, see lib/vaccine-product-catalog.ts) for a
  // pair of entries that must stay distinguishable.

  it("keeps the 1-count marker so it doesn't collide with the 10-count Abrysvo", () => {
    // productName "Abrysvo (1 ct)", ageRange "60+; pregnancy 32-36 wk"
    expect(lotsDisplayName("Abrysvo (1 ct) (60+; pregnancy 32-36 wk)")).toBe("Abrysvo 1 ct");
    // productName "Abrysvo", ageRange "60+; pregnancy 32-36 wk" — the OTHER Abrysvo row
    expect(lotsDisplayName("Abrysvo (60+; pregnancy 32-36 wk)")).toBe("Abrysvo");
  });

  it("keeps PFS vs MDV so the two Flucelvax rows don't collide", () => {
    // productName "Flucelvax (2026-27, PFS)", ageRange "6 mo+"
    expect(lotsDisplayName("Flucelvax (2026-27, PFS) (6 mo+)")).toBe("Flucelvax PFS");
    // productName "Flucelvax (2026-27, MDV)", ageRange "6 mo+"
    expect(lotsDisplayName("Flucelvax (2026-27, MDV) (6 mo+)")).toBe("Flucelvax MDV");
  });

  it("keeps PFS vs MDV so the two Afluria rows don't collide", () => {
    // productName "Afluria (2026-27, PFS)", ageRange "6 mo+"
    expect(lotsDisplayName("Afluria (2026-27, PFS) (6 mo+)")).toBe("Afluria PFS");
    // productName "Afluria (2026-27, MDV)", ageRange "6 mo+"
    expect(lotsDisplayName("Afluria (2026-27, MDV) (6 mo+)")).toBe("Afluria MDV");
  });

  it("keeps the 'adult' formulation qualifier (real Vaqta combo)", () => {
    // productName "Vaqta (adult)", ageRange "19+"
    expect(lotsDisplayName("Vaqta (adult) (19+)")).toBe("Vaqta adult");
  });

  it("keeps the dose-strength qualifier (real Engerix-B combo)", () => {
    // productName "Engerix-B (adult 20 mcg)", ageRange "20+"
    expect(lotsDisplayName("Engerix-B (adult 20 mcg) (20+)")).toBe("Engerix-B adult 20 mcg");
  });

  it("produces a unique /lots name for every catalog entry", () => {
    const entries = listCatalogEntries();
    const byOutput = new Map<string, string[]>();
    for (const entry of entries) {
      const full = formatProductDisplayName(entry.productName, entry.ageRange ?? null);
      const shortened = lotsDisplayName(full);
      const key = entry.packageNdc ?? entry.match.ndc ?? entry.productName;
      const existing = byOutput.get(shortened) ?? [];
      existing.push(key);
      byOutput.set(shortened, existing);
    }
    const collisions = [...byOutput.entries()].filter(([, keys]) => keys.length > 1);
    expect(collisions, `colliding /lots names: ${JSON.stringify(collisions)}`).toEqual([]);
  });
});
