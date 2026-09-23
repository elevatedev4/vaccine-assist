using System;
using System.Collections.Generic;
using VaccineAssist.Desktop.Fax;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

public class FaxGroupingTests
{
    private static ImmunizationRecord MakeRecord(
        string first, string last, string vaccine, DateOnly date,
        string? prescriberName = "Dr. Synthetic", string? prescriberNpi = null) => new()
    {
        PatientFirstName = first,
        PatientLastName = last,
        VaccineName = vaccine,
        AdministeredDate = date,
        PrescriberName = prescriberName,
        PrescriberNpi = prescriberNpi,
    };

    [Fact]
    public void SamePatientAndPrescriberGroupIntoOnePdf()
    {
        var records = new List<ImmunizationRecord>
        {
            MakeRecord("Test", "Patient", "Flu", new DateOnly(2026, 9, 1)),
            MakeRecord("Test", "Patient", "Tdap", new DateOnly(2026, 9, 1)),
        };

        var groups = FaxGrouping.GroupByPatientAndPrescriber(records);

        Assert.Single(groups);
        Assert.Equal(2, groups[0].Records.Count);
    }

    [Fact]
    public void SamePatientDifferentPrescriberSplitsIntoTwoGroups()
    {
        var records = new List<ImmunizationRecord>
        {
            MakeRecord("Test", "Patient", "Flu", new DateOnly(2026, 9, 1), prescriberName: "Dr. One"),
            MakeRecord("Test", "Patient", "Tdap", new DateOnly(2026, 9, 1), prescriberName: "Dr. Two"),
        };

        var groups = FaxGrouping.GroupByPatientAndPrescriber(records);

        Assert.Equal(2, groups.Count);
    }

    [Fact]
    public void DifferentPatientsSamePrescriberSplitIntoTwoGroups()
    {
        var records = new List<ImmunizationRecord>
        {
            MakeRecord("Test", "PatientOne", "Flu", new DateOnly(2026, 9, 1)),
            MakeRecord("Test", "PatientTwo", "Flu", new DateOnly(2026, 9, 1)),
        };

        var groups = FaxGrouping.GroupByPatientAndPrescriber(records);

        Assert.Equal(2, groups.Count);
    }

    [Fact]
    public void RecordsWithinAGroupAreOrderedByAdministeredDate()
    {
        var records = new List<ImmunizationRecord>
        {
            MakeRecord("Test", "Patient", "Tdap", new DateOnly(2026, 9, 5)),
            MakeRecord("Test", "Patient", "Flu", new DateOnly(2026, 9, 1)),
        };

        var groups = FaxGrouping.GroupByPatientAndPrescriber(records);

        Assert.Equal("Flu", groups[0].Records[0].VaccineName);
        Assert.Equal("Tdap", groups[0].Records[1].VaccineName);
    }

    [Fact]
    public void NpiTakesPriorityOverNameForPrescriberGrouping()
    {
        var records = new List<ImmunizationRecord>
        {
            MakeRecord("Test", "Patient", "Flu", new DateOnly(2026, 9, 1), prescriberName: "Dr. Alpha", prescriberNpi: "1234567890"),
            MakeRecord("Test", "Patient", "Tdap", new DateOnly(2026, 9, 1), prescriberName: "Dr. Beta Typo", prescriberNpi: "1234567890"),
        };

        var groups = FaxGrouping.GroupByPatientAndPrescriber(records);

        // Same NPI -> same group even though the report's free-text name
        // column differs (a re-export/typo shouldn't split one prescriber
        // into two PDFs).
        Assert.Single(groups);
    }
}
