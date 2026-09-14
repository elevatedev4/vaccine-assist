import { describe, expect, it } from "vitest";
import {
  screen,
  groupScreenerResults,
  groupStatusResultsByType,
  dropRedundantByTypeResults,
  screenerMacroShortCodes,
  shortCodeMatchesScreenerRule,
  isScreenerEmpty,
  INITIAL_SCREENER_STATE,
  SCREENER_RULE_MACRO_INFO,
  STATUS_GROUPS,
  type ScreenerFormState,
  type ScreenerResult,
  type ScreenerStatus,
} from "@/lib/screener";
import { SCREENER_RULES } from "@/lib/screener-rules";
import { MACRO_SECTION_ORDER } from "@/lib/macro-catalog";
import { DEFAULT_CONDITIONS, type ConditionKey, type PriorPneumoHistory, type ScreenerConditions } from "@/lib/screener-rules";

function conditions(overrides: Partial<Record<ConditionKey, boolean>> = {}): ScreenerConditions {
  return { ...DEFAULT_CONDITIONS, ...overrides };
}

function statusFor(results: ReturnType<typeof screen>, id: string): string {
  const result = results.find((r) => r.id === id);
  if (!result) throw new Error(`no result for ${id}`);
  return result.status;
}

function reasonFor(results: ReturnType<typeof screen>, id: string): string {
  const result = results.find((r) => r.id === id);
  if (!result) throw new Error(`no result for ${id}`);
  return result.reason;
}

// --- Flucelvax / Fluad -------------------------------------------------

describe("Flucelvax", () => {
  it("routine at 6 months (0.5 yr) and up", () => {
    expect(statusFor(screen(0.5, conditions()), "flucelvax")).toBe("routine");
    expect(statusFor(screen(40, conditions()), "flucelvax")).toBe("routine");
  });
  it("not-indicated below 6 months", () => {
    expect(statusFor(screen(0.2, conditions()), "flucelvax")).toBe("not-indicated");
  });
});

describe("Fluad", () => {
  it("routine only at 65+", () => {
    expect(statusFor(screen(65, conditions()), "fluad")).toBe("routine");
    expect(statusFor(screen(64, conditions()), "fluad")).toBe("not-indicated");
  });
});

// --- Comirnaty / mNEXSPIKE (identical) ---------------------------------

for (const id of ["comirnaty", "mnexspike"]) {
  describe(`${id} (COVID)`, () => {
    it("routine at 65+ regardless of conditions", () => {
      expect(statusFor(screen(70, conditions()), id)).toBe("routine");
    });

    it("40yo, no conditions -> consider (outside FDA label)", () => {
      const results = screen(40, conditions());
      expect(statusFor(results, id)).toBe("consider");
      expect(reasonFor(results, id)).toMatch(/outside the 2025-26 FDA label/i);
    });

    it("40yo with smoking -> risk", () => {
      expect(statusFor(screen(40, conditions({ smoking: true })), id)).toBe("risk");
    });

    it("12-64 with a qualifying condition (cancer) -> risk", () => {
      expect(statusFor(screen(30, conditions({ cancer: true })), id)).toBe("risk");
    });

    it("12-64 with a condition NOT on the specific risk list (asplenia alone) stays consider", () => {
      expect(statusFor(screen(30, conditions({ asplenia: true })), id)).toBe("consider");
    });

    it("pregnant qualifies as a risk condition, not a caution", () => {
      expect(statusFor(screen(28, conditions({ pregnant: true })), id)).toBe("risk");
    });

    it("not-indicated below age 12", () => {
      expect(statusFor(screen(10, conditions()), id)).toBe("not-indicated");
    });
  });
}

// --- RSV: Arexvy / Abrysvo ----------------------------------------------

