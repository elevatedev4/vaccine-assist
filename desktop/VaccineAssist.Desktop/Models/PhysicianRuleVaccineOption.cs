namespace VaccineAssist.Desktop.Models;

/// <summary>
/// One selectable item in the Physicians settings tab's grouped vaccine
/// ComboBox (Will, 2026-09-07: "vaccine types as group headers... with an
/// 'All &lt;group&gt; vaccines' selectable item per group... and specific
/// vaccines beneath"). See PhysiciansViewModel.BuildVaccineOptions for how
/// this list is built (VaccineGroupCatalog.DisplayOrder order, "All ...
/// vaccines" first within each group, then that group's vaccines by name)
/// and PhysicianRuleMatcher for the specific &gt; group &gt; wildcard
/// precedence this enables.
///
/// Two shapes:
///   - A GROUP option (Vaccine null, IsGroupWildcard true) — persists
///     PhysicianRule.VaccineGroup with VaccineId left null.
///   - A SPECIFIC-VACCINE option (Vaccine set) — persists
///     PhysicianRule.VaccineId with VaccineGroup left null. Group is still
///     set here (to that vaccine's own VaccineGroupCatalog group) purely so
///     the ComboBox can render it under the right group header — it is
///     never itself persisted for a specific-vaccine rule.
/// </summary>
public sealed class PhysicianRuleVaccineOption
{
    public required string Group { get; init; }

    /// <summary>What the ComboBox shows for this item — "All &lt;Group&gt; vaccines" or a vaccine's Name.</summary>
    public required string DisplayText { get; init; }

    /// <summary>Null means this is the "All &lt;Group&gt; vaccines" option for Group.</summary>
    public Vaccine? Vaccine { get; init; }

    public bool IsGroupWildcard => Vaccine is null;
}
