/**
 * Pure evaluator for the vaccine eligibility SCREENER (V-screener) — see
 * lib/screener-rules.ts's header for why this is a separate rule set
 * from lib/eligibility.ts. This file has no I/O: `screen()` takes an
 * age and a checked-conditions map and returns one result per vaccine
 * in lib/screener-rules.ts's SCREENER_RULES, ready for app/screener/
 * page.tsx to group and render. Kept pure/no-React so it's unit-testable
 * without jsdom (same split as lib/doses-given.ts's pivot logic vs its
 * page).
 */

import {
  DIABETES_SUB_KEYS,
  SCREENER_RULES,
  type ConditionKey,
  type DerivedConditionKey,
  type PriorPneumoHistory,
  type ScreenerConditions,
  type ScreenerStatus,
  type ScreenerTier,
  type ScreenerVaccineRule,
} from "./screener-rules";

export interface ScreenerResult {
  id: string;
  name: string;
  status: ScreenerStatus;
  reason: string;
  sourceUrl: string;
}

/** Re-exported so callers (app/screener/page.tsx) can import the prior-
 * pneumococcal-history type from either lib file. */
export type { PriorPneumoHistory } from "./screener-rules";

type DerivedConditions = Record<DerivedConditionKey, boolean>;

/**
 * Expands the raw checkbox map with the two computed keys rules can
 * gate on (see DerivedConditionKey's doc comment in screener-rules.ts):
 * checking any diabetes sub-item also flips the "diabetes" key itself,
 * matching the on-screen behavior where a sub-checkbox visually ticks
 * its "Diabetes" parent.
 */
function deriveConditions(conditions: ScreenerConditions): DerivedConditions {
  const diabetesSubItem = DIABETES_SUB_KEYS.some((key) => conditions[key]);
  const merged: Record<ConditionKey, boolean> = {
    ...conditions,
    diabetes: conditions.diabetes || diabetesSubItem,
  };
  const anyCondition = Object.values(merged).some(Boolean);
  return { ...merged, diabetesSubItem, anyCondition };
}

function tierMatches(
  tier: ScreenerTier,
  age: number,
  derived: DerivedConditions,
  priorPneumo: PriorPneumoHistory
): boolean {
  const min = tier.ageMin ?? 0;
  const max = tier.ageMax ?? Infinity;
  if (age < min || age > max) return false;
  if (tier.requiredConditions && tier.requiredConditions.length > 0) {
    if (!tier.requiredConditions.some((key) => derived[key])) return false;
  }
  if (tier.requirePriorPneumo && tier.requirePriorPneumo !== priorPneumo) return false;
  return true;
}

/** First matching tier's {status, reason} (or the rule's fallback if
 * none match). `skipCaution` re-runs the same walk ignoring "caution"
 * tiers — used to find the routine/risk recommendation a caution is
 * standing in front of, so evaluateVaccine can surface it (see this
 * file's header / screener-rules.ts's "Precedence" note). */
function firstMatch(
  rule: ScreenerVaccineRule,
  age: number,
  derived: DerivedConditions,
  priorPneumo: PriorPneumoHistory,
  skipCaution: boolean
): { status: ScreenerStatus; reason: string } {
  for (const tier of rule.tiers) {
    if (skipCaution && tier.status === "caution") continue;
    if (tierMatches(tier, age, derived, priorPneumo)) {
      return { status: tier.status, reason: tier.reason };
    }
  }
  return rule.fallback;
}

function evaluateVaccine(
  rule: ScreenerVaccineRule,
  age: number,
  derived: DerivedConditions,
  priorPneumo: PriorPneumoHistory
): ScreenerResult {
  const matched = firstMatch(rule, age, derived, priorPneumo, false);
  let reason = matched.reason;
  // A caution never hides a routine/risk recommendation outright — the
  // pharmacist still sees what it would otherwise be.
  if (matched.status === "caution") {
    const underlying = firstMatch(rule, age, derived, priorPneumo, true);
    if (underlying.status === "routine" || underlying.status === "risk") {
      reason = `${matched.reason} (Would otherwise be ${underlying.status}: ${underlying.reason})`;
    }
  }
  return { id: rule.id, name: rule.name, status: matched.status, reason, sourceUrl: rule.sourceUrl };
}

/**
 * Evaluate every vaccine in SCREENER_RULES for one patient. `age` is in
 * years (0.5 = 6 months); `priorPneumo` is the optional pneumococcal
 * history question (Prevnar 20 / Capvaxive only), defaulting to "none"
 * when unanswered — same result as an explicit "none".
 */
export function screen(
  age: number,
  conditions: ScreenerConditions,
  priorPneumo: PriorPneumoHistory = "none"
): ScreenerResult[] {
  const derived = deriveConditions(conditions);
  return SCREENER_RULES.map((rule) => evaluateVaccine(rule, age, derived, priorPneumo));
}

/** Display order + section headers for grouping screen()'s output. */
export const STATUS_GROUPS: { status: ScreenerStatus; label: string }[] = [
  { status: "routine", label: "Recommended — by age" },
  { status: "risk", label: "Recommended — because of checked conditions" },
  { status: "consider", label: "Consider / discuss" },
  { status: "caution", label: "Caution" },
  { status: "not-indicated", label: "Not indicated" },
  { status: "info", label: "Needs a question we don't ask" },
];

export interface ScreenerResultGroup {
  status: ScreenerStatus;
  label: string;
  results: ScreenerResult[];
}

/** Buckets screen()'s flat result list into STATUS_GROUPS order,
 * dropping any group that ended up empty. */
export function groupScreenerResults(results: ScreenerResult[]): ScreenerResultGroup[] {
  return STATUS_GROUPS.map((group) => ({
    ...group,
    results: results.filter((result) => result.status === group.status),
  })).filter((group) => group.results.length > 0);
}
