using VaccineAssist.Desktop.Uia;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// V-... Part A: UiaTreeDumper's only pure, no-live-UIA-session-dependency
/// logic (TruncateValue's PHI-minimization rule) — everything else in that
/// class is bound to a live FlaUI AutomationElement with no synthetic
/// construction path (same "not unit tested, live-UIA-bound" situation
/// rx-verify's own UiaTreeWalker.cs documents for its equivalent methods).
/// </summary>
public class UiaTreeDumperTruncationTests
{
    [Fact]
    public void ValueAtOrUnderTheLimitPassesThroughUnchanged()
    {
        var value = new string('a', 40);
        Assert.Equal(value, UiaTreeDumper.TruncateValue(value));
    }

    [Fact]
    public void ValueOverTheLimitIsCutToFortyCharsWithATruncationMarker()
    {
        var value = new string('a', 41);

        var result = UiaTreeDumper.TruncateValue(value);

        Assert.StartsWith(new string('a', 40), result);
        Assert.Contains("truncated", result);
        Assert.True(result.Length > 40);
    }

    [Fact]
    public void EmptyValueStaysEmpty()
    {
        Assert.Equal("", UiaTreeDumper.TruncateValue(""));
    }
}