describe("Arexvy", () => {
  it("routine at 75+", () => {
    expect(statusFor(screen(80, conditions()), "arexvy")).toBe("routine");
  });

  it("50-74 risk requires a qualifying condition; plain diabetes does NOT qualify", () => {
    expect(statusFor(screen(55, conditions({ diabetes: true })), "arexvy")).toBe("not-indicated");
    expect(statusFor(screen(55, conditions({ diabetesNeuropathy: true })), "arexvy")).toBe("risk");
  });

  it("18-49 with a qualifying condition -> consider (FDA label, ACIP pending)", () => {
    const results = screen(30, conditions({ chronicLungDisease: true }));
    expect(statusFor(results, "arexvy")).toBe("consider");
    expect(reasonFor(results, "arexvy")).toMatch(/ACIP endorsement pending/);
  });

  it("pregnant -> caution, not recommended (trial halted), points to Abrysvo", () => {
    const results = screen(28, conditions({ pregnant: true }));
    expect(statusFor(results, "arexvy")).toBe("caution");
    expect(reasonFor(results, "arexvy")).toMatch(/trial halted/i);
    expect(reasonFor(results, "arexvy")).toMatch(/Abrysvo/);
  });

  it("pregnant AND age 75+ still shows caution, with the routine reason appended", () => {
    const results = screen(76, conditions({ pregnant: true }));
    expect(statusFor(results, "arexvy")).toBe("caution");
    expect(reasonFor(results, "arexvy")).toMatch(/Would otherwise be routine/);
  });

  it("mentions one lifetime dose on routine/risk/consider reasons", () => {
    expect(reasonFor(screen(80, conditions()), "arexvy")).toMatch(/one lifetime dose/i);
    expect(reasonFor(screen(55, conditions({ severeObesity: true })), "arexvy")).toMatch(/one lifetime dose/i);
    expect(reasonFor(screen(30, conditions({ severeObesity: true })), "arexvy")).toMatch(/one lifetime dose/i);
  });
});

describe("Abrysvo", () => {
  it("routine at 75+", () => {
    expect(statusFor(screen(80, conditions()), "abrysvo")).toBe("routine");
  });

  it("50-74 risk requires a qualifying condition; plain diabetes does NOT qualify, a sub-item does", () => {
    expect(statusFor(screen(55, conditions({ diabetes: true })), "abrysvo")).toBe("not-indicated");
    expect(statusFor(screen(55, conditions({ diabetesRetinopathy: true })), "abrysvo")).toBe("risk");
  });

  it("18-49 with a qualifying condition -> consider", () => {
    expect(statusFor(screen(30, conditions({ immunocompromised: true })), "abrysvo")).toBe("consider");
  });

  it("pregnant -> risk (Abrysvo IS the recommended product), dosed 32-36 weeks, Abrysvo only", () => {
    const results = screen(28, conditions({ pregnant: true }));
    expect(statusFor(results, "abrysvo")).toBe("risk");
    expect(reasonFor(results, "abrysvo")).toMatch(/32-36 weeks/);
    expect(reasonFor(results, "abrysvo")).toMatch(/Abrysvo only/);
  });
});

// --- Shingrix ------------------------------------------------------------

describe("Shingrix", () => {
  it("routine at 50+", () => {
    expect(statusFor(screen(55, conditions()), "shingrix")).toBe("routine");
  });

  it("18-49 with a qualifying immunocompromising condition -> risk", () => {
    const results = screen(18, conditions({ hiv: true }));
    expect(statusFor(results, "shingrix")).toBe("risk");
    expect(reasonFor(results, "shingrix")).toMatch(/FDA label 18\+, ACIP 19\+/);
  });

  it("not-indicated below 18, or 18-49 without a qualifying condition", () => {
    expect(statusFor(screen(17, conditions({ hiv: true })), "shingrix")).toBe("not-indicated");
    expect(statusFor(screen(30, conditions()), "shingrix")).toBe("not-indicated");
  });

  it("pregnant -> caution, defer", () => {
    expect(statusFor(screen(30, conditions({ pregnant: true })), "shingrix")).toBe("caution");
  });
});

// --- Engerix-B -------------------------------------------------------------

describe("Engerix-B", () => {
  it("catch-up routine under 19", () => {
    expect(statusFor(screen(10, conditions()), "engerix-b")).toBe("routine");
  });

  it("routine 19-59", () => {
    expect(statusFor(screen(30, conditions()), "engerix-b")).toBe("routine");
  });

  it("60+ risk with Diabetes, CKD, Chronic liver, or HIV", () => {
    expect(statusFor(screen(65, conditions({ diabetes: true })), "engerix-b")).toBe("risk");
    expect(statusFor(screen(65, conditions({ chronicKidneyDisease: true })), "engerix-b")).toBe("risk");
    expect(statusFor(screen(65, conditions({ chronicLiverDisease: true })), "engerix-b")).toBe("risk");
    expect(statusFor(screen(65, conditions({ hiv: true })), "engerix-b")).toBe("risk");
  });

  it("60+ with no qualifying condition -> info", () => {
    expect(statusFor(screen(65, conditions()), "engerix-b")).toBe("info");
  });

  it("a diabetes sub-item checked without the parent still counts as diabetes for the 60+ risk tier", () => {
    expect(statusFor(screen(65, conditions({ diabetesInsulin: true })), "engerix-b")).toBe("risk");
  });
});

