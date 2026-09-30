using System;
using System.Collections.Generic;
using System.Linq;
using VaccineAssist.Desktop.Fax;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>V-T65 R6 (Will, verbatim, 2026-09-29): "I tried to upload a
/// report with the same vaccines and patient name and different dates
/// (which should be different) and it skipped it and said it was already
/// done ... we should just store the administration dates, quantity on
/// each date, and look for duplicates that way." Pure-function tests for
/// FaxDuplicateDetector — no patient data involved anywhere here, matching
/// the class's own no-patient-derived-data design.</summary>
public class FaxDuplicateDetectorTests
{
    private static ImmunizationRecord MakeRecord(string vaccine, DateOnly administeredDate, string first = "Test", string last = "Patient") => new()
    {
        PatientFirstName = first,
        PatientLastName = last,
        PatientDob = new DateOnly(1980, 1, 15),
        VaccineName = vaccine,
        AdministeredDate = administeredDate,
    };

    [Fact]
    public void SummarizeGroupsByDateAndVaccineCountingRows()
    {
        var records = new List<ImmunizationRecord>
        {
            MakeRecord("Flu", new DateOnly(2026, 9, 1)),
            MakeRecord("Flu", new DateOnly(2026, 9, 1)),
            MakeRecord("Shingrix", new DateOnly(2026, 9, 1)),
        };

        var entries = FaxDuplicateDetector.Summarize(records);

        Assert.Equal(2, entries.Count);
        var flu = entries.Single(e => e.VaccineName == "Flu");
        Assert.Equal("2026-09-01", flu.AdministeredDate);
        Assert.Equal(2, flu.Count);
        var shingrix = entries.Single(e => e.VaccineName == "Shingrix");
        Assert.Equal(1, shingrix.Count);
    }

    [Fact]
    public void SummarizeTreatsDifferentDatesAsDifferentEntriesEvenForTheSamePatientAndVaccine()
    {
        // The exact scenario from Will's report: same patient, same
        // vaccine, different administered dates — must never collapse
        // into one entry.
        var records = new List<ImmunizationRecord>
        {
            MakeRecord("Shingrix", new DateOnly(2026, 9, 12)),
            MakeRecord("Shingrix", new DateOnly(2026, 9, 29)),
        };

        var entries = FaxDuplicateDetector.Summarize(records);

        Assert.Equal(2, entries.Count);
        Assert.Contains(entries, e => e.AdministeredDate == "2026-09-12");
        Assert.Contains(entries, e => e.AdministeredDate == "2026-09-29");
    }

    [Fact]
    public void SummarizeIsCaseAndWhitespaceInsensitiveForVaccineName()
    {
        var records = new List<ImmunizationRecord>
        {
            MakeRecord("Flu", new DateOnly(2026, 9, 1)),
            MakeRecord("  flu  ", new DateOnly(2026, 9, 1)),
        };

        var entries = FaxDuplicateDetector.Summarize(records);

        Assert.Single(entries);
        Assert.Equal(2, entries[0].Count);
    }

    [Fact]
    public void FindDuplicatesMatchesAnEntryAlreadyInTheLedger()
    {
        var newEntries = new List<FaxSentDateEntry>
        {
            new() { AdministeredDate = "2026-09-12", VaccineName = "Shingrix", Count = 3 },
        };
        var ledgerRuns = new List<FaxSentRunEntry>
        {
            new()
            {
                RunAtUtc = new DateTime(2026, 9, 29, 12, 0, 0, DateTimeKind.Utc),
                Entries = new List<FaxSentDateEntry>
                {
                    new() { AdministeredDate = "2026-09-12", VaccineName = "Shingrix", Count = 3 },
                },
            },
        };

        var matches = FaxDuplicateDetector.FindDuplicates(newEntries, ledgerRuns);

        var match = Assert.Single(matches);
        Assert.Equal("2026-09-12", match.AdministeredDate);
        Assert.Equal("Shingrix", match.VaccineName);
        Assert.Equal(3, match.PreviouslySentCount);
        Assert.Equal(new DateTime(2026, 9, 29, 12, 0, 0, DateTimeKind.Utc), match.PreviouslySentRunAtUtc);
    }

    [Fact]
    public void FindDuplicatesDoesNotMatchADifferentDateForTheSameVaccine()
    {
        var newEntries = new List<FaxSentDateEntry>
        {
            new() { AdministeredDate = "2026-09-29", VaccineName = "Shingrix", Count = 1 },
        };
        var ledgerRuns = new List<FaxSentRunEntry>
        {
            new()
            {
                RunAtUtc = DateTime.UtcNow,
                Entries = new List<FaxSentDateEntry>
                {
                    new() { AdministeredDate = "2026-09-12", VaccineName = "Shingrix", Count = 3 },
                },
            },
        };

        var matches = FaxDuplicateDetector.FindDuplicates(newEntries, ledgerRuns);

        Assert.Empty(matches);
    }

    [Fact]
    public void FindDuplicatesPicksTheMostRecentRunWhenAPairWasSentMoreThanOnce()
    {
        var newEntries = new List<FaxSentDateEntry>
        {
            new() { AdministeredDate = "2026-09-12", VaccineName = "Flu", Count = 1 },
        };
        var olderRun = new FaxSentRunEntry
        {
            RunAtUtc = new DateTime(2026, 9, 20, 0, 0, 0, DateTimeKind.Utc),
            Entries = new List<FaxSentDateEntry> { new() { AdministeredDate = "2026-09-12", VaccineName = "Flu", Count = 5 } },
        };
        var newerRun = new FaxSentRunEntry
        {
            RunAtUtc = new DateTime(2026, 9, 29, 0, 0, 0, DateTimeKind.Utc),
            Entries = new List<FaxSentDateEntry> { new() { AdministeredDate = "2026-09-12", VaccineName = "Flu", Count = 2 } },
        };

        var matches = FaxDuplicateDetector.FindDuplicates(newEntries, new List<FaxSentRunEntry> { olderRun, newerRun });

        var match = Assert.Single(matches);
        Assert.Equal(newerRun.RunAtUtc, match.PreviouslySentRunAtUtc);
        Assert.Equal(2, match.PreviouslySentCount);
    }

    [Fact]
    public void FilterOutDuplicatesKeepsOnlyRowsNotMatchingAnyDuplicate()
    {
        var keep = MakeRecord("Flu", new DateOnly(2026, 9, 29));
        var drop = MakeRecord("Shingrix", new DateOnly(2026, 9, 12));
        var duplicates = new List<FaxDuplicateMatch>
        {
            new("2026-09-12", "Shingrix", 1, 3, DateTime.UtcNow),
        };

        var filtered = FaxDuplicateDetector.FilterOutDuplicates(new[] { keep, drop }, duplicates);

        Assert.Single(filtered);
        Assert.Same(keep, filtered[0]);
    }

    [Fact]
    public void FilterOutDuplicatesReturnsEverythingWhenThereAreNoDuplicates()
    {
        var records = new List<ImmunizationRecord>
        {
            MakeRecord("Flu", new DateOnly(2026, 9, 29)),
            MakeRecord("Shingrix", new DateOnly(2026, 9, 12)),
        };

        var filtered = FaxDuplicateDetector.FilterOutDuplicates(records, Array.Empty<FaxDuplicateMatch>());

        Assert.Equal(2, filtered.Count);
    }
}
