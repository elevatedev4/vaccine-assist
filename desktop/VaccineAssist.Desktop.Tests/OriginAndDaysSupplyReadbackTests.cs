using VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing.Steps;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// Pure comparison tests for OriginAndDaysSupplyReadback — V-T41 R6.
/// See that class's own doc comment for why a plain trimmed
/// case-insensitive equal (InputLotAndExpirationStep.VerifyFieldTyped's
/// comparison) isn't enough for either field.
/// </summary>
public class OriginAndDaysSupplyReadbackTests
{
    [Theory]
    [InlineData("Other", "Other")]
    [InlineData("other", "Other")]
    [InlineData("  Other  ", "Other")]
    public void OriginMatches_ExactCaseInsensitiveTrim(string actual, string expected)
    {
        Assert.True(OriginAndDaysSupplyReadback.OriginMatches(actual, expected));
    }

    [Theory]
    [InlineData("9 - Other", "Other")]
    [InlineData("9-Other", "Other")]
    [InlineData("OTH - other", "Other")]
    public void OriginMatches_ACodedComboBoxDisplayValue(string actual, string expected)
    {
        Assert.True(OriginAndDaysSupplyReadback.OriginMatches(actual, expected));
    }

    [Theory]
    [InlineData("", "Other")]
    [InlineData(null, "Other")]
    [InlineData("Written", "Other")]
    [InlineData("9 - Written", "Other")]
    public void OriginMatches_RejectsAnythingElse(string? actual, string expected)
    {
        Assert.False(OriginAndDaysSupplyReadback.OriginMatches(actual, expected));
    }

    [Theory]
    [InlineData("1", "1")]
    [InlineData("1.0", "1")]
    [InlineData("01", "1")]
    [InlineData(" 1 ", "1")]
    public void DaysSupplyMatches_NumericEquivalents(string actual, string expected)
    {
        Assert.True(OriginAndDaysSupplyReadback.DaysSupplyMatches(actual, expected));
    }

    [Theory]
    [InlineData("", "1")]
    [InlineData(null, "1")]
    [InlineData("2", "1")]
    [InlineData("abc", "1")]
    public void DaysSupplyMatches_RejectsAnythingElse(string? actual, string expected)
    {
        Assert.False(OriginAndDaysSupplyReadback.DaysSupplyMatches(actual, expected));
    }
}
