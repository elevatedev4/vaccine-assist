using VaccineAssist.Desktop.Views;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// AgePromptInput itself needs no WPF Window (see its own doc comment),
/// so it's covered here by fast xUnit tests instead of only a manual
/// trace, same "pure half" split as HotKeyMessageTests vs. GlobalHotKey
/// (which does need a real Window and isn't unit-tested).
///
/// 2026-09-25 round 2: years-only now (months dropped per Will's brief —
/// see AgePromptInput's doc comment).
/// </summary>
public class AgePromptInputTests
{
    [Theory]
    [InlineData("7", 7)]
    [InlineData(" 7 ", 7)]
    [InlineData("0", 0)]
    [InlineData("65", 65)]
    [InlineData("120", 120)]
    public void TryParse_AcceptsValidInput(string yearsText, int expectedYears)
    {
        var accepted = AgePromptInput.TryParse(yearsText, out var years);

        Assert.True(accepted);
        Assert.Equal(expectedYears, years);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("abc")]
    [InlineData("-1")]
    [InlineData("121")]
    [InlineData(null)]
    public void TryParse_RejectsInvalidYears(string? yearsText)
    {
        var accepted = AgePromptInput.TryParse(yearsText, out var years);

        Assert.False(accepted);
        Assert.Equal(0, years);
    }
}
