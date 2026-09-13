using VaccineAssist.Desktop.Uia;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// PriorityValueMatcher — the pure, no-UIA-dependency "does this element's
/// Name represent the target Priority value" check used by
/// SendF3AndDismissPreEntryDialogsStep.TrySelectPriorityValue when scanning
/// the "Priority" popup's ComboBox/ListBox/DataGrid items (V-...,
/// 2026-09-13 priority-popup fix — see that step's own doc comment).
/// </summary>
public class PriorityValueMatcherTests
{
    [Theory]
    [InlineData("Vaccine", "Vaccine", true)]
    [InlineData("vaccine", "Vaccine", true)]
    [InlineData("VACCINE", "Vaccine", true)]
    [InlineData("Vaccine Administration", "Vaccine", true)] // Contains, not exact
    [InlineData("Routine", "Vaccine", false)]
    [InlineData("Flu Shot", "Vaccine", false)]
    public void MatchesIsContainsCaseInsensitive(string elementName, string targetValue, bool expected)
    {
        Assert.Equal(expected, PriorityValueMatcher.Matches(elementName, targetValue));
    }

    [Theory]
    [InlineData(null, "Vaccine")]
    [InlineData("", "Vaccine")]
    public void NullOrEmptyElementNameNeverMatches(string? elementName, string targetValue)
    {
        Assert.False(PriorityValueMatcher.Matches(elementName, targetValue));
    }

    [Fact]
    public void EmptyTargetValueNeverMatches()
    {
        Assert.False(PriorityValueMatcher.Matches("Vaccine", ""));
    }
}
