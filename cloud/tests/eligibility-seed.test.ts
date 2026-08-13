import { describe, expect, it } from "vitest";
import {
  buildEligibilityDeleteStatement,
  buildEligibilitySqlStatements,
} from "../scripts/lib/eligibility-sql.mjs";
import { ELIGIBILITY_RULES } from "../scripts/lib/eligibility-rules-data.mjs";

describe("buildEligibilitySqlStatements", () => {
  it("builds a select-by-short_code insert with all fields", () => {
    const [sql] = buildEligibilitySqlStatements([
      {
        shortCode: "mmr1",
        minAge: 3,
        maxAge: null,
        conditionNote: null,
        pregnancyWarning: true,
        priority: 0,
      },
    ]);
    expect(sql).toContain("insert into eligibility_rule");
    expect(sql).toContain("select id, 3, null, null, true, 0");
    expect(sql).toContain("from vaccine where short_code = 'mmr1';");
  });

  it("escapes single quotes in condition_note", () => {
    const [sql] = buildEligibilitySqlStatements([
      {
        shortCode: "x",
        minAge: null,
        maxAge: null,
        conditionNote: "patient's condition",
        pregnancyWarning: false,
        priority: 0,
      },
    ]);
    expect(sql).toContain("patient''s condition");
  });

  it("emits one statement per rule, in order", () => {
    const statements = buildEligibilitySqlStatements([
      { shortCode: "a", minAge: 1, maxAge: null, conditionNote: null, pregnancyWarning: false, priority: 0 },
      { shortCode: "b", minAge: 2, maxAge: null, conditionNote: null, pregnancyWarning: false, priority: 0 },
    ]);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("'a'");
    expect(statements[1]).toContain("'b'");
  });
});

describe("buildEligibilityDeleteStatement", () => {
  it("scopes the delete to the exact set of short_codes being reseeded", () => {
    const sql = buildEligibilityDeleteStatement([
      { shortCode: "mmr1" },
      { shortCode: "mmr2" },
      { shortCode: "mmr1" },
    ]);
    expect(sql).toContain("delete from eligibility_rule");
    expect(sql).toContain("short_code in ('mmr1', 'mmr2')");
  });
});

describe("ELIGIBILITY_RULES data integrity", () => {
  it("every rule has a non-empty short_code and a boolean pregnancy_warning", () => {
    for (const rule of ELIGIBILITY_RULES) {
      expect(typeof rule.shortCode).toBe("string");
      expect(rule.shortCode.length).toBeGreaterThan(0);
      expect(typeof rule.pregnancyWarning).toBe("boolean");
    }
  });

  it("min_age <= max_age wherever both are set (matches the DB check constraint)", () => {
    for (const rule of ELIGIBILITY_RULES) {
      if (rule.minAge !== null && rule.maxAge !== null) {
        expect(rule.minAge).toBeLessThanOrEqual(rule.maxAge);
      }
    }
  });

  it("flags the live-vaccine pregnancy warning on every MMR/Priorix rule", () => {
    const liveVaccineCodes = ["mmr1", "mmr2", "priorix1", "priorix2"];
    for (const code of liveVaccineCodes) {
      const rule = ELIGIBILITY_RULES.find((r) => r.shortCode === code);
      expect(rule?.pregnancyWarning).toBe(true);
    }
  });

  it("has no duplicate short_code entries", () => {
    const codes = ELIGIBILITY_RULES.map((r) => r.shortCode);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
