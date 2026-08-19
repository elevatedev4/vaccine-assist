using VaccineAssist.Desktop.Models;

namespace VaccineAssist.Desktop.ViewModels;

/// <summary>
/// Pure decision behind the data-entry popup's "Enter into Pioneer"
/// button (V-T3 item 3: "Age-inappropriate → clear inline block with the
/// rule shown; appropriate → 'Enter into Pioneer' button").
///
/// AGE-BOUNDARY MATH LIVES SERVER-SIDE, NOT HERE — deliberately not
/// duplicated: cloud/lib/eligibility.ts is the single source of truth for
/// min/max age comparisons (both bounds INCLUSIVE — age below minAge or
/// above maxAge blocks; age == minAge or age == maxAge is allowed), and
/// is already covered by cloud/tests/eligibility.test.ts. Desktop only
/// consumes the resulting EligibilityResult.Status via
/// IVaccineApiService.EvaluateEligibilityAsync (same call EntryViewModel
/// already uses) — reimplementing the same numeric comparison in C# would
/// risk the two copies drifting apart. This class's own boundary is
/// simply the EligibilityResult.Status tri-state itself:
/// "blocked" -> cannot enter; "warning"/"allowed" -> can enter (a warning
/// is staff judgment, not a hard stop — same convention EntryViewModel's
/// GenerateAndCopy doc already documents for the existing Entry screen).
/// </summary>
public static class DataEntryGate
{
    public readonly record struct Decision(bool CanEnterIntoPioneer, string? BlockMessage);

    /// <param name="result">Null means "not validated yet" — treated as blocked (can't enter data for an unchecked age).</param>
    public static Decision Evaluate(EligibilityResult? result)
    {
        if (result is null)
        {
            return new Decision(false, null);
        }

        if (result.IsBlocked)
        {
            return new Decision(false, string.Join(" ", result.Reasons));
        }

        return new Decision(true, null);
    }
}
