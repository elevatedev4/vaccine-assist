using System;
using System.IO;
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

        var importer = new ReportImporter();
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

        var importer = new ReportImporter();
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

        var importer = new ReportImporter();
        var outcome = importer.ImportFile(path, _map);

        Assert.Single(outcome.NewRecords);
        Assert.Equal(1, outcome.SkippedRowCount);
        Assert.Empty(outcome.RejectedFiles);
    }

    [Fact]
    public void RowsWithTheSameDataAreAllImportedNoLongerDedupedAtImportTime()
    {
        // V-T65 R6 (Will, verbatim, 2026-09-29): "we can't store patient
        // name" — ImportFile no longer dedupes rows against a cross-run
        // fingerprint ledger at all (that whole mechanism, including
        // ImportLedger/imported.json, is gone). Duplicate detection now
        // happens one layer up (FaxRunOrchestrator, via
        // FaxDuplicateDetector against FaxFileLedger's date/vaccine/count
        // shape) — see FaxDuplicateDetectorTests and
        // FaxRunOrchestratorTests.
        var path = WriteCsv("report.csv",
            "Patient First Name,Patient Last Name,Vaccine,Date Administered,DOB,Lot Number\n" +
            "Test,Patient,Flu,2026-09-01,1980-01-15,LOT1\n" +
            "Test,Patient,Flu,2026-09-01,1980-01-15,LOT1\n");

        var importer = new ReportImporter();
        var outcome = importer.ImportFile(path, _map);

        Assert.Equal(2, outcome.NewRecords.Count);
    }

    [Fact]
    public void ReimportingTheSameFileTwiceReturnsTheSameRowsBothTimes()
    {
        var path = WriteCsv("report.csv",
            "Patient First Name,Patient Last Name,Vaccine,Date Administered,DOB,Lot Number\n" +
            "Test,Patient,Flu,2026-09-01,1980-01-15,LOT1\n");

        var importer = new ReportImporter();

        var firstRun = importer.ImportFile(path, _map);
        var secondRun = importer.ImportFile(path, _map);

        Assert.Single(firstRun.NewRecords);
        Assert.Single(secondRun.NewRecords);
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

        var importer = new ReportImporter();
        var outcome = importer.ImportFile(path, _map);

        Assert.Single(outcome.NewRecords);
        Assert.Equal("Test", outcome.NewRecords[0].PatientFirstName);
    }

    [Fact]
    public void XlsxWithADateTimeFormattedCellForAdministeredDateAndDobStillImports()
    {
        // V-T65 R4 (Will, 2026-09-29, verbatim: "Tried using my sample
        // report and it didn't send any faxes"). Reproduces the real
        // shape of Will's attached sample-fax-report.xlsx WITHOUT copying
        // it (synthetic names/numbers only, per brief): Pioneer's export
        // has the two date columns formatted with a full date+time number
        // format, not a bare date — ClosedXML's Cell.GetString() then
        // returns "9/28/2026 12:00:00 AM" rather than "9/28/2026", which
        // ReportRowParser.TryParseDate used to reject outright (every row
        // silently skipped as "missing or unparsable administered date",
        // 0 rows ever reaching a fax group). Uses the DEFAULT column map
        // (Pioneer's real header names), same as the live app.
        var map = new FaxColumnMap();
        var path = Path.Combine(_tempDir, "pioneer-shape.xlsx");
        using (var workbook = new XLWorkbook())
        {
            var sheet = workbook.Worksheets.Add("Sheet1");
            sheet.Cell(1, 1).Value = "Immunization Administered On";
            sheet.Cell(1, 2).Value = "Patient Full Name Last then First";
            sheet.Cell(1, 3).Value = "Patient Date of Birth";
            sheet.Cell(1, 4).Value = "Dispensed Item Name";
            sheet.Cell(1, 5).Value = "Primary Care Prescriber";
            sheet.Cell(1, 6).Value = "Primary Care Prescriber Fax";

            var administeredCell = sheet.Cell(2, 1);
            administeredCell.Value = new DateTime(2026, 9, 28);
            administeredCell.Style.DateFormat.Format = "M/d/yyyy h:mm:ss tt";

            sheet.Cell(2, 2).Value = "Synthetic, Sam";

            var dobCell = sheet.Cell(2, 3);
            dobCell.Value = new DateTime(1980, 1, 15);
            dobCell.Style.DateFormat.Format = "M/d/yyyy h:mm:ss tt";

            sheet.Cell(2, 4).Value = "Influenza";
            sheet.Cell(2, 5).Value = "Dr. Synthetic";
            sheet.Cell(2, 6).Value = "(555) 010-0100";
            workbook.SaveAs(path);
        }

        var importer = new ReportImporter();
        var outcome = importer.ImportFile(path, map);

        Assert.Empty(outcome.RejectedFiles);
        Assert.Equal(0, outcome.SkippedRowCount);
        Assert.Single(outcome.NewRecords);
        Assert.Equal(new DateOnly(2026, 9, 28), outcome.NewRecords[0].AdministeredDate);
        Assert.Equal(new DateOnly(1980, 1, 15), outcome.NewRecords[0].PatientDob);
    }

    [Fact]
    public void UnreadableFileIsRejectedWithAClearMessageRatherThanThrowing()
    {
        var path = Path.Combine(_tempDir, "missing.csv");

        var importer = new ReportImporter();
        var outcome = importer.ImportFile(path, _map);

        Assert.Empty(outcome.NewRecords);
        Assert.Single(outcome.RejectedFiles);
        Assert.Equal(path, outcome.RejectedFiles[0].FilePath);
    }
}
