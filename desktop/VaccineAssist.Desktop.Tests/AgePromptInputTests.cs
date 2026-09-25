using VaccineAssist.Desktop.Views;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// AgePromptInput itself needs no WPF Window (see its own doc comment),
/// so it's covered here by fast xUnit tests instead of only a manual
/// trace, same "pure half" split as HotKeyMessageTests vs. GlobalHotKey
/// (which does need a real Window and isn't unit-tested).
/// </summary>
public class AgePromptInputTests
{
    [Theory]
    [InlineData("7", "", 7, null)]
    [InlineData(" 7 ", " ", 7, null)]
    [InlineData("0", "0", 0, 0)]
    [InlineData("1", "8", 1, 8)]
    [InlineData("120", "", 120, null)]
    public void TryParse_AcceptsValidInput(string yearsText, string monthsText, int expectedYears, int? expectedMonths)
    {
        var accepted = AgePromptInput.TryParse(yearsText, monthsText, out var years, out var months);

        Assert.True(accepted);
        Assert.Equal(expectedYears, years);
        Assert.Equal(expectedMonths, months);
    }

    [Theory]
    [InlineData("", "")]
    [InlineData("   ", "")]
    [InlineData("abc", "")]
    [InlineData("-1", "")]
    [InlineData("121", "")]
    [InlineData(null, "")]
    public void TryParse_RejectsInvalidYears(string? yearsText, string monthsText)
    {
        var accepted = AgePromptInput.TryParse(yearsText, monthsText, out var years, out var months);

        Assert.False(accepted);
        Assert.Equal(0, years);
        Assert.Null(months);
    }

    [Theory]
    [InlineData("1", "abc")]
    [InlineData("1", "-1")]
    [InlineData("1", "24")]
    public void TryParse_RejectsInvalidMonths(string yearsText, string monthsText)
    {
        var accepted = AgePromptInput.TryParse(yearsText, monthsText, out var years, out var months);

        Assert.False(accepted);
        Assert.Equal(0, years);
        Assert.Null(months);
    }

    [Fact]
    public void TryParse_TreatsNullMonthsTextAsBlank()
    {
        var accepted = AgePromptInput.TryParse("2", null, out var years, out var months);

        Assert.True(accepted);
        Assert.Equal(2, years);
        Assert.Null(months);
    }
}
