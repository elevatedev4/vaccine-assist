using VaccineAssist.Desktop.Services;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// V-T55 (Will, 2026-09-25 verbatim: "It should show the same names
/// everywhere that it is applicable.") — the desktop app's own
/// implementation of cloud/lib/vaccine-display-name.ts's
/// vaccineDisplayName rule (re-implemented here, not read off the wire,
/// so the desktop doesn't depend on the parallel cloud change adding a
/// displayName field to the JSON payloads). See VaccineDisplayName.For's
/// own doc comment for the exact rule.
/// </summary>
public class VaccineDisplayNameTests
{
    [Theory]
    [InlineData("Comirnaty", "Pfizer Comirnaty")]
    [InlineData("Comirnaty 2026-27 12+", "Pfizer Comirnaty 2026-27 12+")]
    [InlineData("Spikevax", "Moderna Spikevax")]
    [InlineData("Spikevax 2026-27", "Moderna Spikevax 2026-27")]
    [InlineData("mNEXSPIKE", "Moderna mNEXSPIKE")]
    [InlineData("mNEXSPIKE 2026-27", "Moderna mNEXSPIKE 2026-27")]
    public void PrefixesTheMakerOntoEachCovidProduct(string name, string expected)
    {
        Assert.Equal(expected, VaccineDisplayName.For(name));
    }

    [Theory]
    [InlineData("comirnaty", "Pfizer comirnaty")]
    [InlineData("COMIRNATY 2026-27", "Pfizer COMIRNATY 2026-27")]
    [InlineData("SpikeVax", "Moderna SpikeVax")]
    [InlineData("mnexspike", "Moderna mnexspike")]
    [InlineData("MNEXSPIKE", "Moderna MNEXSPIKE")]
    public void MatchingIsCaseInsensitiveButOriginalCasingIsPreserved(string name, string expected)
    {
        Assert.Equal(expected, VaccineDisplayName.For(name));
    }

    [Theory]
    [InlineData("Pfizer Comirnaty 2026-27 12+")]
    [InlineData("Moderna Spikevax")]
    [InlineData("Moderna mNEXSPIKE 2026-27")]
    [InlineData("pfizer Comirnaty")]
    [InlineData("MODERNA Spikevax")]
    public void AlreadyPrefixedNamesAreReturnedUnchangedNotDoublePrefixed(string alreadyPrefixed)
    {
        Assert.Equal(alreadyPrefixed, VaccineDisplayName.For(alreadyPrefixed));
    }

    [Theory]
    [InlineData("Boostrix")]
    [InlineData("Shingrix")]
    [InlineData("Afluria MDV")]
    [InlineData("FluMist (age 2-49)")]
    [InlineData("Gardasil")]
    public void NonCovidNamesPassThroughUntouched(string name)
    {
        Assert.Equal(name, VaccineDisplayName.For(name));
    }

    [Fact]
    public void NullIsSafeAndReturnsEmptyString()
    {
        Assert.Equal("", VaccineDisplayName.For(null));
    }

    [Fact]
    public void EmptyStringIsSafeAndReturnsEmptyString()
    {
        Assert.Equal("", VaccineDisplayName.For(""));
    }
}
