import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateEligibilityRule } from "@/lib/eligibility";
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

// Pfizer 5-11 (Comirnaty 2026-27 5-11y, short code comirnaty511), added
// 2026-11-25: "For ages 5-11 only". Eligibility is DATA (the eligibility_rule
// table); the rule ships in the seed data file, the regenerated seed SQL and
// migration 0016 (applied by hand after the vaccine row exists).
describe("comirnaty511 age gate (5-11 only)", () => {
  const rule = ELIGIBILITY_RULES.find((r) => r.shortCode === "comirnaty511");

  it("is in the rules data as min 5, max 11, with no note and no pregnancy warning", () => {
    expect(rule).toMatchObject({ minAge: 5, maxAge: 11, conditionNote: null, pregnancyWarning: false, priority: 0 });
  });

  it.each([
    [4, "blocked"],
    [5, "allowed"],
    [8, "allowed"],
    [11, "allowed"],
    [12, "blocked"],
    [40, "blocked"],
  ])("age %s is %s", (ageYears, status) => {
    const r = rule!;
    const result = evaluateEligibilityRule(
      { vaccineId: "v511", minAge: r.minAge, maxAge: r.maxAge, conditionNote: r.conditionNote, pregnancyWarning: r.pregnancyWarning, priority: r.priority },
      { ageYears }
    );
    expect(result.status).toBe(status);
  });

  it("is in the generated seed SQL and in migration 0016, selected by short_code", () => {
    const root = path.resolve(__dirname, "..", "..", "supabase");
    const seed = readFileSync(path.join(root, "seed", "eligibility_rules.sql"), "utf8");
    expect(seed).toContain("select id, 5, 11, null, false, 0");
    expect(seed).toContain("from vaccine where short_code = 'comirnaty511';");
    const migration = readFileSync(path.join(root, "migrations", "0016_comirnaty511_eligibility.sql"), "utf8");
    expect(migration).toContain("select id, 5, 11, null, false, 0");
    expect(migration).toContain("where short_code = 'comirnaty511'");
    expect(migration).toContain("delete from eligibility_rule");
  });
});
