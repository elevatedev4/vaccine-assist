using System;
using System.Collections.Generic;
using System.IO;
using VaccineAssist.Desktop.Fax;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

public class FaxLedgerTests : IDisposable
{
    private readonly string _filePath;

    public FaxLedgerTests()
    {
        _filePath = Path.Combine(Path.GetTempPath(), "vaccine-assist-tests", Guid.NewGuid().ToString("n") + ".json");
    }

    public void Dispose()
    {
        try { File.Delete(_filePath); } catch { /* best-effort */ }
    }

    [Fact]
    public void MissingFileLoadsAsEmptyList()
    {
        var ledger = new FaxLedger(_filePath);

        Assert.Empty(ledger.Load());
    }

    [Fact]
    public void SaveThenLoadRoundTripsStatusAndFields()
    {
        var ledger = new FaxLedger(_filePath);
        var entry = new FaxLedgerEntry
        {
            PatientInitials = "TP",
            PrescriberName = "Dr. Synthetic",
            FaxNumberLast4 = "0100",
            Status = FaxLedgerStatus.InProcess,
            FaxId = "12345",
            RowFingerprints = new List<string> { "abc123" },
        };

        ledger.Save(new List<FaxLedgerEntry> { entry });
        var loaded = ledger.Load();

        Assert.Single(loaded);
        Assert.Equal("TP", loaded[0].PatientInitials);
        Assert.Equal(FaxLedgerStatus.InProcess, loaded[0].Status);
        Assert.Equal("12345", loaded[0].FaxId);
        Assert.Equal("abc123", loaded[0].RowFingerprints[0]);
    }

    [Fact]
    public void StatusTransitionsFromQueuedThroughToSentPersist()
    {
        var ledger = new FaxLedger(_filePath);
        var entry = new FaxLedgerEntry { PatientInitials = "TP", Status = FaxLedgerStatus.Queued };
        ledger.Save(new List<FaxLedgerEntry> { entry });

        var reloaded = ledger.Load();
        reloaded[0].Status = FaxLedgerStatus.InProcess;
        ledger.Save(reloaded);

        reloaded = ledger.Load();
        reloaded[0].Status = FaxLedgerStatus.Sent;
        ledger.Save(reloaded);

        var final = ledger.Load();
        Assert.Equal(FaxLedgerStatus.Sent, final[0].Status);
    }

    [Fact]
    public void CorruptFileLoadsAsEmptyListRatherThanThrowing()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_filePath)!);
        File.WriteAllText(_filePath, "not valid json {{{");

        var ledger = new FaxLedger(_filePath);

        Assert.Empty(ledger.Load());
    }
}
