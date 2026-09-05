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
 */

export interface Physician {
  id: string;
  displayName: string;
  alternateId: string;
}

export interface PhysicianRule {
  id: string;
  physicianId: string;
  /** null = applies to any vaccine (the wildcard/"everything else" fallback rule). */
  vaccineId: string | null;
  minAge: number | null;
  maxAge: number | null;
  priority: number;
}

export interface PhysicianResolutionSubject {
  vaccineId: string;
  ageYears: number;
}

/**
 * Picks the single best-matching rule for a vaccine + age, or null if
 * none applies. A rule naming this exact vaccine ALWAYS outranks a
 * wildcard (vaccineId === null) rule for the same age — the whole point
 * of a wildcard rule is to be the "everything else" fallback, so a more
 * specific rule must never lose to it regardless of `priority`.
 * `priority` (lower wins) only breaks ties within the same specificity
 * tier, mirroring eligibility_rule.priority's convention.
 */
export function resolvePhysicianRule(
  rules: PhysicianRule[],
  subject: PhysicianResolutionSubject
): PhysicianRule | null {
  const matching = rules.filter((rule) => {
    if (rule.vaccineId !== null && rule.vaccineId !== subject.vaccineId) return false;
    if (rule.minAge !== null && subject.ageYears < rule.minAge) return false;
    if (rule.maxAge !== null && subject.ageYears > rule.maxAge) return false;
    return true;
  });

  if (matching.length === 0) return null;

  const sorted = [...matching].sort((a, b) => {
    const aSpecific = a.vaccineId !== null ? 0 : 1;
    const bSpecific = b.vaccineId !== null ? 0 : 1;
    if (aSpecific !== bSpecific) return aSpecific - bSpecific;
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
