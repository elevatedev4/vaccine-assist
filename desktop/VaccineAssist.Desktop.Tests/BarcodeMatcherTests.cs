using VaccineAssist.Desktop.BarcodeCheck;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

public class BarcodeMatcherTests
{
    private static BarcodeMatcher With(params string[] numbers)
    {
        var matcher = new BarcodeMatcher();
        matcher.Load(numbers);
        return matcher;
    }

    [Fact]
    public void MatchesTheExactDigitString()
    {
        var matcher = With("100000000001", "100000000002");
        Assert.True(matcher.Contains("100000000001"));
        Assert.False(matcher.Contains("100000000003"));
    }

    [Fact]
    public void MatchesWhenOnlyLeadingZerosDiffer()
    {
        var matcher = With("0012345", "678");
        Assert.True(matcher.Contains("12345"));
        Assert.True(matcher.Contains("0000012345"));
        Assert.True(matcher.Contains("00678"));
    }

    [Fact]
    public void TrailingDigitDifferenceIsNotAMatch()
    {
        var matcher = With("12345");
        Assert.False(matcher.Contains("123450"));
        Assert.False(matcher.Contains("1234"));
    }

    [Fact]
    public void TrimsScannedWhitespace()
    {
        Assert.True(With("12345").Contains("  12345\t"));
    }

    [Fact]
    public void BlankAndNonDigitScansNeverMatch()
    {
        var matcher = With("12345", "0");
        Assert.False(matcher.Contains(""));
        Assert.False(matcher.Contains("   "));
        Assert.False(matcher.Contains(null));
        Assert.False(matcher.Contains("12A45"));
        Assert.False(matcher.Contains("12345.0"));
    }

    [Fact]
    public void ZeroMatchesAnyAllZeroString()
    {
        var matcher = With("000");
        Assert.True(matcher.Contains("0"));
    }

    [Fact]
    public void CountIgnoresDuplicates()
    {
        Assert.Equal(2, With("1", "01", "2").Count);
    }

    [Fact]
    public void ClearForgetsEverything()
    {
        var matcher = With("12345");
        matcher.Clear();
        Assert.Equal(0, matcher.Count);
        Assert.False(matcher.Contains("12345"));
    }

    [Fact]
    public void LoadReplacesThePreviousList()
    {
        var matcher = With("111");
        matcher.Load(new[] { "222" });
        Assert.False(matcher.Contains("111"));
        Assert.True(matcher.Contains("222"));
    }

    [Fact]
    public void HandlesAHundredThousandNumbers()
    {
        var matcher = new BarcodeMatcher();
        matcher.Load(Enumerable.Range(1, 100_000).Select(i => (100000000000L + i).ToString()));
        Assert.True(matcher.Contains("100000050000"));
        Assert.False(matcher.Contains("100000100001"));
    }
}
