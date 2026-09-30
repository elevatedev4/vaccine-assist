using System.Collections.Generic;
using VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing.Steps;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// Pure matcher tests for DirectionsFieldCandidates.TryMatch — V-T41 R5
/// (Will, 2026-09-29 8:15pm): "[Enter directions] FAILED — Couldn't find
/// the directions field (AutomationId 'uxDirections')" — see that class's
/// own doc comment for the full candidate-list/keyword-fallback design
/// this covers.
/// </summary>
public class DirectionsFieldCandidatesTests
{
    [Fact]
    public void MatchesTheFirstFixedCandidateWhenPresent()
    {
        var candidates = new List<FieldDescriptor>
        {
            new(AutomationId: "uxSomethingElse", Name: "Something else", ClassName: "WindowsForms10.Edit", ControlType: "Edit"),
            new(AutomationId: "uxDirections", Name: "", ClassName: "WindowsForms10.Edit", ControlType: "Edit"),
        };

        var match = DirectionsFieldCandidates.TryMatch(candidates);

        Assert.NotNull(match);
        Assert.Equal("uxDirections", match!.Value.AutomationId);
    }

    [Fact]
    public void PrefersAnEarlierCandidateIdOverALaterOneEvenWhenTheLaterOneAppearsFirstInTheList()
    {
        var candidates = new List<FieldDescriptor>
        {
            new(AutomationId: "uxSig", Name: "", ClassName: "WindowsForms10.Edit", ControlType: "Edit"),
            new(AutomationId: "uxDirections", Name: "", ClassName: "WindowsForms10.Edit", ControlType: "Edit"),
        };

        var match = DirectionsFieldCandidates.TryMatch(candidates);

        // "uxDirections" is checked before "uxSig" in DirectionsFieldCandidates.AutomationIds,
        // regardless of which order the descriptors themselves appear in.
        Assert.Equal("uxDirections", match!.Value.AutomationId);
    }

    [Fact]
    public void FallsBackToAKeywordMatchOnNameWhenNoFixedIdMatches()
    {
        var candidates = new List<FieldDescriptor>
        {
            new(AutomationId: "uxQuantityPrescribed", Name: "Quantity", ClassName: "WindowsForms10.Edit", ControlType: "Edit"),
            new(AutomationId: "uxSigInstructions", Name: "Sig", ClassName: "WindowsForms10.Edit", ControlType: "Edit"),
        };

        var match = DirectionsFieldCandidates.TryMatch(candidates);

        Assert.NotNull(match);
        Assert.Equal("uxSigInstructions", match!.Value.AutomationId);
    }

    [Fact]
    public void FallsBackToAKeywordMatchOnAutomationIdWhenNameDoesNotContainTheKeyword()
    {
        var candidates = new List<FieldDescriptor>
        {
            new(AutomationId: "uxDirectionsFreeText", Name: "Notes", ClassName: "WindowsForms10.Edit", ControlType: "Edit"),
        };

        var match = DirectionsFieldCandidates.TryMatch(candidates);

        Assert.NotNull(match);
        Assert.Equal("uxDirectionsFreeText", match!.Value.AutomationId);
    }

    [Fact]
    public void KeywordFallbackIgnoresAComboBoxEvenWhenItsNameContainsTheKeyword()
    {
        var candidates = new List<FieldDescriptor>
        {
            new(AutomationId: "uxDirectionTemplatePicker", Name: "Direction template", ClassName: "WindowsForms10.ComboBox", ControlType: "ComboBox"),
        };

        var match = DirectionsFieldCandidates.TryMatch(candidates);

        Assert.Null(match);
    }

    [Fact]
    public void KeywordFallbackNeverReturnsACandidateWithNoAutomationId()
    {
        // A field with the right Name but no AutomationId can't be re-found
        // by InputDirectionsStep's live typing path (which looks fields up
        // by AutomationId) — see DirectionsFieldCandidates.TryMatch's own
        // doc comment on why a stable id is required to act on a match.
        var candidates = new List<FieldDescriptor>
        {
            new(AutomationId: null, Name: "Sig", ClassName: "WindowsForms10.Edit", ControlType: "Edit"),
        };

        var match = DirectionsFieldCandidates.TryMatch(candidates);

        Assert.Null(match);
    }

    [Fact]
    public void ReturnsNullWhenNothingMatchesAtAll()
    {
        var candidates = new List<FieldDescriptor>
        {
            new(AutomationId: "uxQuantityPrescribed", Name: "Quantity", ClassName: "WindowsForms10.Edit", ControlType: "Edit"),
            new(AutomationId: "uxLotNumber", Name: "Lot", ClassName: "WindowsForms10.Edit", ControlType: "Edit"),
        };

        var match = DirectionsFieldCandidates.TryMatch(candidates);

        Assert.Null(match);
    }

    [Fact]
    public void ReturnsNullForAnEmptyCandidateList()
    {
        var match = DirectionsFieldCandidates.TryMatch(new List<FieldDescriptor>());

        Assert.Null(match);
    }
}
