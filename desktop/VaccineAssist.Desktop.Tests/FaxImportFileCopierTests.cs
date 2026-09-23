using System;
using System.IO;
using VaccineAssist.Desktop.Fax;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// Unit tests for FaxImportFileCopier — the pure, testable half of the
/// tray menu's "Vaccine faxes → Import report file…" row (Will,
/// 2026-09-22: manual import, no SFTP/cloud). Uses real temp directories,
/// same pattern as SessionStoreTests/FaxCredentialStoreTests.
/// </summary>
public class FaxImportFileCopierTests
{
    [Fact]
    public void CopiesTheSourceFileIntoTheInputFolderUnderItsOwnName()
    {
        var sourceDir = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString());
        var inputFolder = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString());
        Directory.CreateDirectory(sourceDir);
        var sourcePath = Path.Combine(sourceDir, "report.csv");
        File.WriteAllText(sourcePath, "a,b,c\n1,2,3\n");

        try
        {
            var destPath = FaxImportFileCopier.CopyIntoInputFolder(sourcePath, inputFolder);

            Assert.Equal(Path.Combine(inputFolder, "report.csv"), destPath);
            Assert.True(File.Exists(destPath));
            Assert.Equal("a,b,c\n1,2,3\n", File.ReadAllText(destPath));
        }
        finally
        {
            Directory.Delete(sourceDir, recursive: true);
            if (Directory.Exists(inputFolder)) Directory.Delete(inputFolder, recursive: true);
        }
    }

    [Fact]
    public void CreatesTheInputFolderWhenItDoesNotYetExist()
    {
        var sourceDir = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString());
        var inputFolder = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString());
        Directory.CreateDirectory(sourceDir);
        var sourcePath = Path.Combine(sourceDir, "report.xlsx");
        File.WriteAllText(sourcePath, "fixture");

        try
        {
            Assert.False(Directory.Exists(inputFolder));

            FaxImportFileCopier.CopyIntoInputFolder(sourcePath, inputFolder);

            Assert.True(Directory.Exists(inputFolder));
        }
        finally
        {
            Directory.Delete(sourceDir, recursive: true);
            if (Directory.Exists(inputFolder)) Directory.Delete(inputFolder, recursive: true);
        }
    }

    [Fact]
    public void OverwritesAnExistingSameNamedFile()
    {
        var sourceDir = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString());
        var inputFolder = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString());
        Directory.CreateDirectory(sourceDir);
        Directory.CreateDirectory(inputFolder);
        var sourcePath = Path.Combine(sourceDir, "report.csv");
        File.WriteAllText(sourcePath, "new-contents");
        File.WriteAllText(Path.Combine(inputFolder, "report.csv"), "stale-contents");

        try
        {
            var destPath = FaxImportFileCopier.CopyIntoInputFolder(sourcePath, inputFolder);

            Assert.Equal("new-contents", File.ReadAllText(destPath));
        }
        finally
        {
            Directory.Delete(sourceDir, recursive: true);
            Directory.Delete(inputFolder, recursive: true);
        }
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void ThrowsAUserFacingMessageWhenTheInputFolderIsNotConfigured(string? inputFolder)
    {
        var sourceDir = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString());
        Directory.CreateDirectory(sourceDir);
        var sourcePath = Path.Combine(sourceDir, "report.csv");
        File.WriteAllText(sourcePath, "fixture");

        try
        {
            var ex = Assert.Throws<InvalidOperationException>(() => FaxImportFileCopier.CopyIntoInputFolder(sourcePath, inputFolder));
            Assert.Contains("Fax settings", ex.Message);
        }
        finally
        {
            Directory.Delete(sourceDir, recursive: true);
        }
    }
}
