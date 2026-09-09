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

    // V-T21 item 7 (Will, 2026-09-08): the Physicians-tab-only 3-bucket
    // grouping, additive on top of GetGroup/DisplayOrder above (both still
    // covered, unmodified, by the tests above).

    [Theory]
    [InlineData("Afluria MDV", VaccineGroupCatalog.PhysiciansFluGroup)]
    [InlineData("FluMist (age 2-49)", VaccineGroupCatalog.PhysiciansFluGroup)]
    [InlineData("Comirnaty 2025-26 12+", VaccineGroupCatalog.PhysiciansCovidGroup)]
    [InlineData("mNEXSPIKE", VaccineGroupCatalog.PhysiciansCovidGroup)]
    [InlineData("Boostrix", VaccineGroupCatalog.PhysiciansOtherGroup)] // fine-grained Tetanus/whooping cough
    [InlineData("Shingrix", VaccineGroupCatalog.PhysiciansOtherGroup)] // fine-grained Shingles
    [InlineData("Gardasil", VaccineGroupCatalog.PhysiciansOtherGroup)] // fine-grained HPV
    [InlineData("Some Future Vaccine", VaccineGroupCatalog.PhysiciansOtherGroup)] // fine-grained Other
    public void GetPhysiciansGroupBucketsIntoExactlyThreeGroups(string name, string expectedGroup)
    {
        Assert.Equal(expectedGroup, VaccineGroupCatalog.GetPhysiciansGroup(Named(name)));
    }

    [Fact]
    public void PhysiciansDisplayOrderIsExactlyFluCovidOther()
    {
        Assert.Equal(
            new[] { VaccineGroupCatalog.PhysiciansFluGroup, VaccineGroupCatalog.PhysiciansCovidGroup, VaccineGroupCatalog.PhysiciansOtherGroup },
            VaccineGroupCatalog.PhysiciansDisplayOrder);
    }

    [Fact]
    public void PersistedGroupForPhysiciansGroupMapsFluAndCovidBackToTheFineGrainedValue()
    {
        Assert.Equal("Flu", VaccineGroupCatalog.PersistedGroupForPhysiciansGroup(VaccineGroupCatalog.PhysiciansFluGroup));
        Assert.Equal("COVID", VaccineGroupCatalog.PersistedGroupForPhysiciansGroup(VaccineGroupCatalog.PhysiciansCovidGroup));
    }

    [Fact]
    public void PersistedGroupForPhysiciansGroupReturnsNullForOtherVaccines()
    {
        Assert.Null(VaccineGroupCatalog.PersistedGroupForPhysiciansGroup(VaccineGroupCatalog.PhysiciansOtherGroup));
    }
}