// --- Pneumococcal: Prevnar 20 / Capvaxive ----------------------------------

function pneumo(age: number, cond: Partial<Record<ConditionKey, boolean>>, history?: PriorPneumoHistory) {
  return screen(age, conditions(cond), history);
}

describe("Prevnar 20 / Capvaxive — adults, no prior history", () => {
  it("age 50+, no condition -> routine, one dose", () => {
    const results = pneumo(55, {});
    expect(statusFor(results, "prevnar20")).toBe("routine");
    expect(statusFor(results, "capvaxive")).toBe("routine");
    expect(reasonFor(results, "prevnar20")).toBe("One dose.");
  });

  it("age 30, smoking -> risk, one dose", () => {
    const results = pneumo(30, { smoking: true });
    expect(statusFor(results, "prevnar20")).toBe("risk");
    expect(statusFor(results, "capvaxive")).toBe("risk");
  });

  it("age 30, no condition -> not-indicated", () => {
    const results = pneumo(30, {});
    expect(statusFor(results, "prevnar20")).toBe("not-indicated");
    expect(statusFor(results, "capvaxive")).toBe("not-indicated");
  });

  it("heart failure qualifies the adult risk tier (ACIP's chronic heart disease includes CHF)", () => {
    const results = pneumo(30, { heartFailure: true });
    expect(statusFor(results, "prevnar20")).toBe("risk");
    expect(statusFor(results, "capvaxive")).toBe("risk");
  });
});

describe("Prevnar 20 / Capvaxive — prior-history matrix at age 50+", () => {
  it("none -> routine, one dose", () => {
    expect(reasonFor(pneumo(55, {}, "none"), "prevnar20")).toBe("One dose.");
  });
  it("unknown -> routine, one dose (same as none)", () => {
    expect(statusFor(pneumo(55, {}, "unknown"), "prevnar20")).toBe("routine");
    expect(reasonFor(pneumo(55, {}, "unknown"), "prevnar20")).toBe("One dose.");
  });
  it("pcv13 -> routine, sequencing note (>=1yr after PCV13)", () => {
    const results = pneumo(55, {}, "pcv13");
    expect(statusFor(results, "prevnar20")).toBe("routine");
    expect(reasonFor(results, "prevnar20")).toMatch(/PCV13/);
  });
  it("ppsv23 -> routine, sequencing note (>=1yr after PPSV23)", () => {
    const results = pneumo(55, {}, "ppsv23");
    expect(statusFor(results, "prevnar20")).toBe("routine");
    expect(reasonFor(results, "prevnar20")).toMatch(/PPSV23/);
  });
  it("both -> routine, sequencing note (>=5yr after last dose)", () => {
    const results = pneumo(55, {}, "both");
    expect(statusFor(results, "prevnar20")).toBe("routine");
    expect(reasonFor(results, "prevnar20")).toMatch(/5 years/);
  });
  it("pcv15_20_21 -> not-indicated, series complete", () => {
    const results = pneumo(55, {}, "pcv15_20_21");
    expect(statusFor(results, "prevnar20")).toBe("not-indicated");
    expect(statusFor(results, "capvaxive")).toBe("not-indicated");
    expect(reasonFor(results, "prevnar20")).toMatch(/series complete/i);
  });
});

describe("Prevnar 20 / Capvaxive — children 2-18 with a qualifying condition", () => {
  it("age 10 + asplenia -> Prevnar 20 risk, Capvaxive consider", () => {
    const results = pneumo(10, { asplenia: true });
    expect(statusFor(results, "prevnar20")).toBe("risk");
    expect(statusFor(results, "capvaxive")).toBe("consider");
  });

  it("age 17 + chronic lung disease -> Prevnar 20 risk, Capvaxive consider (still within Capvaxive's 2-17 band)", () => {
    const results = pneumo(17, { chronicLungDisease: true });
    expect(statusFor(results, "prevnar20")).toBe("risk");
    expect(statusFor(results, "capvaxive")).toBe("consider");
  });

  it("age 18 + asplenia -> Prevnar 20 risk via its 2-18 child tier, Capvaxive risk via its 18+ adult tier (FDA label is 18+)", () => {
    const results = pneumo(18, { asplenia: true });
    expect(statusFor(results, "prevnar20")).toBe("risk");
    expect(statusFor(results, "capvaxive")).toBe("risk");
  });

  it("a child with no qualifying condition is not-indicated", () => {
    const results = pneumo(10, {});
    expect(statusFor(results, "prevnar20")).toBe("not-indicated");
  });

  it("below age 2 is not-indicated even with a condition", () => {
    const results = pneumo(1, { asplenia: true });
    expect(statusFor(results, "prevnar20")).toBe("not-indicated");
  });
});

