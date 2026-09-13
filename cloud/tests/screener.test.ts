import { describe, expect, it } from "vitest";
import { screen, groupScreenerResults, STATUS_GROUPS } from "@/lib/screener";
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
