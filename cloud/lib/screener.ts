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
import { macroBaseShortCode, type MacroSection } from "./macro-catalog";

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
export type { ScreenerStatus };

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

/**
 * BY-TYPE GROUPING (V-screener-by-type, coordinator brief 2026-09-13,
 * quoting Will verbatim: "I also asked for reformatting of this section
 * to be based on the vaccine type instead of product name, with the
 * products listed as our macro code buttons that can copy/paste").
 *
 * Ties each SCREENER_RULES entry to the vaccine TYPE (MacroSection) and
 * real macro-catalog short code(s) it corresponds to (lib/macro-
 * catalog.ts — the SAME family vocabulary the Macro codes page uses, so
 * app/screener/page.tsx's type headings match app/macro-codes/page.tsx's
 * exactly). Keyed by short code rather than by product NAME because a
 * screener rule's `name` doesn't always match the live per-page display
 * name (e.g. macro-codes.ts overrides "Engerix-B" to "Engerix-B adult"
 * for its own page only) — short codes are the one identifier both
 * pages already treat as the real product key.
 *
 * A rule maps to more than one short code only when the SAME screener-
 * level recommendation covers more than one real packaging of the same
 * product (Flucelvax's MDV vial vs. PFS syringe) — never as a way to
 * widen a rule to a clinically different product (round-4's flu section
 * also has mFlu/Afluria/Flumist entries with no screener rule of their
 * own; those intentionally never appear here, same as before this
 * reformat — the screener only ever modeled Flucelvax/Fluad for flu).
 */
export const SCREENER_RULE_MACRO_INFO: Readonly<
  Record<string, { section: MacroSection; shortCodes: readonly string[] }>
> = {
  flucelvax: { section: "Flu", shortCodes: ["flucelvaxmdv", "flucelvaxpfs", "afluriapfs"] },
  fluad: { section: "Flu", shortCodes: ["fluad"] },
  comirnaty: { section: "COVID", shortCodes: ["comirnaty12"] },
  mnexspike: { section: "COVID", shortCodes: ["mnexspike"] },
  arexvy: { section: "RSV", shortCodes: ["arexvy"] },
  abrysvo: { section: "RSV", shortCodes: ["abrysvo"] },
  shingrix: { section: "Shingles", shortCodes: ["shingrix"] },
  "engerix-b": { section: "Hep B", shortCodes: ["engerix"] },
  prevnar20: { section: "Pneumonia", shortCodes: ["prevnar20"] },
  capvaxive: { section: "Pneumonia", shortCodes: ["capvaxive"] },
  boostrix: { section: "Tetanus", shortCodes: ["boostrix"] },
  gardasil9: { section: "HPV", shortCodes: ["gardasil"] },
  menveo: { section: "Meningitis", shortCodes: ["menveo"] },
  vaqta: { section: "Hep A", shortCodes: ["vaqtaadult"] },
  "typhim-vi": { section: "Typhoid", shortCodes: ["typhim"] },
  mmr: { section: "MMR", shortCodes: ["mmr"] },
};

export interface ScreenerTypeReason {
  status: ScreenerStatus;
  reason: string;
  sourceUrl: string;
}

/** One TYPE row within a single STATUS group (app/screener/page.tsx's
 * per-status sections, restored round-12, rendered as plain inline text
 * since round-13): one or more screener results of the SAME status that
 * share a vaccine type/family — Flucelvax + Fluad both "routine" at
 * 65+, or Comirnaty + mNEXSPIKE both "consider" at 40 with no risk
 * condition — rendered as one row (type name + its reason(s)) instead
 * of two separate rows. */
export interface ScreenerTypeRow {
  section: MacroSection;
  /** The underlying results this row represents, in first-seen (i.e.
   * SCREENER_RULES) order — almost always length 1; length 2 only for
   * the handful of types with two rules that landed in this same status
   * for this patient. */
  results: ScreenerResult[];
  /** Every unique (status, reason, sourceUrl) triple across this row's
   * results, in first-seen order — two results sharing identical reason
   * text (Comirnaty/mNEXSPIKE's shared rule) collapse to one line;
   * genuinely different reasons (rare within one status, e.g. a future
   * rule change) each still show. */
  reasons: ScreenerTypeReason[];
}

/**
 * ROUND 12 (Will rejected the round-11 by-type reformat verbatim: "The
 * format/layout you had before was good, showing recommendations by
 * age, then by health condition, etc. I just wanted you to say 'Flu'
 * and then have the available product options listed as copyable macro
 * code buttons"). Restores the original per-STATUS grouping
 * (groupScreenerResults/STATUS_GROUPS, unchanged) as the outer
 * structure; this function is the new INNER step app/screener/page.tsx
 * runs on EVERY status group's own results list (round-13 dropped the
 * round-12 routine/risk/consider-only split — every group renders the
 * same way now) — merging same-type results (already all the same
 * status, since the caller pre-filtered by status) into one row apiece,
 * in first-seen order (not MACRO_SECTION_ORDER — keeps the original
 * per-status row order stable rather than reshuffling by family). A
 * result whose id isn't in SCREENER_RULE_MACRO_INFO is skipped
 * (shouldn't happen — every SCREENER_RULES id is mapped above; guarded
 * so a future new rule fails soft instead of throwing).
 *
 * ROUND 13 (Will verbatim, 2026-09-14): "Remove all the macro code
 * buttons, it's not looking good. Just do the vaccine that is
 * recommended (Flu, Tdap, etc, as it already is) then add the explainer
 * text after it, not below it." This function's OUTPUT shape is
 * unchanged — app/screener/page.tsx just renders `reasons` as plain
 * inline text next to the type name instead of real macro dose buttons
 * under it; the type-level grouping/merging/dedup logic below didn't
 * need to change.
 */
export function groupStatusResultsByType(results: readonly ScreenerResult[]): ScreenerTypeRow[] {
  const bySection = new Map<MacroSection, ScreenerResult[]>();
  const order: MacroSection[] = [];
  for (const result of results) {
    const info = SCREENER_RULE_MACRO_INFO[result.id];
    if (!info) continue;
    if (!bySection.has(info.section)) {
      bySection.set(info.section, []);
      order.push(info.section);
    }
    bySection.get(info.section)!.push(result);
  }

  return order.map((section) => {
    const list = bySection.get(section)!;
    const reasons: ScreenerTypeReason[] = [];
    const seen = new Set<string>();
    for (const result of list) {
      if (seen.has(result.reason)) continue;
      seen.add(result.reason);
      reasons.push({ status: result.status, reason: result.reason, sourceUrl: result.sourceUrl });
    }
    return { section, results: list, reasons };
  });
}

/** Every real macro-catalog short code a screener result could resolve
 * to, keyed by result id — re-exported here (rather than requiring every
 * caller to reach back into SCREENER_RULE_MACRO_INFO) for
 * lib/screener-macro.ts's matchScreenerProducts. */
export function screenerMacroShortCodes(screenerId: string): readonly string[] {
  return SCREENER_RULE_MACRO_INFO[screenerId]?.shortCodes ?? [];
}

/** True when `shortCode` (a real vaccine row's short_code) belongs to
 * `screenerId`'s product family — base-short-code comparison, same
 * convention as lib/macro-catalog.ts's own lookupMacroCatalog fallback,
 * so a per-dose code like "shingrix2" still matches the "shingrix"
 * screener rule. */
export function shortCodeMatchesScreenerRule(shortCode: string, screenerId: string): boolean {
  const base = macroBaseShortCode(shortCode);
  return screenerMacroShortCodes(screenerId).some((code) => macroBaseShortCode(code) === base);
}
