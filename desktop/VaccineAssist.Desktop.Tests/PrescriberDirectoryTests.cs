using System;
using System.Collections.Generic;
using System.IO;
using VaccineAssist.Desktop.Fax;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

public class PrescriberDirectoryTests : IDisposable
{
    private readonly string _filePath;

    public PrescriberDirectoryTests()
    {
        _filePath = Path.Combine(Path.GetTempPath(), "vaccine-assist-tests", Guid.NewGuid().ToString("n") + ".json");
    }

    public void Dispose()
    {
        try { File.Delete(_filePath); } catch { /* best-effort */ }
    }

    [Fact]
    public void MissingFileReturnsEmptyListAndNoMatch()
    {
        var directory = new PrescriberDirectory(_filePath);

        Assert.Empty(directory.Load());
        Assert.Null(directory.TryGetFaxNumber("Dr. Nobody", null));
    }

    [Fact]
    public void SaveThenLoadRoundTrips()
    {
        var directory = new PrescriberDirectory(_filePath);
        directory.Save(new List<PrescriberDirectoryEntry>
        {
            new() { Name = "Dr. Synthetic", Npi = "1234567890", FaxNumber = "5555550100" },
        });

        var loaded = directory.Load();

        Assert.Single(loaded);
        Assert.Equal("5555550100", loaded[0].FaxNumber);
    }

    [Fact]
    public void LookupByNpiFindsTheFaxNumber()
    {
        var directory = new PrescriberDirectory(_filePath);
        directory.Save(new List<PrescriberDirectoryEntry>
        {
            new() { Name = "Dr. Synthetic", Npi = "1234567890", FaxNumber = "5555550100" },
        });

        var result = directory.TryGetFaxNumber("Some Other Spelling", "123-456-7890");

        Assert.Equal("5555550100", result);
    }

    [Fact]
    public void LookupFallsBackToNormalizedNameWhenNoNpiMatch()
    {
        var directory = new PrescriberDirectory(_filePath);
        directory.Save(new List<PrescriberDirectoryEntry>
        {
            new() { Name = "Dr. Synthetic", Npi = null, FaxNumber = "5555550100" },
        });

        var result = directory.TryGetFaxNumber("  dr. synthetic  ", null);

        Assert.Equal("5555550100", result);
    }

    [Fact]
    public void EntryWithBlankFaxNumberIsNotReturnedAsAMatch()
    {
        var directory = new PrescriberDirectory(_filePath);
        directory.Save(new List<PrescriberDirectoryEntry>
        {
            new() { Name = "Dr. Synthetic", Npi = "1234567890", FaxNumber = "" },
        });

        Assert.Null(directory.TryGetFaxNumber("Dr. Synthetic", "1234567890"));
    }
}
