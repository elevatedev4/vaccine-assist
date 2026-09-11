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
});
