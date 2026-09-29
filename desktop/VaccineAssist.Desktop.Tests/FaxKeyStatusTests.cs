using System;
using VaccineAssist.Desktop.Fax;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// Notifyre-key-visibility follow-up (Will, 2026-09-28) — pure-text
/// coverage for FaxKeyStatus, independent of FaxSettingsViewModel's WPF-
/// adjacent dependencies. Synthetic values only.
/// </summary>
public class FaxKeyStatusTests
{
    [Fact]
    public void NoStoredTokenReportsNoKeySaved()
    {
        Assert.Equal("No key saved", FaxKeyStatus.Describe(null, null));
        Assert.Equal("No key saved", FaxKeyStatus.Describe("", DateTime.UtcNow));
        Assert.Equal("No key saved", FaxKeyStatus.Describe("   ", DateTime.UtcNow));
    }

    [Fact]
    public void AStoredTokenReportsItsLast4AndTheSavedTimeInLocalTime()
    {
        var savedAtUtc = new DateTime(2026, 9, 28, 19, 20, 0, DateTimeKind.Utc);

        var text = FaxKeyStatus.Describe("1234", savedAtUtc);

        Assert.Equal(
            $"Notifyre key saved (ends …1234, saved {savedAtUtc.ToLocalTime():yyyy-MM-dd HH:mm})",
            text);
    }

    [Fact]
    public void AStoredTokenWithNoKnownSavedTimeReportsUnknownTimeRatherThanABlankOrWrongDate()
    {
        var text = FaxKeyStatus.Describe("1234", null);

        Assert.Equal("Notifyre key saved (ends …1234, saved unknown time)", text);
    }

    [Theory]
    [InlineData(null, "")]
    [InlineData("", "")]
    [InlineData("abc", "abc")] // shorter than 4 — shows in full, nothing shorter to hide.
    [InlineData("abcd", "abcd")]
    [InlineData("abcde", "bcde")]
    [InlineData("synthetic-notifyre-token-9f8e7d6c", "7d6c")]
    public void Last4OfTokenReturnsTheLastFourCharactersOrTheWholeTokenWhenShorter(string? token, string expected)
    {
        Assert.Equal(expected, FaxKeyStatus.Last4OfToken(token));
    }
}
