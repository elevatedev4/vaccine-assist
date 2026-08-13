import { describe, expect, it } from "vitest";
import {
  ageInYears,
  evaluateEligibilityRule,
  evaluateEligibilityRules,
  type EligibilityRule,
} from "@/lib/eligibility";

function rule(overrides: Partial<EligibilityRule> = {}): EligibilityRule {
  return {
    vaccineId: "v1",
    minAge: null,
    maxAge: null,
    conditionNote: null,
    pregnancyWarning: false,
    priority: 0,
    ...overrides,
  };
}

describe("evaluateEligibilityRule", () => {
  it("blocks below the minimum age (spikevax12: min 12)", () => {
    const result = evaluateEligibilityRule(rule({ minAge: 12 }), { ageYears: 11 });
    expect(result.status).toBe("blocked");
    expect(result.reasons[0]).toMatch(/below the minimum age of 12/);
  });

  it("allows exactly at the minimum age boundary", () => {
    const result = evaluateEligibilityRule(rule({ minAge: 12 }), { ageYears: 12 });
    expect(result.status).toBe("allowed");
  });

  it("blocks above the maximum age (gardasil: 9-45)", () => {
    const result = evaluateEligibilityRule(rule({ minAge: 9, maxAge: 45 }), { ageYears: 46 });
    expect(result.status).toBe("blocked");
    expect(result.reasons[0]).toMatch(/above the maximum age of 45/);
  });

  it("allows within a min/max band (spikevax311: 3-11)", () => {
    const result = evaluateEligibilityRule(rule({ minAge: 3, maxAge: 11 }), { ageYears: 7 });
    expect(result.status).toBe("allowed");
  });

  it("blocks a pregnant patient for a pregnancy-warning vaccine (MMR)", () => {
    const result = evaluateEligibilityRule(rule({ minAge: 3, pregnancyWarning: true }), {
      ageYears: 30,
      isPregnant: true,
    });
    expect(result.status).toBe("blocked");
    expect(result.reasons.join(" ")).toMatch(/may never receive this vaccine/);
  });

  it("warns (does not block) when pregnancy status is unknown for a live vaccine", () => {
    const result = evaluateEligibilityRule(rule({ minAge: 3, pregnancyWarning: true }), {
      ageYears: 30,
    });
    expect(result.status).toBe("warning");
    expect(result.warnings.join(" ")).toMatch(/Pregnancy status is unknown/);
  });

  it("allows a non-pregnant patient for a pregnancy-warning vaccine", () => {
    const result = evaluateEligibilityRule(rule({ minAge: 3, pregnancyWarning: true }), {
      ageYears: 30,
      isPregnant: false,
    });
    expect(result.status).toBe("allowed");
  });

  it("surfaces a condition_note as a warning (Fluad 18-64 transplant note)", () => {
    const result = evaluateEligibilityRule(
      rule({ minAge: 18, conditionNote: "Ages 18-64 require a documented solid organ transplant." }),
      { ageYears: 40 }
    );
    expect(result.status).toBe("warning");
    expect(result.warnings).toContain(
      "Ages 18-64 require a documented solid organ transplant."
    );
  });

  it("blocked wins over a condition_note warning when both apply", () => {
    const result = evaluateEligibilityRule(
      rule({ minAge: 60, conditionNote: "High-risk criteria required for ages 60-74." }),
      { ageYears: 40 }
    );
    expect(result.status).toBe("blocked");
  });
});

describe("evaluateEligibilityRules", () => {
  it("combines multiple rules for one vaccine (min age + pregnancy warning)", () => {
    const rules = [rule({ minAge: 3, priority: 0 }), rule({ pregnancyWarning: true, priority: 1 })];
    const result = evaluateEligibilityRules(rules, { ageYears: 30 });
    expect(result.status).toBe("warning");
  });

  it("blocked from any single rule blocks the overall result", () => {
    const rules = [rule({ minAge: 12, priority: 0 }), rule({ conditionNote: "note", priority: 1 })];
    const result = evaluateEligibilityRules(rules, { ageYears: 5 });
    expect(result.status).toBe("blocked");
  });

  it("returns a warning when no rule exists for a vaccine", () => {
    const result = evaluateEligibilityRules([], { ageYears: 40 });
    expect(result.status).toBe("warning");
    expect(result.warnings[0]).toMatch(/No eligibility rule is on file/);
  });
});

describe("ageInYears", () => {
  it("computes whole years before the birthday this year", () => {
    expect(ageInYears(new Date(1990, 5, 15), new Date(2026, 5, 14))).toBe(35);
  });

  it("computes whole years on/after the birthday this year", () => {
    expect(ageInYears(new Date(1990, 5, 15), new Date(2026, 5, 15))).toBe(36);
  });
});
