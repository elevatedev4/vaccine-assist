/**
 * Protocol-physician resolution — given a vaccine + patient age, which
 * physician's alternate ID should PioneerEntryAutomation's prescriber-entry
 * step type into PioneerRx. See supabase/migrations/0007_physicians.sql
 * for the `physician` / `physician_rule` tables this reads from, and
 * that migration's own doc comment for the real-world example this
 * models (federal PREP act vs. Kansas statewide pharmacy protocol).
 *
 * Deliberately conservative, same posture as cloud/lib/eligibility.ts:
 * no match resolves to `null`, never a guess — the desktop app blocks
 * "Enter into Pioneer" and points staff at the Physicians settings tab
 * rather than typing an unconfirmed alternate ID into a real patient's
 * chart.
 *
 * V-cloud-tabs (Will, 2026-09-05/07): a rule can also target an entire
 * vaccine GROUP (flu, COVID, Tdap, pneumonia, ... — see
 * lib/vaccine-group-catalog.ts) instead of one specific vaccine, via
 * `vaccineGroup` / `physician_rule.vaccine_group`
 * (supabase/migrations/0009_lots_bud_vaccine_defaults.sql). Three
 * specificity tiers now, most to least specific: a rule naming this
 * exact vaccine (vaccineId set) > a rule naming this vaccine's group
 * (vaccineGroup set, vaccineId null) > the wildcard (both null). Each
 * tier always outranks every rule in a less-specific tier for the same
 * age, regardless of `priority` — `priority` (lower wins) only breaks
 * ties WITHIN one tier, same as before.
 *
 * `vaccineGroup` is optional on both the rule and the subject so this
 * stays backward compatible with callers that don't know about groups
 * yet (pre-migration, or not yet updated) — a rule/subject that omits it
 * behaves exactly as it did before this field existed.
 */

export interface Physician {
  id: string;
  displayName: string;
  alternateId: string;
}

export interface PhysicianRule {
  id: string;
  physicianId: string;
  /** null = applies to any vaccine (the wildcard/"everything else" fallback rule), UNLESS vaccineGroup is set. */
  vaccineId: string | null;
  /** Set only when vaccineId is null: this rule targets every product in this catalog group (e.g. "Flu") rather than one specific vaccine. Optional — omitted/undefined means "not a group rule" (a plain wildcard, or pre-migration data). */
  vaccineGroup?: string | null;
  minAge: number | null;
  maxAge: number | null;
  priority: number;
}

export interface PhysicianResolutionSubject {
  vaccineId: string;
  /** This vaccine's catalog group (getVaccineGroup(vaccine.name)) — omit if unknown/unavailable; group rules simply won't match without it. */
  vaccineGroup?: string | null;
  ageYears: number;
}

/** 0 = specific-vaccine rule, 1 = group rule, 2 = wildcard. Lower always outranks higher regardless of priority. */
function specificityTier(rule: PhysicianRule): 0 | 1 | 2 {
  if (rule.vaccineId !== null) return 0;
  if (rule.vaccineGroup) return 1;
  return 2;
}

/**
 * Picks the single best-matching rule for a vaccine + age, or null if
 * none applies. See the specificity-tier doc comment above this file's
 * interfaces for the exact tie-break order.
 */
export function resolvePhysicianRule(
  rules: PhysicianRule[],
  subject: PhysicianResolutionSubject
): PhysicianRule | null {
  const matching = rules.filter((rule) => {
    if (rule.vaccineId !== null) {
      if (rule.vaccineId !== subject.vaccineId) return false;
    } else if (rule.vaccineGroup) {
      if (!subject.vaccineGroup || rule.vaccineGroup !== subject.vaccineGroup) return false;
    }
    // else: wildcard rule (vaccineId and vaccineGroup both unset) — no vaccine-dimension filter.
    if (rule.minAge !== null && subject.ageYears < rule.minAge) return false;
    if (rule.maxAge !== null && subject.ageYears > rule.maxAge) return false;
    return true;
  });

  if (matching.length === 0) return null;

  const sorted = [...matching].sort((a, b) => {
    const tierDiff = specificityTier(a) - specificityTier(b);
    if (tierDiff !== 0) return tierDiff;
    return a.priority - b.priority;
  });

  return sorted[0];
}

/** resolvePhysicianRule, then joins the winning rule to its Physician row. Null if either step comes up empty. */
export function resolvePhysician(
  rules: PhysicianRule[],
  physicians: Physician[],
  subject: PhysicianResolutionSubject
): Physician | null {
  const rule = resolvePhysicianRule(rules, subject);
  if (!rule) return null;
  return physicians.find((physician) => physician.id === rule.physicianId) ?? null;
}
