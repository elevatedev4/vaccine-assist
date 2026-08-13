/**
 * Vaccine eligibility rule evaluation — the typed replacement for the 24
 * age/eligibility CASE blocks in the old `vaccine-add-new.mxe` Macro
 * Express script. See supabase/migrations/0001_init.sql for the
 * `eligibility_rule` table this reads from, and
 * supabase/seed/eligibility_rules.sql for the seeded rules decoded from
 * the macro.
 *
 * Deliberately conservative: this never silently allows something the
 * macro would have blocked. Anything the macro expressed as a
 * human-judgment prompt (multiple-choice "does the patient meet the
 * high-risk criteria?") is surfaced here as a WARNING requiring staff
 * confirmation, not an automatic pass/fail — same as the macro's own
 * behavior.
 */

export interface EligibilityRule {
  vaccineId: string;
  minAge: number | null;
  maxAge: number | null;
  conditionNote: string | null;
  pregnancyWarning: boolean;
  priority: number;
}

export interface EligibilitySubject {
  ageYears: number;
  isPregnant?: boolean;
}

export type EligibilityStatus = "allowed" | "warning" | "blocked";

export interface EligibilityResult {
  status: EligibilityStatus;
  reasons: string[];
  warnings: string[];
}

/**
 * Evaluate a single rule against a subject (patient age / pregnancy
 * status). A vaccine may have more than one applicable rule (e.g. a base
 * age gate plus a pregnancy warning) — see evaluateEligibilityRules for
 * combining several rules for one vaccine.
 */
export function evaluateEligibilityRule(
  rule: EligibilityRule,
  subject: EligibilitySubject
): EligibilityResult {
  const reasons: string[] = [];
  const warnings: string[] = [];

  if (rule.minAge !== null && subject.ageYears < rule.minAge) {
    reasons.push(`Patient age ${subject.ageYears} is below the minimum age of ${rule.minAge}.`);
  }

  if (rule.maxAge !== null && subject.ageYears > rule.maxAge) {
    reasons.push(`Patient age ${subject.ageYears} is above the maximum age of ${rule.maxAge}.`);
  }

  if (rule.pregnancyWarning && subject.isPregnant) {
    reasons.push(
      "Live vaccine: pregnant patients may never receive this vaccine. Confirm pregnancy status before continuing."
    );
  } else if (rule.pregnancyWarning && subject.isPregnant === undefined) {
    warnings.push(
      "This is a live vaccine. Pregnancy status is unknown — confirm the patient is not pregnant before continuing."
    );
  }

  if (rule.conditionNote) {
    warnings.push(rule.conditionNote);
  }

  if (reasons.length > 0) {
    return { status: "blocked", reasons, warnings };
  }

  if (warnings.length > 0) {
    return { status: "warning", reasons, warnings };
  }

  return { status: "allowed", reasons, warnings };
}

/**
 * Combine every rule attached to a vaccine into one overall result:
 * blocked wins over warning wins over allowed, and messages accumulate
 * across rules (mirrors multiple stacked IF blocks in the original
 * macro's SWITCH cases, e.g. Fluad's age-18 floor plus its 18-64
 * transplant-required prompt).
 */
export function evaluateEligibilityRules(
  rules: EligibilityRule[],
  subject: EligibilitySubject
): EligibilityResult {
  const sorted = [...rules].sort((a, b) => a.priority - b.priority);

  let status: EligibilityStatus = "allowed";
  const reasons: string[] = [];
  const warnings: string[] = [];

  for (const rule of sorted) {
    const result = evaluateEligibilityRule(rule, subject);
    reasons.push(...result.reasons);
    warnings.push(...result.warnings);
    if (result.status === "blocked") {
      status = "blocked";
    } else if (result.status === "warning" && status !== "blocked") {
      status = "warning";
    }
  }

  if (rules.length === 0) {
    warnings.push(
      "No eligibility rule is on file for this vaccine. Review age/risk criteria manually before continuing."
    );
    status = "warning";
  }

  return { status, reasons, warnings };
}

/** Whole-years age from a date of birth, as of `asOf` (defaults to now). */
export function ageInYears(dateOfBirth: Date, asOf: Date = new Date()): number {
  let age = asOf.getFullYear() - dateOfBirth.getFullYear();
  const monthDiff = asOf.getMonth() - dateOfBirth.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && asOf.getDate() < dateOfBirth.getDate())) {
    age -= 1;
  }
  return age;
}
