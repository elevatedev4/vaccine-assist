using System;
using System.IO;
using VaccineAssist.Desktop.Fax;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

public class ImportLedgerTests : IDisposable
{
    private readonly string _filePath;

    public ImportLedgerTests()
    {
        _filePath = Path.Combine(Path.GetTempPath(), "vaccine-assist-tests", Guid.NewGuid().ToString("n") + ".json");
    }

    public void Dispose()
    {
        try { File.Delete(_filePath); } catch { /* best-effort */ }
    }

    [Fact]
    public void MissingFileHasNoFingerprints()
    {
        var ledger = new ImportLedger(_filePath);

        Assert.Empty(ledger.LoadFingerprints());
    }

    [Fact]
    public void AddedFingerprintsPersistAcrossInstances()
    {
        var first = new ImportLedger(_filePath);
        first.AddFingerprints(new[] { "fp1", "fp2" });

        var second = new ImportLedger(_filePath);
        var loaded = second.LoadFingerprints();

        Assert.Contains("fp1", loaded);
        Assert.Contains("fp2", loaded);
    }

    [Fact]
    public void AddingTheSameFingerprintTwiceDoesNotDuplicateIt()
    {
        var ledger = new ImportLedger(_filePath);
        ledger.AddFingerprints(new[] { "fp1" });
        ledger.AddFingerprints(new[] { "fp1" });

        Assert.Single(ledger.LoadFingerprints());
    }
}
