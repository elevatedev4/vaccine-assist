using System;
using System.IO;
using System.Linq;
using System.Text;
using VaccineAssist.Desktop.Fax;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>V-T65 R5 (Will, verbatim, 2026-09-29): "make sure that things
/// don't get re-sent if somebody reuploads the same file" — file-hash
/// stability (FaxFileHasher) and the ledger's upsert/merge behavior
/// (FaxFileLedger).</summary>
public class FaxFileHasherTests
{
    [Fact]
    public void SameBytesProduceTheSameHash()
    {
        var bytes = Encoding.UTF8.GetBytes("same content");

        Assert.Equal(FaxFileHasher.ComputeHex(bytes), FaxFileHasher.ComputeHex(bytes));
    }

    [Fact]
    public void DifferentBytesProduceDifferentHashes()
    {
        var a = FaxFileHasher.ComputeHex(Encoding.UTF8.GetBytes("content A"));
        var b = FaxFileHasher.ComputeHex(Encoding.UTF8.GetBytes("content B"));

        Assert.NotEqual(a, b);
    }

    [Fact]
    public void HashIsLowercaseHex()
    {
        var hash = FaxFileHasher.ComputeHex(Encoding.UTF8.GetBytes("x"));

        Assert.Equal(64, hash.Length); // SHA-256 -> 32 bytes -> 64 hex chars
        Assert.Equal(hash, hash.ToLowerInvariant());
    }
}

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
    public void MissingFileHasNoEntries()
    {
        var ledger = new FaxFileLedger(_filePath);

        Assert.Empty(ledger.Load());
    }

    [Fact]
    public void RecordPersistsAcrossInstances()
    {
        var first = new FaxFileLedger(_filePath);
        first.Record("hash1", "report.csv", new[] { "fp1", "fp2" });

        var second = new FaxFileLedger(_filePath);
        var entry = Assert.Single(second.Load());

        Assert.Equal("hash1", entry.FileHash);
        Assert.Equal("report.csv", entry.FileName);
        Assert.Equal(new[] { "fp1", "fp2" }, entry.RowFingerprints.OrderBy(f => f));
    }

    [Fact]
    public void RecordingTheSameHashTwiceMergesFingerprintsInsteadOfDuplicatingTheEntry()
    {
        var ledger = new FaxFileLedger(_filePath);
        ledger.Record("hash1", "report.csv", new[] { "fp1" });
        ledger.Record("hash1", "report.csv", new[] { "fp1", "fp2" });

        var entry = Assert.Single(ledger.Load());
        Assert.Equal(new[] { "fp1", "fp2" }, entry.RowFingerprints.OrderBy(f => f));
    }

    [Fact]
    public void DifferentHashesAreSeparateEntries()
    {
        var ledger = new FaxFileLedger(_filePath);
        ledger.Record("hash1", "report1.csv", new[] { "fp1" });
        ledger.Record("hash2", "report2.csv", new[] { "fp2" });

        Assert.Equal(2, ledger.Load().Count);
    }
}
