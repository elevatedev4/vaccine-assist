using System.Collections.Generic;
using VaccineAssist.Desktop.Models;
using VaccineAssist.Desktop.PioneerEntryAutomation;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

public class MacroCodeVaccineResolverTests
{
    [Fact]
    public void FindsAnExactCaseInsensitiveShortCodeMatch()
    {
        var vaccines = new List<Vaccine>
        {
            new() { ShortCode = "mmr1", Name = "MMR dose 1" },
            new() { ShortCode = "Shingrix1", Name = "Shingrix dose 1" },
        };

        var found = MacroCodeVaccineResolver.FindByShortCode(vaccines, "shingrix1");

        Assert.NotNull(found);
        Assert.Equal("Shingrix dose 1", found!.Name);
    }

    [Fact]
    public void TrimsWhitespaceOnBothSides()
    {
        var vaccines = new List<Vaccine> { new() { ShortCode = " mmr1 ", Name = "MMR dose 1" } };

        var found = MacroCodeVaccineResolver.FindByShortCode(vaccines, "mmr1");

        Assert.NotNull(found);
    }

    [Fact]
    public void ReturnsNullWhenNoVaccineHasThatShortCode()
    {
        var vaccines = new List<Vaccine> { new() { ShortCode = "mmr1", Name = "MMR dose 1" } };

        var found = MacroCodeVaccineResolver.FindByShortCode(vaccines, "flucelvaxmdv");

        Assert.Null(found);
    }

    [Fact]
    public void ReturnsNullForABlankShortCode()
    {
        var vaccines = new List<Vaccine> { new() { ShortCode = "mmr1", Name = "MMR dose 1" } };

        Assert.Null(MacroCodeVaccineResolver.FindByShortCode(vaccines, ""));
    }
}
