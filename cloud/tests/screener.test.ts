import { describe, expect, it } from "vitest";
import { screen, groupScreenerResults, STATUS_GROUPS } from "@/lib/screener";
import { DEFAULT_CONDITIONS, type ConditionKey, type ScreenerConditions } from "@/lib/screener-rules";

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

describe("screen — 30-year-old, no conditions", () => {
  const results = screen(30, conditions());

  it("flu (Flucelvax) is routine", () => {
    expect(statusFor(results, "flucelvax")).toBe("routine");
  });

  it("COVID (Comirnaty) is consider (shared decision-making, no risk factor)", () => {
    expect(statusFor(results, "comirnaty")).toBe("consider");
  });

  it("HepB (Engerix-B) is routine (universal 19-59)", () => {
    expect(statusFor(results, "engerix-b")).toBe("routine");
  });

  it("Tdap (Boostrix) is routine", () => {
    expect(statusFor(results, "boostrix")).toBe("routine");
  });

  it("Shingrix is not-indicated (under 50, no qualifying condition)", () => {
    expect(statusFor(results, "shingrix")).toBe("not-indicated");
  });

  it("RSV (Arexvy, Abrysvo) is not-indicated (under 50/18, not pregnant)", () => {
    expect(statusFor(results, "arexvy")).toBe("not-indicated");
    expect(statusFor(results, "abrysvo")).toBe("not-indicated");
  });

  it("PCV (Prevnar 20, Capvaxive) is not-indicated (19-49, no risk condition)", () => {
    expect(statusFor(results, "prevnar20")).toBe("not-indicated");
    expect(statusFor(results, "capvaxive")).toBe("not-indicated");
  });
});

describe("screen — 55-year-old with Diabetes only (plain, no sub-item)", () => {
  const results = screen(55, conditions({ diabetes: true }));

  it("RSV (Arexvy, Abrysvo) is NOT triggered by plain diabetes alone", () => {
    expect(statusFor(results, "arexvy")).toBe("not-indicated");
    expect(statusFor(results, "abrysvo")).toBe("not-indicated");
  });

  // Note: the brief's shorthand test list said "PCV risk yes" for this
  // case, but the verified rule text for Prevnar 20/Capvaxive is
  // "routine 50+ one dose" with NO condition requirement at 50+ — the
  // 19-49 age band is the only one gated on conditions. At 55 (>=50),
  // age alone already qualifies regardless of diabetes, so the correct
  // status per the cited CDC/ACIP rule is "routine", not "risk". Flagged
  // for Will to confirm this reading is what he intended.
  it("PCV (Prevnar 20, Capvaxive) is routine — age 55 alone already qualifies (50+ is unconditional)", () => {
    expect(statusFor(results, "prevnar20")).toBe("routine");
    expect(statusFor(results, "capvaxive")).toBe("routine");
  });
});

describe("screen — 55-year-old with Neuropathy (diabetes-related sub-item)", () => {
  const results = screen(55, conditions({ diabetesNeuropathy: true }));

  it("RSV (Arexvy, Abrysvo) IS triggered by a diabetes-related sub-item", () => {
    expect(statusFor(results, "arexvy")).toBe("risk");
    expect(statusFor(results, "abrysvo")).toBe("risk");
  });
});

describe("screen — 28-year-old, pregnant", () => {
  const results = screen(28, conditions({ pregnant: true }));

  it("Abrysvo is risk (dosed 32-36 weeks)", () => {
    expect(statusFor(results, "abrysvo")).toBe("risk");
    expect(reasonFor(results, "abrysvo")).toMatch(/32-36 weeks/);
  });

  it("Tdap (Boostrix) is risk (every pregnancy, 27-36 weeks)", () => {
    expect(statusFor(results, "boostrix")).toBe("risk");
    expect(reasonFor(results, "boostrix")).toMatch(/27-36 weeks/);
  });

  it("MMR is caution (contraindicated, live vaccine)", () => {
    expect(statusFor(results, "mmr")).toBe("caution");
  });

  it("Arexvy is caution (use Abrysvo instead)", () => {
    expect(statusFor(results, "arexvy")).toBe("caution");
    expect(reasonFor(results, "arexvy")).toMatch(/Abrysvo/);
  });
});

