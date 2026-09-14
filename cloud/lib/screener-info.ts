/**
 * Pure describer for the /screener/info page (companion to the
 * eligibility screener at app/screener/page.tsx — Will 2026-09-13:
 * "Add an info page to be able to see the list of all conditions/age
 * ranges for each vaccine too.").
 *
 * Like lib/screener.ts, this has no I/O and no React: `describeRules`
 * takes the same SCREENER_RULES + CONDITION_ITEMS data the screener
 * itself reads and turns each vaccine's tier list into plain,
 * display-ready strings (age range text, condition labels, reasons,
 * deduped source links) grouped by tier status. app/screener/info/
 * page.tsx renders this data; it doesn't interpret the rule shape
 * itself, so the info page automatically follows whatever the rule
 * data says without needing its own updates when the rules change.
 *
 * Deliberately does not touch lib/screener-rules.ts or lib/screener.ts
 * — the rule data is being re-researched in parallel (see the brief);
 * this file only reads their exported shapes.
 */

import type {
  ConditionItem,
  ConditionKey,
  DerivedConditionKey,
  ScreenerStatus,
  ScreenerTier,
  ScreenerVaccineRule,
} from "./screener-rules";

/** One tier (or the fallback, treated as a tier with no age/condition
 * gate) rendered as plain strings ready to display as-is. */
export interface DescribedTier {
  /** Always a human string — never null — e.g. "50+", "19–59", "6 mo+",
   * "up to 26", or "any age" when the tier has no age gate at all. */
  ageRangeText: string;
  /** Condition labels this tier gates on, sorted alphabetically
   * (case-insensitive) by label, or null when the tier has no
   * condition gate at all. */
  conditions: string[] | null;
  reason: string;
}

export interface DescribedVaccine {
  id: string;
  name: string;
  /** Deduped source URL(s) referenced by this vaccine's tiers/fallback —
   * in practice always length 1 today (sourceUrl lives on the rule, not
   * per-tier), but kept as a list in case that ever changes. */
  sources: string[];
  routine: DescribedTier[];
  /** "risk" status tiers — recommended because of a checked condition. */
  conditionBased: DescribedTier[];
  consider: DescribedTier[];
  caution: DescribedTier[];
  notIndicated: DescribedTier[];
  /** "info" status — needs a question the form doesn't ask. */
  info: DescribedTier[];
}

/** Special-cased labels for the two keys that are computed from the
 * checkboxes rather than being a checkbox themselves (see
 * DerivedConditionKey in screener-rules.ts) — they have no entry in
 * CONDITION_ITEMS so need their own display text. */
const DERIVED_ONLY_LABELS: Record<"diabetesSubItem" | "anyCondition", string> = {
  diabetesSubItem: "a diabetes-related condition (neuropathy, retinopathy, insulin, or SGLT2-I)",
  anyCondition: "any checked condition",
};

function conditionLabel(key: DerivedConditionKey, labelsByKey: Map<ConditionKey, string>): string {
  if (key === "diabetesSubItem" || key === "anyCondition") return DERIVED_ONLY_LABELS[key];
  return labelsByKey.get(key) ?? key;
}

function describeConditions(
  keys: DerivedConditionKey[] | undefined,
  labelsByKey: Map<ConditionKey, string>
): string[] | null {
  if (!keys || keys.length === 0) return null;
  return keys
    .map((key) => conditionLabel(key, labelsByKey))
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

/** Formats a single age bound in years as either a whole-number-of-years
 * string or, for a fractional year (0.5 = 6 months), a "N mo" string. */
function formatAgeBound(years: number): string {
  if (years < 1) return `${Math.round(years * 12)} mo`;
  return `${years}`;
}

/** Formats a tier's inclusive [ageMin, ageMax] (both optional, matching
 * ScreenerTier's own defaults of 0 and Infinity) as display text. Never
 * returns null so callers can render it unconditionally. */
function formatAgeRange(ageMin: number | undefined, ageMax: number | undefined): string {
  const min = ageMin ?? 0;
  const max = ageMax ?? Infinity;
  if (min <= 0 && max === Infinity) return "any age";
  if (max === Infinity) return `${formatAgeBound(min)}+`;
  if (min <= 0) return `up to ${formatAgeBound(max)}`;
  return `${formatAgeBound(min)}–${formatAgeBound(max)}`;
}

function describeTier(
  tier: Pick<ScreenerTier, "ageMin" | "ageMax" | "requiredConditions" | "reason">,
  labelsByKey: Map<ConditionKey, string>
): DescribedTier {
  return {
    ageRangeText: formatAgeRange(tier.ageMin, tier.ageMax),
    conditions: describeConditions(tier.requiredConditions, labelsByKey),
    reason: tier.reason,
  };
}

function emptyBuckets(): Pick<
  DescribedVaccine,
  "routine" | "conditionBased" | "consider" | "caution" | "notIndicated" | "info"
> {
  return { routine: [], conditionBased: [], consider: [], caution: [], notIndicated: [], info: [] };
}

function bucketFor(
  buckets: ReturnType<typeof emptyBuckets>,
  status: ScreenerStatus
): DescribedTier[] {
  switch (status) {
    case "routine":
      return buckets.routine;
    case "risk":
      return buckets.conditionBased;
    case "consider":
      return buckets.consider;
    case "caution":
      return buckets.caution;
    case "not-indicated":
      return buckets.notIndicated;
    case "info":
      return buckets.info;
  }
}

/**
 * Describes every vaccine in `rules` for display on the info page.
 * Walks each rule's tiers IN ORDER plus its fallback (treated as a
 * trailing tier with no age/condition gate), bucketing each into the
 * status category it belongs to. Rules/labels are passed in rather than
 * imported so this stays a pure function of its inputs (and testable
 * against a small synthetic rule set) — callers pass SCREENER_RULES and
 * CONDITION_ITEMS from lib/screener-rules.ts.
 */
export function describeRules(
  rules: ScreenerVaccineRule[],
  conditionItems: ConditionItem[]
): DescribedVaccine[] {
  const labelsByKey = new Map(conditionItems.map((item) => [item.key, item.label]));

  return rules.map((rule) => {
    const buckets = emptyBuckets();
    const sources = new Set<string>();

    for (const tier of rule.tiers) {
      sources.add(rule.sourceUrl);
      bucketFor(buckets, tier.status).push(describeTier(tier, labelsByKey));
    }

    // The fallback always applies when nothing above matched — describe
    // it the same way as a tier with no age/condition gate of its own.
    sources.add(rule.sourceUrl);
    bucketFor(buckets, rule.fallback.status).push(
      describeTier({ reason: rule.fallback.reason }, labelsByKey)
    );

    return {
      id: rule.id,
      name: rule.name,
      sources: [...sources],
      ...buckets,
    };
  });
}
