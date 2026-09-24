import { describe, expect, it } from "vitest";
import { covidVaccineMaker, vaccineDisplayName } from "@/lib/vaccine-display-name";

describe("vaccineDisplayName", () => {
  it("prefixes Comirnaty with Pfizer", () => {
    expect(vaccineDisplayName("Comirnaty")).toBe("Pfizer Comirnaty");
  });

  it("prefixes Comirnaty case-insensitively", () => {
    expect(vaccineDisplayName("comirnaty 2026-27 12+")).toBe("Pfizer comirnaty 2026-27 12+");
  });

  it("keeps a season/age suffix on Comirnaty", () => {
    expect(vaccineDisplayName("Comirnaty 2026-27 12+")).toBe("Pfizer Comirnaty 2026-27 12+");
  });

  it("prefixes Spikevax with Moderna", () => {
    expect(vaccineDisplayName("Spikevax")).toBe("Moderna Spikevax");
  });

  it("keeps a season/age suffix on Spikevax", () => {
    expect(vaccineDisplayName("Spikevax 6mo-11")).toBe("Moderna Spikevax 6mo-11");
  });

  it("prefixes mNEXSPIKE with Moderna", () => {
    expect(vaccineDisplayName("mNEXSPIKE")).toBe("Moderna mNEXSPIKE");
  });

  it("prefixes mNexspike regardless of casing", () => {
    expect(vaccineDisplayName("mnexspike 2026-27")).toBe("Moderna mnexspike 2026-27");
  });

  it("is idempotent for an already-prefixed Pfizer name", () => {
    expect(vaccineDisplayName("Pfizer Comirnaty")).toBe("Pfizer Comirnaty");
  });

  it("is idempotent for an already-prefixed Moderna name", () => {
    expect(vaccineDisplayName("Moderna Spikevax")).toBe("Moderna Spikevax");
  });

  it("leaves a non-COVID vaccine name untouched", () => {
    expect(vaccineDisplayName("Fluad")).toBe("Fluad");
  });

  it("leaves an unrelated name untouched", () => {
    expect(vaccineDisplayName("Prevnar 20")).toBe("Prevnar 20");
  });
});

describe("covidVaccineMaker (V-T-macro-round15: the maker lookup lib/macro-codes.ts's covidMacroLabel reuses)", () => {
  it("returns Pfizer for Comirnaty, case-insensitively", () => {
    expect(covidVaccineMaker("Comirnaty 2026-27 12+")).toBe("Pfizer");
    expect(covidVaccineMaker("comirnaty")).toBe("Pfizer");
  });

  it("returns Moderna for Spikevax and mNEXSPIKE", () => {
    expect(covidVaccineMaker("Spikevax")).toBe("Moderna");
    expect(covidVaccineMaker("mNEXSPIKE 2026-27")).toBe("Moderna");
  });

  it("returns null for a non-COVID name", () => {
    expect(covidVaccineMaker("Shingrix")).toBeNull();
  });

  it("still resolves a name that's already maker-prefixed", () => {
    expect(covidVaccineMaker("Pfizer Comirnaty")).toBe("Pfizer");
  });
});
