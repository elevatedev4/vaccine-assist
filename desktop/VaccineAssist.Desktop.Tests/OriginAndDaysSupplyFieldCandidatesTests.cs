using System.Collections.Generic;
using VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing.Steps;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// Pure matcher tests for OriginAndDaysSupplyFieldCandidates — V-T41 R6
/// (Will's answer, 2026-09-30 1:11pm): "Origin needs to be set to Other
/// and Days supply needs to be set to 1." Same coverage shape as
/// DirectionsFieldCandidatesTests (the same underlying matching algorithm,
/// applied to two different candidate/keyword lists here) — see that
/// class's own doc comment for the full design.
/// </summary>
public class OriginAndDaysSupplyFieldCandidatesTests
{
    [Fact]
    public void Origin_MatchesTheFirstFixedCandidateWhenPresent()
    {
        var candidates = new List<FieldDescriptor>
        {
            new(AutomationId: "uxSomethingElse", Name: "Something else", ClassName: "WindowsForms10.Edit", ControlType: "Edit"),
            new(AutomationId: "uxOrigin", Name: "", ClassName: "WindowsForms10.ComboBox", ControlType: "ComboBox"),
        };

        var match = OriginAndDaysSupplyFieldCandidates.TryMatchOrigin(candidates);

        Assert.NotNull(match);
        Assert.Equal("uxOrigin", match!.Value.AutomationId);
    }

    [Fact]
    public void Origin_PrefersAnEarlierCandidateIdOverALaterOneEvenWhenTheLaterOneAppearsFirstInTheList()
    {
        var candidates = new List<FieldDescriptor>
        {
            new(AutomationId: "uxRxOrigin", Name: "", ClassName: "WindowsForms10.ComboBox", ControlType: "ComboBox"),
            new(AutomationId: "uxOrigin", Name: "", ClassName: "WindowsForms10.ComboBox", ControlType: "ComboBox"),
        };

        var match = OriginAndDaysSupplyFieldCandidates.TryMatchOrigin(candidates);

        Assert.Equal("uxOrigin", match!.Value.AutomationId);
    }

    [Fact]
    public void Origin_FallsBackToAKeywordMatchOnAComboBox()
    {
        var candidates = new List<FieldDescriptor>
        {
            new(AutomationId: "uxQuantityPrescribed", Name: "Quantity", ClassName: "WindowsForms10.Edit", ControlType: "Edit"),
            new(AutomationId: "uxOriginSelector", Name: "Origin", ClassName: "WindowsForms10.ComboBox", ControlType: "ComboBox"),
        };

        var match = OriginAndDaysSupplyFieldCandidates.TryMatchOrigin(candidates);

        Assert.NotNull(match);
        Assert.Equal("uxOriginSelector", match!.Value.AutomationId);
    }

    [Fact]
    public void Origin_KeywordFallbackNeverReturnsACandidateWithNoAutomationId()
    {
        var candidates = new List<FieldDescriptor>
        {
            new(AutomationId: null, Name: "Origin", ClassName: "WindowsForms10.ComboBox", ControlType: "ComboBox"),
        };

        var match = OriginAndDaysSupplyFieldCandidates.TryMatchOrigin(candidates);

        Assert.Null(match);
    }

    [Fact]
    public void Origin_ReturnsNullWhenNothingMatchesAtAll()
    {
        var candidates = new List<FieldDescriptor>
        {
            new(AutomationId: "uxQuantityPrescribed", Name: "Quantity", ClassName: "WindowsForms10.Edit", ControlType: "Edit"),
            new(AutomationId: "uxLotNumber", Name: "Lot", ClassName: "WindowsForms10.Edit", ControlType: "Edit"),
        };

        var match = OriginAndDaysSupplyFieldCandidates.TryMatchOrigin(candidates);

        Assert.Null(match);
    }

    [Fact]
    public void DaysSupply_MatchesTheFirstFixedCandidateWhenPresent()
    {
        var candidates = new List<FieldDescriptor>
        {
            new(AutomationId: "uxDaysSupplyPrescribed", Name: "", ClassName: "WindowsForms10.Edit", ControlType: "Edit"),
            new(AutomationId: "uxDaysSupply", Name: "", ClassName: "WindowsForms10.Edit", ControlType: "Edit"),
        };

        var match = OriginAndDaysSupplyFieldCandidates.TryMatchDaysSupply(candidates);

        // "uxDaysSupply" is checked before "uxDaysSupplyPrescribed" in
        // OriginAndDaysSupplyFieldCandidates.DaysSupplyAutomationIds,
        // regardless of which order the descriptors appear in.
        Assert.Equal("uxDaysSupply", match!.Value.AutomationId);
    }

    [Fact]
    public void DaysSupply_FallsBackToAKeywordMatchOnName()
    {
        var candidates = new List<FieldDescriptor>
        {
            new(AutomationId: "uxSupplyDays", Name: "Days Supply", ClassName: "WindowsForms10.Edit", ControlType: "Edit"),
        };

        var match = OriginAndDaysSupplyFieldCandidates.TryMatchDaysSupply(candidates);

        Assert.NotNull(match);
        Assert.Equal("uxSupplyDays", match!.Value.AutomationId);
    }

    [Fact]
    public void DaysSupply_KeywordFallbackIgnoresAComboBoxEvenWhenItsNameContainsTheKeyword()
    {
        var candidates = new List<FieldDescriptor>
        {
            new(AutomationId: "uxDaysSupplyPreset", Name: "Days Supply preset", ClassName: "WindowsForms10.ComboBox", ControlType: "ComboBox"),
        };

        var match = OriginAndDaysSupplyFieldCandidates.TryMatchDaysSupply(candidates);

        Assert.Null(match);
    }

    [Fact]
    public void DaysSupply_ReturnsNullForAnEmptyCandidateList()
    {
        var match = OriginAndDaysSupplyFieldCandidates.TryMatchDaysSupply(new List<FieldDescriptor>());

        Assert.Null(match);
    }
}
