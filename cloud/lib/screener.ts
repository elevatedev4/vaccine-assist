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
 * dropping any group that ended up empty. Runs dropRedundantByTypeResults
 * first (ROUND 14) so a type already recommended elsewhere never also
 * shows a redundant not-indicated/consider row — see that function's
 * doc comment (below groupStatusResultsByType) for the exact rule. */
export function groupScreenerResults(results: ScreenerResult[]): ScreenerResultGroup[] {
  const filtered = dropRedundantByTypeResults(results);
  return STATUS_GROUPS.map((group) => ({
    ...group,
    results: filtered.filter((result) => result.status === group.status),
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
  /** null when this reason's "source" link would be a same-URL repeat
   * of the very next reason's link in this row (see ROUND 14 note on
   * groupStatusResultsByType below) — app/screener/page.tsx skips
   * rendering the <a> for a null sourceUrl. */
  sourceUrl: string | null;
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
  /** Every unique reason across this row's results, in first-seen
   * order — two results whose reason text is identical after trimming/
   * lowercasing (Comirnaty/mNEXSPIKE's shared rule) collapse to one
   * line; reasons that differ (even by a small suffix, e.g. Arexvy vs.
   * Abrysvo's "/pregnancy") each still show as their own line. See
   * ScreenerTypeReason.sourceUrl for the same-URL back-to-back-link
   * suppression. */
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
 *
 * ROUND 14 (text-dedupe fix, 2026-09-14): two defects reported live at
 * age 30 + Diabetes. (a) The reason dedupe below compared raw reason
 * strings, so two products with the SAME reason modulo whitespace/case
 * still produced two lines; it now dedupes on trimmed+lowercased text.
 * Reasons that genuinely differ (Arexvy vs. Abrysvo's not-indicated
 * fallback, which differs only by a "/pregnancy" suffix) still both
 * show — that's real information, not a duplicate — but since both
 * point at the same CDC RSV guidance URL, showing a "source" link after
 * each read as two identical links back to back; the pass below
 * suppresses a reason's link when the NEXT reason in the row shares its
 * exact URL, leaving one trailing link for the run. (b) A type already
 * shown under a "Recommended" group (routine/risk) — or, failing that,
 * under "Consider / discuss" — no longer also gets a redundant row
 * under "Not indicated" (Fluad's "Under 65 — use Flucelvax instead."
 * fallback showing up under Not indicated while Flucelvax itself was
 * already Recommended for the same patient); see
 * dropRedundantByTypeResults, called from groupScreenerResults before
 * results ever reach this function. "caution" and "info" rows are
 * unaffected either way — they carry warnings that must survive
 * regardless of what else is recommended for the same type.
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
      const key = result.reason.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      reasons.push({ status: result.status, reason: result.reason, sourceUrl: result.sourceUrl });
    }
    // Never render two "source" links back to back for the identical
    // URL — keep the link only on the LAST reason of a same-URL run
    // (e.g. Arexvy's not-indicated fallback immediately followed by
    // Abrysvo's near-identical one, both citing the same CDC page).
    for (let i = 0; i < reasons.length - 1; i++) {
      if (reasons[i].sourceUrl === reasons[i + 1].sourceUrl) {
        reasons[i] = { ...reasons[i], sourceUrl: null };
      }
    }
    return { section, results: list, reasons };
  });
}

/**
 * ROUND 14 (see groupStatusResultsByType's doc comment above): drops a
 * screen() result whose vaccine type already has a STRONGER
 * recommendation elsewhere, so it never reaches groupScreenerResults'
 * per-status buckets in the first place. "Stronger" here means: a
 * "not-indicated" or "consider" result is redundant once the same type
 * already has a "routine" or "risk" result (a real, active
 * recommendation supersedes a "not indicated"/"consider" note about a
 * DIFFERENT product of the same type), and a "not-indicated" result is
 * further redundant once the type already has a "consider" result.
 * "caution" and "info" results are never dropped, and never count as
 * "stronger" for this comparison — they're warnings/questions, not
 * recommendations, and must survive regardless of what else is shown
 * for the same type. Exported (and covered directly in
 * tests/screener.test.ts) since it's the piece with the actual
 * decision logic; groupScreenerResults just calls it as a first pass.
 */
export function dropRedundantByTypeResults(results: readonly ScreenerResult[]): ScreenerResult[] {
  const statusesBySection = new Map<MacroSection, Set<ScreenerStatus>>();
  for (const result of results) {
    const info = SCREENER_RULE_MACRO_INFO[result.id];
    if (!info) continue;
    if (!statusesBySection.has(info.section)) statusesBySection.set(info.section, new Set());
    statusesBySection.get(info.section)!.add(result.status);
  }

  return results.filter((result) => {
    const info = SCREENER_RULE_MACRO_INFO[result.id];
    if (!info) return true;
    const statuses = statusesBySection.get(info.section)!;
    const hasRecommended = statuses.has("routine") || statuses.has("risk");
    if (result.status === "not-indicated" && (hasRecommended || statuses.has("consider"))) return false;
    if (result.status === "consider" && hasRecommended) return false;
    return true;
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