// --- Boostrix --------------------------------------------------------------

describe("Boostrix", () => {
  it("routine at 10+", () => {
    expect(statusFor(screen(10, conditions()), "boostrix")).toBe("routine");
  });
  it("not-indicated below 10", () => {
    expect(statusFor(screen(9, conditions()), "boostrix")).toBe("not-indicated");
  });
  it("pregnant -> risk, 27-36 weeks", () => {
    const results = screen(28, conditions({ pregnant: true }));
    expect(statusFor(results, "boostrix")).toBe("risk");
    expect(reasonFor(results, "boostrix")).toMatch(/27-36 weeks/);
  });
});

// --- Gardasil 9 --------------------------------------------------------------

describe("Gardasil 9", () => {
  it("routine 9-26, consider 27-45, not-indicated 46+", () => {
    expect(statusFor(screen(15, conditions()), "gardasil9")).toBe("routine");
    expect(statusFor(screen(35, conditions()), "gardasil9")).toBe("consider");
    expect(statusFor(screen(50, conditions()), "gardasil9")).toBe("not-indicated");
  });

  it("9-26 with an immunocompromising condition -> risk, 3-dose series regardless of start age", () => {
    const results = screen(12, conditions({ cancer: true }));
    expect(statusFor(results, "gardasil9")).toBe("risk");
    expect(reasonFor(results, "gardasil9")).toMatch(/3-dose series/);
  });

  it("pregnant -> caution, defer remaining doses to postpartum", () => {
    const results = screen(22, conditions({ pregnant: true }));
    expect(statusFor(results, "gardasil9")).toBe("caution");
    expect(reasonFor(results, "gardasil9")).toMatch(/postpartum/);
    expect(reasonFor(results, "gardasil9")).toMatch(/Would otherwise be routine/);
  });
});

// --- Menveo --------------------------------------------------------------

