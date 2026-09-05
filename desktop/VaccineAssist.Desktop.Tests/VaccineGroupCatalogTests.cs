using VaccineAssist.Desktop.Models;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// V-... Part B: name -> common-group mapping the guided flow's group step
/// uses (see VaccineGroupCatalog's own doc comment for why this is a
/// static lookup rather than a schema column). Spot-checks a handful of
/// the real current formulary's names (supabase/seed/vaccines.sql,
/// 2026-09-04) plus the Contains-not-exact-match and unmapped-name
/// fallback behavior.
/// </summary>
public class VaccineGroupCatalogTests
{
    private static Vaccine Named(string name) => new() { Name = name, ShortCode = "x", Active = true };

    [Theory]
    [InlineData("Comirnaty 2025-26 12+", "COVID")]
    [InlineData("mNEXSPIKE", "COVID")]
    [InlineData("Afluria MDV", "Flu")]
    [InlineData("FluMist (age 2-49)", "Flu")]
    [InlineData("Prevnar 20", "Pneumonia")]
    [InlineData("Capvaxive", "Pneumonia")]
    [InlineData("Boostrix", "Tetanus/whooping cough")]
    [InlineData("Shingrix", "Shingles")]
    [InlineData("Abrysvo", "RSV")]
    [InlineData("Arexvy", "RSV")]
    [InlineData("Gardasil", "HPV")]
    [InlineData("Vaqta adult", "Hep A")]
    [InlineData("Engerix 20 (age 20+)", "Hep B")]
    [InlineData("MMR-II", "MMR")]
    [InlineData("Priorix", "MMR")]
    [InlineData("Menveo", "Meningitis")]
    [InlineData("Typhim Vi", "Typhoid")]
    public void MapsKnownFormularyNamesToTheExpectedGroup(string name, string expectedGroup)
    {
        Assert.Equal(expectedGroup, VaccineGroupCatalog.GetGroup(Named(name)));
    }

    [Fact]
    public void UnmappedNameFallsBackToOther()
    {
        Assert.Equal(VaccineGroupCatalog.OtherGroup, VaccineGroupCatalog.GetGroup(Named("Some Future Vaccine")));
    }

    [Fact]
    public void DisplayOrderListsEveryKnownGroupWithOtherLast()
    {
        Assert.Equal(VaccineGroupCatalog.OtherGroup, VaccineGroupCatalog.DisplayOrder[^1]);
        Assert.Contains("COVID", VaccineGroupCatalog.DisplayOrder);
        Assert.Contains("HPV", VaccineGroupCatalog.DisplayOrder);
    }
}
