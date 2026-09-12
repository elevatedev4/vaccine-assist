import { describe, expect, it } from "vitest";
import { defaultDirections, defaultQuantity, planFillDefaults, type FillDefaultsRow } from "@/lib/entry-defaults";

function row(overrides: Partial<FillDefaultsRow>): FillDefaultsRow {
  return {
    id: "v1",
    shortCode: null,
    quantity: null,
    directions: null,
    doseNumber: 1,
    doseCount: 1,
    ...overrides,
  };
}

describe("defaultDirections", () => {
  it("single-dose product: no 'Dose X' prefix", () => {
    expect(defaultDirections({ doseNumber: 1, doseCount: 1 })).toBe(
      "For administration by healthcare provider in pharmacy."
    );
  });

  it("multi-dose series: prefixes 'Dose X — ' using the dose number", () => {
    expect(defaultDirections({ doseNumber: 1, doseCount: 2 })).toBe(
      "Dose 1 — For administration by healthcare provider in pharmacy."
    );
    expect(defaultDirections({ doseNumber: 2, doseCount: 2 })).toBe(
      "Dose 2 — For administration by healthcare provider in pharmacy."
    );
  });

  it("dose numbering follows doseNumber, not doseCount, for a 3-dose series", () => {
    expect(defaultDirections({ doseNumber: 3, doseCount: 3 })).toBe(
      "Dose 3 — For administration by healthcare provider in pharmacy."
    );
  });
});

describe("defaultQuantity", () => {
  it("returns null for a null/blank/unrecognized short_code", () => {
    expect(defaultQuantity(null)).toBeNull();
    expect(defaultQuantity(undefined)).toBeNull();
    expect(defaultQuantity("")).toBeNull();
    expect(defaultQuantity("   ")).toBeNull();
    expect(defaultQuantity("not-a-real-code")).toBeNull();
  });

  it("resolves the special-cased quantities Will specified", () => {
    expect(defaultQuantity("comirnaty12")).toBe("0.3");
    expect(defaultQuantity("mnexspike")).toBe("0.2");
    expect(defaultQuantity("spikevax6mo11")).toBe("0.25");
    expect(defaultQuantity("flumist")).toBe("0.2");
    expect(defaultQuantity("engerix")).toBe("1");
    expect(defaultQuantity("vaqtaadult")).toBe("1");
  });

  it("resolves the catalog default of 0.5 for every other listed short_code", () => {
    for (const code of [
      "flucelvaxmdv",
      "flucelvaxpfs",
      "mflusiva",
      "afluriapfs",
      "fluad",
      "fluzonehd",
      "arexvy",
      "abrysvo",
      "shingrix",
      "prevnar20",
      "capvaxive",
      "boostrix",
      "gardasil",
      "menveo",
      "typhim",
      "mmr",
      "priorix",
    ]) {
      expect(defaultQuantity(code)).toBe("0.5");
    }
  });

  it("falls back to the digit-stripped base for a multi-dose per-dose code, same as lookupMacroCatalog", () => {
    expect(defaultQuantity("shingrix1")).toBe("0.5");
    expect(defaultQuantity("shingrix2")).toBe("0.5");
  });

  it("is case-insensitive", () => {
    expect(defaultQuantity("COMIRNATY12")).toBe("0.3");
  });
});

