import { describe, expect, it } from "vitest";
import { isPreferredAdultCovidRow } from "@/lib/preferred-covid-badge";

const PFIZER = { adult: "pfizer", kids: "moderna" } as const;
const MODERNA = { adult: "moderna", kids: "moderna" } as const;

describe("isPreferredAdultCovidRow", () => {
  it("Pfizer choice matches Comirnaty by name, with or without the maker prefix", () => {
    expect(isPreferredAdultCovidRow({ name: "Comirnaty 2026-27" }, PFIZER)).toBe(true);
    expect(isPreferredAdultCovidRow({ name: "Pfizer Comirnaty 2026-27 12+" }, PFIZER)).toBe(true);
    expect(isPreferredAdultCovidRow({ name: "comirnaty" }, PFIZER)).toBe(true);
  });

  it("Moderna choice matches mNEXSPIKE only", () => {
    expect(isPreferredAdultCovidRow({ name: "mNEXSPIKE (2026-27)" }, MODERNA)).toBe(true);
    expect(isPreferredAdultCovidRow({ name: "Moderna mNEXSPIKE" }, MODERNA)).toBe(true);
    expect(isPreferredAdultCovidRow({ name: "Spikevax 2026-27" }, MODERNA)).toBe(false);
  });

  it("only the chosen brand is badged", () => {
    expect(isPreferredAdultCovidRow({ name: "Comirnaty 2026-27" }, MODERNA)).toBe(false);
    expect(isPreferredAdultCovidRow({ name: "mNEXSPIKE" }, PFIZER)).toBe(false);
  });

  it("matches on the macro-catalog short code when the page has one", () => {
    expect(isPreferredAdultCovidRow({ name: "Some renamed product", shortCode: "comirnaty12" }, PFIZER)).toBe(true);
    expect(isPreferredAdultCovidRow({ name: "Some renamed product", shortCode: " MNEXSPIKE " }, MODERNA)).toBe(true);
    expect(isPreferredAdultCovidRow({ name: "Spikevax", shortCode: "spikevax6mo11" }, MODERNA)).toBe(false);
    expect(isPreferredAdultCovidRow({ name: "x", shortCode: "mnexspike" }, PFIZER)).toBe(false);
  });

  it("never badges a Comirnaty with a child age band", () => {
    expect(isPreferredAdultCovidRow({ name: "Comirnaty 5-11" }, PFIZER)).toBe(false);
    expect(isPreferredAdultCovidRow({ name: "Pfizer Comirnaty 3-4 yr" }, PFIZER)).toBe(false);
    expect(isPreferredAdultCovidRow({ name: "Comirnaty 6 mo-4 yr" }, PFIZER)).toBe(false);
  });

  it("shows nothing for non-COVID rows, empty names or an unloaded setting", () => {
    expect(isPreferredAdultCovidRow({ name: "Shingrix" }, PFIZER)).toBe(false);
    expect(isPreferredAdultCovidRow({ name: "Fluzone HD" }, MODERNA)).toBe(false);
    expect(isPreferredAdultCovidRow({ name: "" }, PFIZER)).toBe(false);
    expect(isPreferredAdultCovidRow({ name: null, shortCode: null }, PFIZER)).toBe(false);
    expect(isPreferredAdultCovidRow({ name: undefined }, PFIZER)).toBe(false);
    expect(isPreferredAdultCovidRow({ name: "Comirnaty 2026-27" }, null)).toBe(false);
    expect(isPreferredAdultCovidRow({ name: "Comirnaty 2026-27" }, undefined)).toBe(false);
  });

  it("does not match a name that merely contains a brand later in the text", () => {
    expect(isPreferredAdultCovidRow({ name: "Not Comirnaty" }, PFIZER)).toBe(false);
  });
});