describe("Menveo", () => {
  it("risk from 2 months to 55 with Asplenia, HIV, or Sickle cell/thalassemia", () => {
    expect(statusFor(screen(10, conditions({ asplenia: true })), "menveo")).toBe("risk");
    expect(statusFor(screen(55, conditions({ hiv: true })), "menveo")).toBe("risk");
    expect(statusFor(screen(30, conditions({ sickleCellOrThalassemia: true })), "menveo")).toBe("risk");
  });

  it("immunocompromised ALONE does not qualify Menveo's risk tier, but is a consider (not not-indicated/info)", () => {
    const results = screen(30, conditions({ immunocompromised: true }));
    expect(statusFor(results, "menveo")).toBe("consider");
    expect(reasonFor(results, "menveo")).toMatch(/complement deficiency.*eculizumab/i);
  });

  it("over 55 with a qualifying condition -> info, outside Menveo's label", () => {
    const results = screen(60, conditions({ asplenia: true }));
    expect(statusFor(results, "menveo")).toBe("info");
    expect(reasonFor(results, "menveo")).toMatch(/outside Menveo's label/i);
  });

  it("no qualifying condition -> info (ask about travel/dorm/complement deficiency)", () => {
    expect(statusFor(screen(20, conditions()), "menveo")).toBe("info");
  });

  it("not-indicated below 2 months", () => {
    expect(statusFor(screen(0.1, conditions({ asplenia: true })), "menveo")).toBe("not-indicated");
  });
});

// --- Vaqta --------------------------------------------------------------

describe("Vaqta", () => {
  it("risk with chronic liver disease or HIV, age 1+", () => {
    expect(statusFor(screen(30, conditions({ chronicLiverDisease: true })), "vaqta")).toBe("risk");
    expect(statusFor(screen(30, conditions({ hiv: true })), "vaqta")).toBe("risk");
  });
  it("info otherwise, age 1+", () => {
    expect(statusFor(screen(30, conditions()), "vaqta")).toBe("info");
  });
  it("not-indicated below age 1", () => {
    expect(statusFor(screen(0.5, conditions()), "vaqta")).toBe("not-indicated");
  });
});

// --- Typhim Vi --------------------------------------------------------------

describe("Typhim Vi", () => {
  it("info (travel only) at age 2+", () => {
    expect(statusFor(screen(45, conditions()), "typhim-vi")).toBe("info");
  });
  it("not-indicated below age 2", () => {
    expect(statusFor(screen(1, conditions()), "typhim-vi")).toBe("not-indicated");
  });
});

// --- M-M-R II --------------------------------------------------------------

describe("M-M-R II", () => {
  it("routine at 12 months+ (born 1957+, no evidence of immunity)", () => {
    expect(statusFor(screen(30, conditions()), "mmr")).toBe("routine");
  });

  it("pregnant -> caution, contraindicated (live)", () => {
    const results = screen(28, conditions({ pregnant: true }));
    expect(statusFor(results, "mmr")).toBe("caution");
    expect(reasonFor(results, "mmr")).toMatch(/Contraindicated/);
  });

  it("immunocompromised/cancer/solid organ transplant -> caution, contraindicated wording (no CD4 mention)", () => {
    const results = screen(40, conditions({ immunocompromised: true }));
    expect(statusFor(results, "mmr")).toBe("caution");
    expect(reasonFor(results, "mmr")).toMatch(/contraindicated if immunosuppressed/i);
    expect(reasonFor(results, "mmr")).not.toMatch(/CD4/);
  });

  it("HIV alone -> caution, distinct wording (CD4 / pharmacist review, not an automatic contraindication)", () => {
    const results = screen(40, conditions({ hiv: true }));
    expect(statusFor(results, "mmr")).toBe("caution");
    expect(reasonFor(results, "mmr")).toMatch(/CD4/);
    expect(reasonFor(results, "mmr")).toMatch(/pharmacist review/i);
  });

  it("not-indicated below 12 months", () => {
    expect(statusFor(screen(0.5, conditions()), "mmr")).toBe("not-indicated");
  });
});

// --- groupScreenerResults ----------------------------------------------

describe("groupScreenerResults", () => {
  it("buckets results into STATUS_GROUPS order and drops empty groups", () => {
    const results = screen(30, conditions());
    const groups = groupScreenerResults(results);
    const statuses = groups.map((g) => g.status);
    const order = STATUS_GROUPS.map((g) => g.status);
    const indices = statuses.map((s) => order.indexOf(s));
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
    for (const group of groups) {
      expect(group.results.length).toBeGreaterThan(0);
    }
  });
});

// --- SCREENER_RULE_MACRO_INFO ------------------------------------------

describe("SCREENER_RULE_MACRO_INFO", () => {
  it("maps every SCREENER_RULES id to a type + at least one short code", () => {
    for (const rule of SCREENER_RULES) {
      const info = SCREENER_RULE_MACRO_INFO[rule.id];
      expect(info, `missing SCREENER_RULE_MACRO_INFO entry for "${rule.id}"`).toBeDefined();
      expect(MACRO_SECTION_ORDER).toContain(info.section);
      expect(info.shortCodes.length).toBeGreaterThan(0);
    }
  });
});

describe("shortCodeMatchesScreenerRule / screenerMacroShortCodes", () => {
  it("matches a rule's own short code, case/whitespace-insensitively", () => {
    expect(shortCodeMatchesScreenerRule("shingrix", "shingrix")).toBe(true);
    expect(shortCodeMatchesScreenerRule("  SHINGRIX  ", "shingrix")).toBe(true);
  });

  it("matches a per-dose short code via the digit-stripped base, same as lookupMacroCatalog", () => {
    expect(shortCodeMatchesScreenerRule("shingrix2", "shingrix")).toBe(true);
    expect(shortCodeMatchesScreenerRule("engerix3", "engerix-b")).toBe(true);
  });

  it("does not match an unrelated code or rule", () => {
    expect(shortCodeMatchesScreenerRule("shingrix", "mmr")).toBe(false);
    expect(shortCodeMatchesScreenerRule("comirnaty12", "shingrix")).toBe(false);
  });

  it("a rule spanning multiple real packagings (flucelvax) matches any of them", () => {
    expect(shortCodeMatchesScreenerRule("flucelvaxmdv", "flucelvax")).toBe(true);
    expect(shortCodeMatchesScreenerRule("flucelvaxpfs", "flucelvax")).toBe(true);
    expect(shortCodeMatchesScreenerRule("afluriapfs", "flucelvax")).toBe(true);
    // Fluad is a DIFFERENT screener rule (65+ only) — never matches flucelvax.
    expect(shortCodeMatchesScreenerRule("fluad", "flucelvax")).toBe(false);
  });

  it("screenerMacroShortCodes returns [] for an unknown id", () => {
    expect(screenerMacroShortCodes("not-a-real-rule")).toEqual([]);
  });
});

// --- groupStatusResultsByType (round 12: per-status inner grouping) -----

// Helper matching how app/screener/page.tsx now calls this: run the
// original status grouping first, then group EACH status's own results
// by type — groupStatusResultsByType itself only ever sees one status's
// results at a time.
function typeRowsForStatus(results: ReturnType<typeof screen>, status: string) {
  const group = groupScreenerResults(results).find((g) => g.status === status);
  return groupStatusResultsByType(group?.results ?? []);
}

describe("groupStatusResultsByType", () => {
  it("merges two same-type results sharing a status into one row (Flucelvax + Fluad, both routine at 65+)", () => {
    const results = screen(70, conditions());
    const rows = typeRowsForStatus(results, "routine");
    const flu = rows.find((r) => r.section === "Flu");
    expect(flu).toBeDefined();
    expect(flu?.results.map((r) => r.id)).toEqual(["flucelvax", "fluad"]);
    // Different reason text (6mo+ vs 65+ wording) -> two reason lines.
    expect(flu?.reasons).toHaveLength(2);
  });

  it("does NOT merge Flucelvax and Fluad when only one is routine (under 65)", () => {
    const results = screen(40, conditions());
    const routineRows = typeRowsForStatus(results, "routine");
    const flu = routineRows.find((r) => r.section === "Flu");
    expect(flu?.results.map((r) => r.id)).toEqual(["flucelvax"]);

    // ROUND 14 (bug b): Fluad's "Under 65 — use Flucelvax instead."
    // fallback used to still surface as its own not-indicated row here
    // even though Flu is already Recommended (Flucelvax); that's the
    // exact defect reported live at age 30 — dropRedundantByTypeResults
    // now drops it since Flu already has a "routine" row.
    const notIndicatedRows = typeRowsForStatus(results, "not-indicated");
    const fluNotIndicated = notIndicatedRows.find((r) => r.section === "Flu");
    expect(fluNotIndicated).toBeUndefined();
  });

  it("merges Comirnaty + mNEXSPIKE (identical rule) into one row with one deduped reason", () => {
    const results = screen(40, conditions());
    const considerRows = typeRowsForStatus(results, "consider");
    const covid = considerRows.find((r) => r.section === "COVID");
    expect(covid?.results.map((r) => r.id).sort()).toEqual(["comirnaty", "mnexspike"]);
    expect(covid?.reasons).toHaveLength(1);
  });

  it("merges Prevnar 20 + Capvaxive when they share a status (age 50+, no condition -> both routine)", () => {
    const results = screen(55, conditions());
    const routineRows = typeRowsForStatus(results, "routine");
    const pneumonia = routineRows.find((r) => r.section === "Pneumonia");
    expect(pneumonia?.results.map((r) => r.id).sort()).toEqual(["capvaxive", "prevnar20"]);
    // Identical "One dose." reason for both -> deduped to one line.
    expect(pneumonia?.reasons).toHaveLength(1);
  });

  it("ROUND 14: drops Capvaxive's 'consider' row once Prevnar 20 already covers Pneumonia as 'risk'", () => {
    const results = screen(10, conditions({ asplenia: true }));
    const riskRows = typeRowsForStatus(results, "risk");
    const considerRows = typeRowsForStatus(results, "consider");
    expect(riskRows.find((r) => r.section === "Pneumonia")?.results.map((r) => r.id)).toEqual(["prevnar20"]);
    // Same "already recommended elsewhere" rule as the Flu/Fluad case
    // above — Pneumonia already has a "risk" row, so Capvaxive's
    // separate "consider" row for the same type is redundant and gets
    // dropped before it ever reaches groupScreenerResults' buckets.
    expect(considerRows.find((r) => r.section === "Pneumonia")).toBeUndefined();
  });

  it("a type with a single result in a status is a one-result row (unchanged shape)", () => {
    const results = screen(55, conditions());
    const routineRows = typeRowsForStatus(results, "routine");
    const shingles = routineRows.find((r) => r.section === "Shingles");
    expect(shingles?.results.map((r) => r.id)).toEqual(["shingrix"]);
    expect(shingles?.reasons).toHaveLength(1);
  });

  it("keeps row order stable (first-seen order) across repeated calls", () => {
    const results = screen(70, conditions());
    const routineResults = groupScreenerResults(results).find((g) => g.status === "routine")!.results;
    const first = groupStatusResultsByType(routineResults).map((r) => r.section);
    const second = groupStatusResultsByType(routineResults).map((r) => r.section);
    expect(second).toEqual(first);
  });

  it("skips an id with no SCREENER_RULE_MACRO_INFO entry instead of throwing", () => {
    const fakeResult = { id: "not-a-real-rule", name: "Fake", status: "routine" as const, reason: "x", sourceUrl: "y" };
    expect(() => groupStatusResultsByType([fakeResult])).not.toThrow();
    expect(groupStatusResultsByType([fakeResult])).toEqual([]);
  });

  // --- ROUND 14 (bug a): near-duplicate reason text + shared-URL links ---

  it("dedupes reasons that are identical after trimming/lowercasing (not just exact string match)", () => {
    const a: ScreenerResult = {
      id: "arexvy",
      name: "Arexvy",
      status: "not-indicated",
      reason: "  Below age 18. ",
      sourceUrl: "https://example.com/rsv",
    };
    const b: ScreenerResult = {
      id: "abrysvo",
      name: "Abrysvo",
      status: "not-indicated",
      reason: "below age 18.",
      sourceUrl: "https://example.com/rsv",
    };
    const rsv = groupStatusResultsByType([a, b]).find((r) => r.section === "RSV");
    expect(rsv?.reasons).toHaveLength(1);
  });

  it("bug repro (age 30 + Diabetes): RSV not-indicated keeps Arexvy's and Abrysvo's differing reasons, but suppresses the first 'source' link since both cite the identical CDC URL", () => {
    const results = screen(30, conditions({ diabetes: true }));
    const notIndicatedRows = typeRowsForStatus(results, "not-indicated");
    const rsv = notIndicatedRows.find((r) => r.section === "RSV");
    expect(rsv?.results.map((r) => r.id)).toEqual(["arexvy", "abrysvo"]);
    // Differ only by the "/pregnancy" suffix -> real information, both kept.
    expect(rsv?.reasons).toHaveLength(2);
    expect(rsv?.reasons[0].reason).toBe("Below age 18, or age 18-74 without a qualifying risk condition.");
    expect(rsv?.reasons[1].reason).toBe("Below age 18, or age 18-74 without a qualifying risk condition/pregnancy.");
    // Same URL for both -> never two "source" links back to back; only
    // the trailing reason keeps its link.
    expect(rsv?.reasons[0].sourceUrl).toBeNull();
    expect(rsv?.reasons[1].sourceUrl).toBe("https://www.cdc.gov/rsv/hcp/vaccine-clinical-guidance/index.html");
  });

  it("does not suppress a source link when consecutive reasons cite different URLs", () => {
    const a: ScreenerResult = {
      id: "arexvy",
      name: "Arexvy",
      status: "not-indicated",
      reason: "Reason one.",
      sourceUrl: "https://example.com/a",
    };
    const b: ScreenerResult = {
      id: "abrysvo",
      name: "Abrysvo",
      status: "not-indicated",
      reason: "Reason two.",
      sourceUrl: "https://example.com/b",
    };
    const rsv = groupStatusResultsByType([a, b]).find((r) => r.section === "RSV");
    expect(rsv?.reasons.map((r) => r.sourceUrl)).toEqual(["https://example.com/a", "https://example.com/b"]);
  });

  // --- ROUND 14 (bug b): live pipeline repro at age 30 + Diabetes --------

  it("bug repro (age 30 + Diabetes): Flu shows once under Recommended, never redundantly under Not indicated", () => {
    const results = screen(30, conditions({ diabetes: true }));
    const groups = groupScreenerResults(results);

    const routine = groups.find((g) => g.status === "routine");
    expect(groupStatusResultsByType(routine?.results ?? []).some((r) => r.section === "Flu")).toBe(true);

    const notIndicated = groups.find((g) => g.status === "not-indicated");
    const flu = groupStatusResultsByType(notIndicated?.results ?? []).find((r) => r.section === "Flu");
    expect(flu).toBeUndefined();
  });
});

// --- dropRedundantByTypeResults (ROUND 14, bug b) -----------------------

describe("dropRedundantByTypeResults", () => {
  function fake(id: string, status: ScreenerStatus, reason = "reason"): ScreenerResult {
    return { id, name: id, status, reason, sourceUrl: "https://example.com" };
  }

  it("drops a not-indicated result once the same type already has a routine result", () => {
    const kept = dropRedundantByTypeResults([fake("flucelvax", "routine"), fake("fluad", "not-indicated")]);
    expect(kept.map((r) => r.id)).toEqual(["flucelvax"]);
  });

  it("drops a consider result once the same type already has a risk result", () => {
    const kept = dropRedundantByTypeResults([fake("prevnar20", "risk"), fake("capvaxive", "consider")]);
    expect(kept.map((r) => r.id)).toEqual(["prevnar20"]);
  });

  it("drops a not-indicated result once the same type already has a consider result", () => {
    const kept = dropRedundantByTypeResults([fake("comirnaty", "consider"), fake("mnexspike", "not-indicated")]);
    expect(kept.map((r) => r.id)).toEqual(["comirnaty"]);
  });

  it("never drops caution or info rows, and a caution row never counts as a stronger recommendation for another product of the same type", () => {
    const kept = dropRedundantByTypeResults([fake("arexvy", "caution"), fake("abrysvo", "not-indicated")]);
    expect(kept.map((r) => r.id).sort()).toEqual(["abrysvo", "arexvy"]);
  });

  it("leaves a result alone when its type has only one status present", () => {
    const kept = dropRedundantByTypeResults([fake("shingrix", "not-indicated")]);
    expect(kept.map((r) => r.id)).toEqual(["shingrix"]);
  });

  it("skips an id with no SCREENER_RULE_MACRO_INFO entry instead of throwing", () => {
    const unmapped = fake("not-a-real-rule", "not-indicated");
    expect(() => dropRedundantByTypeResults([unmapped])).not.toThrow();
    expect(dropRedundantByTypeResults([unmapped])).toEqual([unmapped]);
  });
});

// --- Clear button (V-screener round 14) --------------------------------

describe("isScreenerEmpty / INITIAL_SCREENER_STATE", () => {
  it("INITIAL_SCREENER_STATE is itself empty", () => {
    expect(isScreenerEmpty(INITIAL_SCREENER_STATE)).toBe(true);
  });

  it("is true for blank age, no conditions checked, and default prior-pneumo answer", () => {
    const state: ScreenerFormState = { ageInput: "", conditions: conditions(), priorPneumo: "none" };
    expect(isScreenerEmpty(state)).toBe(true);
  });

  it("is false once age has any text, even whitespace-padded", () => {
    expect(isScreenerEmpty({ ageInput: "55", conditions: conditions(), priorPneumo: "none" })).toBe(false);
  });

  it("is true when age is only whitespace (trimmed to empty)", () => {
    expect(isScreenerEmpty({ ageInput: "   ", conditions: conditions(), priorPneumo: "none" })).toBe(true);
  });

  it("is false once any top-level condition is checked", () => {
    expect(isScreenerEmpty({ ageInput: "", conditions: conditions({ asplenia: true }), priorPneumo: "none" })).toBe(
      false,
    );
  });

  it("is false once a nested diabetes sub-item is checked, even though the parent 'diabetes' key stays false", () => {
    expect(
      isScreenerEmpty({ ageInput: "", conditions: conditions({ diabetesInsulin: true }), priorPneumo: "none" }),
    ).toBe(false);
  });

  it("is false once the prior-pneumococcal dropdown is off its default, even with everything else blank", () => {
    expect(isScreenerEmpty({ ageInput: "", conditions: conditions(), priorPneumo: "both" })).toBe(false);
  });

  it("resetting a fully-filled-in state back to INITIAL_SCREENER_STATE is empty again", () => {
    const filledIn: ScreenerFormState = {
      ageInput: "72",
      conditions: conditions({ diabetes: true, diabetesRetinopathy: true, hiv: true }),
      priorPneumo: "pcv13",
    };
    expect(isScreenerEmpty(filledIn)).toBe(false);
    expect(isScreenerEmpty(INITIAL_SCREENER_STATE)).toBe(true);
  });
});