describe("planFillDefaults with overwriteDirections: false (\"Fill blanks\")", () => {
  it("plans quantity and directions for a fully-blank row with a known short_code", () => {
    const patches = planFillDefaults([row({ id: "v1", shortCode: "comirnaty12" })], { overwriteDirections: false });
    expect(patches).toEqual([
      { id: "v1", quantity: "0.3", directions: "For administration by healthcare provider in pharmacy." },
    ]);
  });

  it("never invents a quantity for an unrecognized short_code, but still fills directions", () => {
    const patches = planFillDefaults([row({ id: "v1", shortCode: "unknown-code" })], { overwriteDirections: false });
    expect(patches).toEqual([
      { id: "v1", directions: "For administration by healthcare provider in pharmacy." },
    ]);
  });

  it("never overwrites an existing quantity, even if it differs from the table", () => {
    const patches = planFillDefaults([row({ id: "v1", shortCode: "comirnaty12", quantity: "0.2" })], {
      overwriteDirections: false,
    });
    expect(patches[0].quantity).toBeUndefined();
  });

  it("never overwrites existing directions, even if they don't match today's default", () => {
    const patches = planFillDefaults(
      [row({ id: "v1", shortCode: "comirnaty12", directions: "inject 0.2ml into the muscle once." })],
      { overwriteDirections: false }
    );
    expect(patches[0].directions).toBeUndefined();
    // quantity still gets filled since it's blank.
    expect(patches[0].quantity).toBe("0.3");
  });

  it("treats whitespace-only values as blank for both fields", () => {
    const patches = planFillDefaults([row({ id: "v1", shortCode: "comirnaty12", quantity: "  ", directions: "  " })], {
      overwriteDirections: false,
    });
    expect(patches).toEqual([
      { id: "v1", quantity: "0.3", directions: "For administration by healthcare provider in pharmacy." },
    ]);
  });

  it("uses the multi-dose default for a row whose doseCount > 1", () => {
    const patches = planFillDefaults([row({ id: "shingrix2", shortCode: "shingrix2", doseNumber: 2, doseCount: 2 })], {
      overwriteDirections: false,
    });
    expect(patches[0].directions).toBe("Dose 2 — For administration by healthcare provider in pharmacy.");
    expect(patches[0].quantity).toBe("0.5");
  });

  it("omits a row entirely when neither field needs a patch", () => {
    const patches = planFillDefaults(
      [row({ id: "v1", shortCode: "comirnaty12", quantity: "0.3", directions: "already set" })],
      { overwriteDirections: false }
    );
    expect(patches).toEqual([]);
  });

  it("only plans PATCHes for rows that need one out of a mixed list, preserving id order", () => {
    const patches = planFillDefaults(
      [
        row({ id: "a", shortCode: "comirnaty12", quantity: "0.3", directions: "already set" }),
        row({ id: "b", shortCode: "comirnaty12", directions: null }),
        row({ id: "c", shortCode: null, directions: "" }),
      ],
      { overwriteDirections: false }
    );
    expect(patches.map((p) => p.id)).toEqual(["b", "c"]);
  });

  it("returns an empty list when given no rows", () => {
    expect(planFillDefaults([], { overwriteDirections: false })).toEqual([]);
  });
});

describe("planFillDefaults with overwriteDirections: true (\"Reset all directions to standard\")", () => {
  it("overwrites existing directions that differ from today's default", () => {
    const patches = planFillDefaults(
      [row({ id: "v1", shortCode: "comirnaty12", quantity: "0.3", directions: "inject 0.2ml into the muscle once." })],
      { overwriteDirections: true }
    );
    expect(patches).toEqual([{ id: "v1", directions: "For administration by healthcare provider in pharmacy." }]);
  });

  it("still never overwrites an existing quantity", () => {
    const patches = planFillDefaults([row({ id: "v1", shortCode: "comirnaty12", quantity: "0.2", directions: "custom" })], {
      overwriteDirections: true,
    });
    expect(patches[0].quantity).toBeUndefined();
  });

  it("skips a row whose directions already match today's default", () => {
    const patches = planFillDefaults(
      [row({ id: "v1", shortCode: "comirnaty12", quantity: "0.3", directions: "For administration by healthcare provider in pharmacy." })],
      { overwriteDirections: true }
    );
    expect(patches).toEqual([]);
  });

  it("still fills a blank quantity alongside an overwritten directions value", () => {
    const patches = planFillDefaults([row({ id: "v1", shortCode: "comirnaty12", directions: "custom text" })], {
      overwriteDirections: true,
    });
    expect(patches).toEqual([
      { id: "v1", quantity: "0.3", directions: "For administration by healthcare provider in pharmacy." },
    ]);
  });

  it("never double-prefixes a multi-dose row — replaces any existing 'Dose X' prefix variant wholesale, not additively", () => {
    // Guard case (V-entry-values round 3, Will 2026-09-12): a row whose
    // stored directions already carry SOME "Dose X" prefix (typed by
    // hand, or from before today's em-dash convention) must end up with
    // exactly ONE prefix after Reset — never "Dose 2 – Dose 2 — ...".
    for (const existing of ["Dose 2 – custom note", "Dose 2 - custom note", "Dose 2: custom note", "dose 2 custom note"]) {
      const patches = planFillDefaults(
        [row({ id: "v1", shortCode: "shingrix2", doseNumber: 2, doseCount: 2, quantity: "0.5", directions: existing })],
        { overwriteDirections: true }
      );
      expect(patches).toEqual([{ id: "v1", directions: "Dose 2 — For administration by healthcare provider in pharmacy." }]);
      expect(patches[0].directions?.match(/Dose 2/g)).toHaveLength(1);
    }
  });

  it("is idempotent — resetting an already-correct multi-dose row a second time plans no patch", () => {
    const alreadyCorrect = "Dose 1 — For administration by healthcare provider in pharmacy.";
    const patches = planFillDefaults(
      [row({ id: "v1", shortCode: "shingrix1", doseNumber: 1, doseCount: 2, quantity: "0.5", directions: alreadyCorrect })],
      { overwriteDirections: true }
    );
    expect(patches).toEqual([]);
  });
});