describe("screen — 66-year-old, no conditions", () => {
  const results = screen(66, conditions());

  it("Fluad is routine (65+)", () => {
    expect(statusFor(results, "fluad")).toBe("routine");
  });

  it("PCV (Prevnar 20, Capvaxive) is routine", () => {
    expect(statusFor(results, "prevnar20")).toBe("routine");
    expect(statusFor(results, "capvaxive")).toBe("routine");
  });

  it("mNEXSPIKE is routine (65+)", () => {
    expect(statusFor(results, "mnexspike")).toBe("routine");
  });
});

describe("screen — 40-year-old, immunocompromised", () => {
  const results = screen(40, conditions({ immunocompromised: true }));

  it("Shingrix is risk", () => {
    expect(statusFor(results, "shingrix")).toBe("risk");
  });

  it("Menveo is risk", () => {
    expect(statusFor(results, "menveo")).toBe("risk");
  });

  it("MMR is caution", () => {
    expect(statusFor(results, "mmr")).toBe("caution");
  });
});

describe("screen — prior pneumococcal vaccine answered yes", () => {
  const results = screen(55, conditions(), "yes");

  it("Prevnar 20 / Capvaxive become info (sequencing note), overriding age-based routine", () => {
    expect(statusFor(results, "prevnar20")).toBe("info");
    expect(statusFor(results, "capvaxive")).toBe("info");
    expect(reasonFor(results, "prevnar20")).toMatch(/PPSV23/);
  });
});

describe("screen — extra rule branches", () => {
  it("Comirnaty becomes risk when a risk factor is checked", () => {
    const results = screen(30, conditions({ cancer: true }));
    expect(statusFor(results, "comirnaty")).toBe("risk");
  });

  it("mNEXSPIKE 12-64 with no risk factor points to Comirnaty instead", () => {
    const results = screen(40, conditions());
    expect(statusFor(results, "mnexspike")).toBe("not-indicated");
    expect(reasonFor(results, "mnexspike")).toMatch(/Comirnaty/);
  });

  it("Gardasil 9 is routine 9-26, consider 27-45, not-indicated 46+", () => {
    expect(statusFor(screen(15, conditions()), "gardasil9")).toBe("routine");
    expect(statusFor(screen(35, conditions()), "gardasil9")).toBe("consider");
    expect(statusFor(screen(50, conditions()), "gardasil9")).toBe("not-indicated");
  });

  it("Typhim Vi is always info", () => {
    expect(statusFor(screen(45, conditions()), "typhim-vi")).toBe("info");
  });

  it("Vaqta is risk with chronic liver disease, info otherwise (age 1+)", () => {
    expect(statusFor(screen(30, conditions({ chronicLiverDisease: true })), "vaqta")).toBe("risk");
    expect(statusFor(screen(30, conditions()), "vaqta")).toBe("info");
  });

  it("a diabetes sub-item checked without the parent still counts as diabetes for Engerix-B's 60+ risk tier", () => {
    const results = screen(65, conditions({ diabetesInsulin: true }));
    expect(statusFor(results, "engerix-b")).toBe("risk");
  });
});

describe("groupScreenerResults", () => {
  it("buckets results into STATUS_GROUPS order and drops empty groups", () => {
    const results = screen(30, conditions());
    const groups = groupScreenerResults(results);
    const statuses = groups.map((g) => g.status);
    // Every status present is in STATUS_GROUPS order.
    const order = STATUS_GROUPS.map((g) => g.status);
    const indices = statuses.map((s) => order.indexOf(s));
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
    // No empty groups leak through.
    for (const group of groups) {
      expect(group.results.length).toBeGreaterThan(0);
    }
  });
});
