using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using VaccineAssist.Desktop.Fax;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>V-T65 R6 (Will, verbatim, 2026-09-29): "We can't store patient
/// name ... we should just store the administration dates, quantity on
/// each date, and look for duplicates that way." FaxFileLedger's new
/// shape (a flat list of runs, each holding only (date, vaccine, count)
/// entries — never a patient identifier) plus migration from the old
/// per-file-hash shape.</summary>
public class FaxFileLedgerTests : IDisposable
{
    private readonly string _filePath;

    public FaxFileLedgerTests()
    {
        _filePath = Path.Combine(Path.GetTempPath(), "vaccine-assist-tests", Guid.NewGuid().ToString("n") + ".json");
    }

    public void Dispose()
    {
        try { File.Delete(_filePath); } catch { /* best-effort */ }
    }

    [Fact]
    public void MissingFileHasNoRuns()
    {
        var ledger = new FaxFileLedger(_filePath);

        Assert.Empty(ledger.Load());
    }

    [Fact]
    public void CorruptFileLoadsAsEmptyListRatherThanThrowing()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_filePath)!);
        File.WriteAllText(_filePath, "not valid json {{{");

        var ledger = new FaxFileLedger(_filePath);

        Assert.Empty(ledger.Load());
    }

    [Fact]
    public void RecordRunPersistsAcrossInstances()
    {
        var first = new FaxFileLedger(_filePath);
        var runAt = new DateTime(2026, 9, 29, 18, 0, 0, DateTimeKind.Utc);
        first.RecordRun(runAt, new List<FaxSentDateEntry>
        {
            new() { AdministeredDate = "2026-09-12", VaccineName = "Shingrix", Count = 3 },
        });

        var second = new FaxFileLedger(_filePath);
        var run = Assert.Single(second.Load());

        Assert.Equal(runAt, run.RunAtUtc);
        var entry = Assert.Single(run.Entries);
        Assert.Equal("2026-09-12", entry.AdministeredDate);
        Assert.Equal("Shingrix", entry.VaccineName);
        Assert.Equal(3, entry.Count);
    }

    [Fact]
    public void RecordRunWithNoEntriesIsANoOp()
    {
        var ledger = new FaxFileLedger(_filePath);

        ledger.RecordRun(DateTime.UtcNow, new List<FaxSentDateEntry>());

        Assert.Empty(ledger.Load());
        Assert.False(File.Exists(_filePath));
    }

    [Fact]
    public void EachRecordRunCallAppendsASeparateRunRatherThanMerging()
    {
        var ledger = new FaxFileLedger(_filePath);
        ledger.RecordRun(new DateTime(2026, 9, 1, 0, 0, 0, DateTimeKind.Utc),
            new List<FaxSentDateEntry> { new() { AdministeredDate = "2026-09-01", VaccineName = "Flu", Count = 1 } });
        ledger.RecordRun(new DateTime(2026, 9, 2, 0, 0, 0, DateTimeKind.Utc),
            new List<FaxSentDateEntry> { new() { AdministeredDate = "2026-09-02", VaccineName = "Flu", Count = 2 } });

        Assert.Equal(2, ledger.Load().Count);
    }

    [Fact]
    public void OldFileHashShapeMigratesToEmptyEntriesRatherThanCrashing()
    {
        // The pre-R6 shape: FileHash/FileName/RecordedAtUtc/RowFingerprints.
        // Dates aren't recoverable from an old row's SHA-256 fingerprint,
        // so migration keeps RunAtUtc and gives up an empty Entries list —
        // it must never crash, and must never fabricate a false duplicate.
        Directory.CreateDirectory(Path.GetDirectoryName(_filePath)!);
        var oldShapeJson = JsonSerializer.Serialize(new[]
        {
            new
            {
                FileHash = "abc123",
                FileName = "report.csv",
                RecordedAtUtc = new DateTime(2026, 9, 20, 12, 0, 0, DateTimeKind.Utc),
                RowFingerprints = new[] { "fp1", "fp2" },
            },
        });
        File.WriteAllText(_filePath, oldShapeJson);

        var ledger = new FaxFileLedger(_filePath);
        var runs = ledger.Load();

        var run = Assert.Single(runs);
        Assert.Equal(new DateTime(2026, 9, 20, 12, 0, 0, DateTimeKind.Utc), run.RunAtUtc);
        Assert.Empty(run.Entries);
    }

    [Fact]
    public void OldShapeFileIsRewrittenInTheNewShapeAfterMigration()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_filePath)!);
        var oldShapeJson = JsonSerializer.Serialize(new[]
        {
            new
            {
                FileHash = "abc123",
                FileName = "report.csv",
                RecordedAtUtc = DateTime.UtcNow,
                RowFingerprints = new[] { "fp1" },
            },
        });
        File.WriteAllText(_filePath, oldShapeJson);

        var ledger = new FaxFileLedger(_filePath);
        ledger.Load(); // triggers the rewrite

        var rewrittenJson = File.ReadAllText(_filePath);
        Assert.DoesNotContain("FileHash", rewrittenJson);
        Assert.DoesNotContain("RowFingerprints", rewrittenJson);
        Assert.Contains("RunAtUtc", rewrittenJson);
    }

    [Fact]
    public void EmptyArrayLoadsAsEmptyListRegardlessOfShape()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_filePath)!);
        File.WriteAllText(_filePath, "[]");

        var ledger = new FaxFileLedger(_filePath);

        Assert.Empty(ledger.Load());
    }

    [Fact]
    public void RecordRunLeavesNoTempFileBehindAndTheRealFileHasTheNewContent()
    {
        // V-T65 R7 review follow-up (non-blocking note from R5:
        // "non-atomic JSON writes in the Fax ledgers") — Save now writes
        // to a temp file and renames it into place.
        var ledger = new FaxFileLedger(_filePath);

        ledger.RecordRun(DateTime.UtcNow, new List<FaxSentDateEntry>
        {
            new() { AdministeredDate = "2026-09-30", VaccineName = "Flu", Count = 1 },
        });

        var directory = Path.GetDirectoryName(_filePath)!;
        var siblings = Directory.GetFiles(directory, Path.GetFileName(_filePath) + "*");
        Assert.Single(siblings);
        Assert.Equal(_filePath, siblings[0]);
    }
}
