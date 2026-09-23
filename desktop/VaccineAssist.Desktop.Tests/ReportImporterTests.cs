using System;
using System.IO;
using System.Linq;
using ClosedXML.Excel;
using VaccineAssist.Desktop.Fax;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// Exercises ReportImporter against REAL temp-directory files (CsvHelper/
/// ClosedXML round-trip on disk is cheap and more representative than
/// faking the file system for this one class) — synthetic data only,
/// matching the brief's PHI rule.
/// </summary>
public class ReportImporterTests : IDisposable
{
    private readonly string _tempDir;
    private readonly FaxColumnMap _map = new();

    public ReportImporterTests()
    {
        _tempDir = Path.Combine(Path.GetTempPath(), "vaccine-assist-tests", Guid.NewGuid().ToString("n"));
        Directory.CreateDirectory(_tempDir);
    }

    public void Dispose()
    {
        try { Directory.Delete(_tempDir, recursive: true); } catch { /* best-effort cleanup */ }
    }

    private static ImportLedger NewLedger(string dir) => new(Path.Combine(dir, "imported.json"));

    private void WriteCsv(string fileName, string contents) =>
        File.WriteAllText(Path.Combine(_tempDir, fileName), contents);

    [Fact]
    public void ValidCsvIsImported()
    {
        WriteCsv("report.csv",
            "Patient First Name,Patient Last Name,Vaccine,Date Administered,Lot Number\n" +
            "Test,Patient,Flu,2026-09-01,LOT1\n");

        var importer = new ReportImporter(NewLedger(_tempDir));
        var outcome = importer.Import(_tempDir, _map);

        Assert.Single(outcome.NewRecords);
        Assert.Equal("Test", outcome.NewRecords[0].PatientFirstName);
        Assert.Empty(outcome.RejectedFiles);
        Assert.Equal(new[] { Path.Combine(_tempDir, "report.csv") }, outcome.AcceptedFilePaths);
    }

    [Fact]
    public void MissingRequiredColumnRejectsTheWholeFileWithAClearMessage()
    {
        // No "Vaccine" column at all.
        WriteCsv("report.csv",
            "Patient First Name,Patient Last Name,Date Administered\n" +
            "Test,Patient,2026-09-01\n");

        var importer = new ReportImporter(NewLedger(_tempDir));
        var outcome = importer.Import(_tempDir, _map);

        Assert.Empty(outcome.NewRecords);
        Assert.Single(outcome.RejectedFiles);
        Assert.Contains("vaccine name", outcome.RejectedFiles[0].Reason);
        Assert.Empty(outcome.AcceptedFilePaths);
    }

    [Fact]
    public void OneBadRowIsSkippedWithoutRejectingTheWholeFile()
    {
        WriteCsv("report.csv",
            "Patient First Name,Patient Last Name,Vaccine,Date Administered\n" +
            "Test,Patient,Flu,2026-09-01\n" +
            ",MissingFirstName,Flu,2026-09-01\n");

        var importer = new ReportImporter(NewLedger(_tempDir));
        var outcome = importer.Import(_tempDir, _map);

        Assert.Single(outcome.NewRecords);
        Assert.Equal(1, outcome.SkippedRowCount);
        Assert.Empty(outcome.RejectedFiles);
    }

    [Fact]
    public void DuplicateFingerprintWithinOneRunIsCountedOnceNotFaxedTwice()
    {
        WriteCsv("report.csv",
            "Patient First Name,Patient Last Name,Vaccine,Date Administered,Lot Number\n" +
            "Test,Patient,Flu,2026-09-01,LOT1\n" +
            "Test,Patient,Flu,2026-09-01,LOT1\n");

        var importer = new ReportImporter(NewLedger(_tempDir));
        var outcome = importer.Import(_tempDir, _map);

        Assert.Single(outcome.NewRecords);
        Assert.Equal(1, outcome.DuplicateRowCount);
    }

    [Fact]
    public void RowAlreadyInTheImportLedgerIsDedupedAcrossRuns()
    {
        WriteCsv("report.csv",
            "Patient First Name,Patient Last Name,Vaccine,Date Administered,Lot Number\n" +
            "Test,Patient,Flu,2026-09-01,LOT1\n");

        var ledger = NewLedger(_tempDir);
        var importer = new ReportImporter(ledger);

        var firstRun = importer.Import(_tempDir, _map);
        Assert.Single(firstRun.NewRecords);
        // Import() itself never writes to the ledger (see its own doc
        // comment) — the orchestrator does, after a row is actually
        // resolved/queued. Simulate that here.
        ledger.AddFingerprints(firstRun.NewRecords.Select(r => r.Fingerprint));

        var secondRun = importer.Import(_tempDir, _map);

        Assert.Empty(secondRun.NewRecords);
        Assert.Equal(1, secondRun.DuplicateRowCount);
    }

    [Fact]
    public void ValidXlsxIsImported()
    {
        using (var workbook = new XLWorkbook())
        {
            var sheet = workbook.Worksheets.Add("Report");
            sheet.Cell(1, 1).Value = "Patient First Name";
            sheet.Cell(1, 2).Value = "Patient Last Name";
            sheet.Cell(1, 3).Value = "Vaccine";
            sheet.Cell(1, 4).Value = "Date Administered";
            sheet.Cell(2, 1).Value = "Test";
            sheet.Cell(2, 2).Value = "Patient";
            sheet.Cell(2, 3).Value = "Flu";
            sheet.Cell(2, 4).Value = "2026-09-01";
            workbook.SaveAs(Path.Combine(_tempDir, "report.xlsx"));
        }

        var importer = new ReportImporter(NewLedger(_tempDir));
        var outcome = importer.Import(_tempDir, _map);

        Assert.Single(outcome.NewRecords);
        Assert.Equal("Test", outcome.NewRecords[0].PatientFirstName);
    }

    [Fact]
    public void MoveAcceptedFilesMovesToProcessedDateFolder()
    {
        WriteCsv("report.csv",
            "Patient First Name,Patient Last Name,Vaccine,Date Administered\n" +
            "Test,Patient,Flu,2026-09-01\n");

        var importer = new ReportImporter(NewLedger(_tempDir));
        var outcome = importer.Import(_tempDir, _map);

        importer.MoveAcceptedFiles(outcome.AcceptedFilePaths, _tempDir, new DateOnly(2026, 9, 22));

        var expectedPath = Path.Combine(_tempDir, "processed", "2026-09-22", "report.csv");
        Assert.True(File.Exists(expectedPath));
        Assert.False(File.Exists(Path.Combine(_tempDir, "report.csv")));
    }
}
