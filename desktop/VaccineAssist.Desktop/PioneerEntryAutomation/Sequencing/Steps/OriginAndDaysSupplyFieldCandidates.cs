using System;
using System.Collections.Generic;
using System.Linq;

namespace VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing.Steps;

/// <summary>
/// V-T41 R6 (Will's answer, 2026-09-30 1:11pm, verbatim): "Origin needs to
/// be set to Other and Days supply needs to be set to 1." Same
/// "fixed-candidate-list, then keyword fallback" shape as
/// DirectionsFieldCandidates (see that class's own doc comment for the
/// full rationale) — reused here rather than shared, since the two fields
/// have different candidate ids AND different keyword-fallback control
/// types (Origin is plausibly a ComboBox in PioneerRx; Days Supply, like
/// every other plain numeric/text field on this screen, is not).
///
/// ORIGIN — NO CONFIRMED AutomationId: unlike every id InputOriginAndDaysSupplyStep's
/// sibling steps use (uxLotNumber, uxQuantityPrescribed, uxPrescribedItemQuickSearch,
/// etc. — each confirmed against a live "Add New Rx" UIA dump), no dump has
/// ever shown an Origin field at all. <see cref="OriginAutomationIds"/> are
/// PLACEHOLDER guesses following this app's own "ux" + PascalCase naming
/// convention (same posture InputDirectionsStep.DirectionsAutomationId
/// started from before DirectionsFieldCandidates existed) — InputOriginAndDaysSupplyStep
/// treats a miss on every one of these (and the keyword fallback below) as
/// expected, not a bug: it logs one field dump and moves on rather than
/// failing the whole vaccine entry over a still-unconfirmed field.
///
/// DAYS SUPPLY — PARTIALLY CONFIRMED: "uxDaysSupply" itself is a real
/// AutomationId InputVaccineCodeStep's own doc comment already names (the
/// 2026-09-05 live dumps showed it auto-populating from the resolved drug
/// record, which is why no step has ever TYPED into it before now) — kept
/// first in <see cref="DaysSupplyAutomationIds"/> as the primary guess,
/// with the same keyword-fallback safety net as Origin in case the actual
/// "Add New Rx" screen uses a different id than whatever dump that comment
/// refers to.
///
/// PURE matcher, no FlaUI/UIA dependency — see
/// OriginAndDaysSupplyFieldCandidatesTests.cs.
/// </summary>
public static class OriginAndDaysSupplyFieldCandidates
{
    public static readonly IReadOnlyList<string> OriginAutomationIds = new[]
    {
        "uxOrigin",
        "uxRxOrigin",
        "uxOriginCode",
        "uxScriptOrigin",
    };

    public static readonly IReadOnlyList<string> DaysSupplyAutomationIds = new[]
    {
        "uxDaysSupply", // InputVaccineCodeStep's own doc comment — confirmed real, never typed into before now.
        "uxDaysSupplyPrescribed",
        "uxDaySupply",
    };

    private static readonly string[] OriginKeywords = { "origin" };
    private static readonly string[] DaysSupplyKeywords = { "dayssupply", "days supply", "day supply" };

    /// <summary>Origin is plausibly a dropdown in PioneerRx — ComboBox is
    /// included here, unlike Directions' keyword fallback (which
    /// deliberately excludes it — a sig field is always free text).</summary>
    private static readonly string[] OriginKeywordControlTypes = { "Edit", "ComboBox" };

    /// <summary>Days supply is a plain numeric/text field, same shape as
    /// Quantity/Lot — no ComboBox expected.</summary>
    private static readonly string[] DaysSupplyKeywordControlTypes = { "Edit" };

    public static FieldDescriptor? TryMatchOrigin(IReadOnlyList<FieldDescriptor> candidates) =>
        TryMatch(candidates, OriginAutomationIds, OriginKeywords, OriginKeywordControlTypes);

    public static FieldDescriptor? TryMatchDaysSupply(IReadOnlyList<FieldDescriptor> candidates) =>
        TryMatch(candidates, DaysSupplyAutomationIds, DaysSupplyKeywords, DaysSupplyKeywordControlTypes);

    /// <summary>Same algorithm as DirectionsFieldCandidates.TryMatch: an
    /// exact (case-insensitive) AutomationId match against `ids`, checked
    /// in order across the whole candidate list before moving to the next
    /// id; failing that, the first candidate of one of `controlTypes` whose
    /// Name OR AutomationId contains one of `keywords` (case-insensitive) —
    /// but only when it has a non-blank AutomationId (a Name-only match
    /// can't be re-found/acted on by AutomationId later). Null when nothing
    /// qualifies.</summary>
    private static FieldDescriptor? TryMatch(
        IReadOnlyList<FieldDescriptor> candidates, IReadOnlyList<string> ids, IReadOnlyList<string> keywords, IReadOnlyList<string> controlTypes)
    {
        foreach (var id in ids)
        {
            foreach (var candidate in candidates)
            {
                if (!string.IsNullOrEmpty(candidate.AutomationId) &&
                    string.Equals(candidate.AutomationId, id, StringComparison.OrdinalIgnoreCase))
                {
                    return candidate;
                }
            }
        }

        foreach (var candidate in candidates)
        {
            if (string.IsNullOrEmpty(candidate.AutomationId)) continue;
            if (candidate.ControlType is null ||
                !controlTypes.Contains(candidate.ControlType, StringComparer.OrdinalIgnoreCase))
            {
                continue;
            }

            if (ContainsKeyword(candidate.Name, keywords) || ContainsKeyword(candidate.AutomationId, keywords))
            {
                return candidate;
            }
        }

        return null;
    }

    private static bool ContainsKeyword(string? text, IReadOnlyList<string> keywords) =>
        !string.IsNullOrEmpty(text) && keywords.Any(k => text.Contains(k, StringComparison.OrdinalIgnoreCase));
}
