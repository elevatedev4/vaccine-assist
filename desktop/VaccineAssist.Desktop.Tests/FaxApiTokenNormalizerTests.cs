using VaccineAssist.Desktop.Fax;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// V-T53 follow-up (Will, 2026-09-25, verbatim: "I know the token is
/// correct. I got it myself... Fix the app."): Notifyre's "Access denied"
/// 401 body is byte-identical for a missing token AND a garbage one, so a
/// paste artifact plain .Trim() doesn't catch (zero-width characters, a
/// "Bearer " prefix, surrounding quotes) is invisible in the UI and looks
/// exactly like "the token itself is wrong." These tests pin down exactly
/// what FaxApiTokenNormalizer strips. "test-token" below is a synthetic
/// fixture, never a real Notifyre API token.
/// </summary>
public class FaxApiTokenNormalizerTests
{
    [Fact]
    public void TrimsOrdinaryWhitespace()
    {
        Assert.Equal("test-token", FaxApiTokenNormalizer.Normalize("  test-token\r\n"));
    }

    [Theory]
    [InlineData("​test-token")] // zero-width space, leading
    [InlineData("test-token​")] // zero-width space, trailing
    [InlineData("te​st-token")] // zero-width space, mid-string
    [InlineData("﻿test-token")] // BOM / zero-width no-break space, leading
    [InlineData("test-token﻿")] // BOM, trailing
    [InlineData("‌test-token‍")] // zero-width non-joiner + joiner
    [InlineData("⁠test-token")] // word joiner
    public void StripsZeroWidthAndFormatCharactersAnywhere(string raw)
    {
        Assert.Equal("test-token", FaxApiTokenNormalizer.Normalize(raw));
    }

    [Fact]
    public void StripsSurroundingDoubleQuotes()
    {
        Assert.Equal("test-token", FaxApiTokenNormalizer.Normalize("\"test-token\""));
    }

    [Fact]
    public void StripsSurroundingSingleQuotes()
    {
        Assert.Equal("test-token", FaxApiTokenNormalizer.Normalize("'test-token'"));
    }

    [Fact]
    public void StripsBearerPrefix()
    {
        Assert.Equal("test-token", FaxApiTokenNormalizer.Normalize("Bearer test-token"));
    }

    [Fact]
    public void StripsBearerPrefixCaseInsensitively()
    {
        Assert.Equal("test-token", FaxApiTokenNormalizer.Normalize("bearer test-token"));
    }

    [Fact]
    public void StripsQuotesAndBearerPrefixTogether()
    {
        Assert.Equal("test-token", FaxApiTokenNormalizer.Normalize("\"Bearer test-token\""));
    }

    [Fact]
    public void StripsControlCharactersEmbeddedMidString()
    {
        Assert.Equal("testtoken", FaxApiTokenNormalizer.Normalize("test\ttoken"));
    }

    [Fact]
    public void LeavesAnAlreadyCleanTokenUnchanged()
    {
        Assert.Equal("test-token", FaxApiTokenNormalizer.Normalize("test-token"));
    }

    [Fact]
    public void NullBecomesEmptyString()
    {
        Assert.Equal("", FaxApiTokenNormalizer.Normalize(null));
    }

    [Fact]
    public void EmptyStringStaysEmpty()
    {
        Assert.Equal("", FaxApiTokenNormalizer.Normalize(""));
    }

    [Fact]
    public void WhitespaceAndZeroWidthOnlyBecomesEmpty()
    {
        Assert.Equal("", FaxApiTokenNormalizer.Normalize("  ​﻿  "));
    }

    [Fact]
    public void DoesNotStripAQuoteThatIsNotBothLeadingAndTrailing()
    {
        // A stray single quote (e.g. an actual character in the token) is
        // NOT a surrounding-quote pair, so it must survive.
        Assert.Equal("test\"token", FaxApiTokenNormalizer.Normalize("test\"token"));
    }
}
