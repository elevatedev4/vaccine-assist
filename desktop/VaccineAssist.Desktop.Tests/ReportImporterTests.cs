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
/// matching the brief's PHI rule. V-T65 (2026-09-29): ImportFile reads
/// ONE user-picked file — no folder scan, no move-to-processed.
/// </summary>
public class ReportImporterTests : IDisposable
{
    private readonly string _tempDir;

    // Separate first/last-name columns — decoupled from FaxColumnMap's own
    // default (Pioneer's combined "Last, First" column, see
    // PioneerColumnMapTests) so these generic importer-mechanics tests
    // (dedupe/rejection) keep working regardless of what the default
    // column map looks like.
    private readonly FaxColumnMap _map = new()
    {
        PatientFullNameHeader = null,
        PatientFirstNameHeader = "Patient First Name",
        PatientLastNameHeader = "Patient Last Name",
        VaccineNameHeader = "Vaccine",
        AdministeredDateHeader = "Date Administered",
        DobHeader = "DOB",
        LotHeader = "Lot Number",
    };

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

    private string WriteCsv(string fileName, string contents)
    {
        var path = Path.Combine(_tempDir, fileName);
        File.WriteAllText(path, contents);
        return path;
    }

    [Fact]
    public void ValidCsvIsImported()
    {
        var path = WriteCsv("report.csv",
            "Patient First Name,Patient Last Name,Vaccine,Date Administered,DOB,Lot Number\n" +
            "Test,Patient,Flu,2026-09-01,1980-01-15,LOT1\n");

        var importer = new ReportImporter(NewLedger(_tempDir));
        var outcome = importer.ImportFile(path, _map);

        Assert.Single(outcome.NewRecords);
        Assert.Equal("Test", outcome.NewRecords[0].PatientFirstName);
        Assert.Empty(outcome.RejectedFiles);
    }

    [Fact]
    public void MissingRequiredColumnRejectsTheWholeFileWithAClearMessage()
    {
        // No "Vaccine" column at all (DOB present, so this isolates the
        // ONE missing header the test is about).
        var path = WriteCsv("report.csv",
            "Patient First Name,Patient Last Name,Date Administered,DOB\n" +
            "Test,Patient,2026-09-01,1980-01-15\n");

        var importer = new ReportImporter(NewLedger(_tempDir));
        var outcome = importer.ImportFile(path, _map);

        Assert.Empty(outcome.NewRecords);
        Assert.Single(outcome.RejectedFiles);
        Assert.Contains("vaccine name", outcome.RejectedFiles[0].Reason);
    }

    [Fact]
    public void OneBadRowIsSkippedWithoutRejectingTheWholeFile()
    {
        var path = WriteCsv("report.csv",
            "Patient First Name,Patient Last Name,Vaccine,Date Administered,DOB\n" +
            "Test,Patient,Flu,2026-09-01,1980-01-15\n" +
            ",MissingFirstName,Flu,2026-09-01,1980-01-15\n");

        var importer = new ReportImporter(NewLedger(_tempDir));
        var outcome = importer.ImportFile(path, _map);

        Assert.Single(outcome.NewRecords);
        Assert.Equal(1, outcome.SkippedRowCount);
        Assert.Empty(outcome.RejectedFiles);
    }

    [Fact]
    public void DuplicateFingerprintWithinOneRunIsCountedOnceNotFaxedTwice()
    {
        var path = WriteCsv("report.csv",
            "Patient First Name,Patient Last Name,Vaccine,Date Administered,DOB,Lot Number\n" +
            "Test,Patient,Flu,2026-09-01,1980-01-15,LOT1\n" +
            "Test,Patient,Flu,2026-09-01,1980-01-15,LOT1\n");

        var importer = new ReportImporter(NewLedger(_tempDir));
        var outcome = importer.ImportFile(path, _map);

        Assert.Single(outcome.NewRecords);
        Assert.Equal(1, outcome.DuplicateRowCount);
    }

    [Fact]
    public void RowAlreadyInTheImportLedgerIsDedupedAcrossRuns()
    {
        var path = WriteCsv("report.csv",
            "Patient First Name,Patient Last Name,Vaccine,Date Administered,DOB,Lot Number\n" +
            "Test,Patient,Flu,2026-09-01,1980-01-15,LOT1\n");

        var ledger = NewLedger(_tempDir);
        var importer = new ReportImporter(ledger);

        var firstRun = importer.ImportFile(path, _map);
        Assert.Single(firstRun.NewRecords);
        // ImportFile() itself never writes to the ledger (see its own doc
        // comment) — the orchestrator does, after a row is actually
        // resolved/queued. Simulate that here.
        ledger.AddFingerprints(firstRun.NewRecords.Select(r => r.Fingerprint));

        var secondRun = importer.ImportFile(path, _map);

        Assert.Empty(secondRun.NewRecords);
        Assert.Equal(1, secondRun.DuplicateRowCount);
    }

    [Fact]
    public void ValidXlsxIsImported()
    {
        var path = Path.Combine(_tempDir, "report.xlsx");
        using (var workbook = new XLWorkbook())
        {
            var sheet = workbook.Worksheets.Add("Report");
            sheet.Cell(1, 1).Value = "Patient First Name";
            sheet.Cell(1, 2).Value = "Patient Last Name";
            sheet.Cell(1, 3).Value = "Vaccine";
            sheet.Cell(1, 4).Value = "Date Administered";
            sheet.Cell(1, 5).Value = "DOB";
            sheet.Cell(2, 1).Value = "Test";
            sheet.Cell(2, 2).Value = "Patient";
            sheet.Cell(2, 3).Value = "Flu";
            sheet.Cell(2, 4).Value = "2026-09-01";
            sheet.Cell(2, 5).Value = "1980-01-15";
            workbook.SaveAs(path);
        }

        var importer = new ReportImporter(NewLedger(_tempDir));
        var outcome = importer.ImportFile(path, _map);

        Assert.Single(outcome.NewRecords);
        Assert.Equal("Test", outcome.NewRecords[0].PatientFirstName);
    }

    [Fact]
    public void UnreadableFileIsRejectedWithAClearMessageRatherThanThrowing()
    {
        var path = Path.Combine(_tempDir, "missing.csv");

        var importer = new ReportImporter(NewLedger(_tempDir));
        var outcome = importer.ImportFile(path, _map);

        Assert.Empty(outcome.NewRecords);
        Assert.Single(outcome.RejectedFiles);
        Assert.Equal(path, outcome.RejectedFiles[0].FilePath);
    }
}
