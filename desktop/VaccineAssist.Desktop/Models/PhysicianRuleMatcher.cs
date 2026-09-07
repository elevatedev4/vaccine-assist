using System;
using System.Collections.Generic;
using System.Linq;

namespace VaccineAssist.Desktop.Models;

/// <summary>
/// Pure specific &gt; group &gt; wildcard physician-rule matching precedence
/// (Will, 2026-09-07: assign vaccine TYPES, not just specific vaccines, to
/// a protocol physician). Mirrors cloud/lib/physician-resolution.ts's
/// resolvePhysicianRule, extended with a middle "vaccine_group" tier
/// between the specific-vaccine tier and the wildcard ("any vaccine")
/// tier: a rule naming this exact vaccine (VaccineId) always outranks one
/// naming only its VaccineGroupCatalog group, which in turn always
/// outranks a wildcard (both VaccineId and VaccineGroup null) rule,
/// regardless of Priority — Priority only breaks ties WITHIN the same
/// specificity tier, same "lower wins" convention eligibility_rule.priority
/// already uses.
///
/// JUDGMENT CALL (flagged for Will): live "Enter into Pioneer" resolution
/// still goes through the existing cloud API call
/// (IVaccineApiService.ResolvePhysicianAsync, GET /api/physicians/resolve)
/// — this class is NOT wired into
/// DataEntryPopupViewModel.BuildLivePayloadAsync. cloud/lib/physician-resolution.ts
/// is owned by a parallel migration effort adding physician_rule.vaccine_group
/// (out of scope for this change — see this repo's TODO.md 2026-09-07
/// entry), so whether the SERVER applies this same specific&gt;group&gt;wildcard
/// precedence depends on that other work landing. This class exists so the
/// desktop app itself has a correct, independently-tested implementation
/// of the precedence rule (per the brief: "Rule matching in the desktop
/// app honors: specific &gt; group &gt; wildcard") ready to use — swapping
/// BuildLivePayloadAsync to call this instead of ResolvePhysicianAsync is a
/// small, one-line-ish change once Will confirms that's what he wants;
/// doing it unasked risked breaking PhysicianResolutionGateTests.cs's
/// existing ResolvePhysicianAsync-call-count assertions for no confirmed
/// benefit.
/// </summary>
public static class PhysicianRuleMatcher
{
    /// <summary>
    /// Picks the single best-matching rule for a vaccine + age, or null if
    /// none applies.
    /// </summary>
    public static PhysicianRule? Resolve(IEnumerable<PhysicianRule> rules, Vaccine vaccine, int ageYears)
    {
        var group = VaccineGroupCatalog.GetGroup(vaccine);

        var matching = rules.Where(rule =>
        {
            if (rule.VaccineId is Guid ruleVaccineId && ruleVaccineId != vaccine.Id) return false;
            if (rule.VaccineId is null && !string.IsNullOrEmpty(rule.VaccineGroup) &&
                !string.Equals(rule.VaccineGroup, group, StringComparison.OrdinalIgnoreCase)) return false;
            if (rule.MinAge is int minAge && ageYears < minAge) return false;
            if (rule.MaxAge is int maxAge && ageYears > maxAge) return false;
            return true;
        }).ToList();

        if (matching.Count == 0) return null;

        return matching
            .OrderBy(SpecificityRank)
            .ThenBy(rule => rule.Priority)
            .First();
    }

    /// <summary>0 = names this exact vaccine, 1 = names this vaccine's group, 2 = wildcard (neither).</summary>
    private static int SpecificityRank(PhysicianRule rule)
    {
        if (rule.VaccineId is not null) return 0;
        if (!string.IsNullOrEmpty(rule.VaccineGroup)) return 1;
        return 2;
    }
}
