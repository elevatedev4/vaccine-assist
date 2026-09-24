using System;
using System.IO;
using System.Linq;
using ClosedXML.Excel;
using VaccineAssist.Desktop.Fax;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// End-to-end coverage of Pioneer Rx's real immunization report export
/// (V-T53 401/column-map follow-up, Will 2026-09-23 verbatim): a 3-row
/// synthetic *.xlsx workbook, header row 1, one sheet "Sheet1", one row
/// per immunization, exactly the six columns Will's brief names —
/// "Immunization Administered On" / "Patient Full Name Last then First" /
/// "Patient Date of Birth" / "Dispensed Item Name" / "Primary Care
/// Prescriber" / "Primary Care Prescriber Fax" — run through
/// ReportImporter (DEFAULT FaxColumnMap, no overrides) and FaxGrouping.
/// Fake names/DOBs/fax number only — never real patient data (brief's own
/// PHI rule).
/// </summary>
public class PioneerColumnMapTests : IDisposable
{
    private readonly string _tempDir;

    public PioneerColumnMapTests()
    {
        _tempDir = Path.Combine(Path.GetTempPath(), "vaccine-assist-tests", Guid.NewGuid().ToString("n"));
        Directory.CreateDirectory(_tempDir);
    }

    public void Dispose()
    {
        try { Directory.Delete(_tempDir, recursive: true); } catch { /* best-effort cleanup */ }
    }

    /// <summary>Writes the 3-row synthetic workbook Will's brief describes:
    /// row 1 + 2 are the SAME patient/prescriber/fax (two different
    /// vaccines, same day — grouping should merge them into one PDF), row
    /// 3 is a different patient whose prescriber fax column is blank (no
    /// usable fax — should be reported, never crash/reject the file).
    /// Row 1's dates are raw Excel serial numbers (unformatted cells, so
    /// ClosedXML's GetString() returns the plain number as text — see
    /// ReportRowReader's own doc comment); rows 2/3 use "M/d/yyyy" text,
    /// covering both date formats Will's brief calls out.</summary>
    private string WriteSyntheticWorkbook()
    {
        var path = Path.Combine(_tempDir, "pioneer-report.xlsx");
        using var workbook = new XLWorkbook();
        var sheet = workbook.Worksheets.Add("Sheet1");

        string[] headers =
        {
            "Immunization Administered On",
            "Patient Full Name Last then First",
            "Patient Date of Birth",
            "Dispensed Item Name",
            "Primary Care Prescriber",
            "Primary Care Prescriber Fax",
        };
        for (var c = 0; c < headers.Length; c++)
        {
            sheet.Cell(1, c + 1).Value = headers[c];
        }

        // Row 2 (data row 1): Excel date serials, has a usable fax.
        sheet.Cell(2, 1).Value = 46023; // 2026-01-01 — plain number, unformatted (General).
        sheet.Cell(2, 2).Value = "Doe, Jane";
        sheet.Cell(2, 3).Value = 25000; // DOB serial.
        sheet.Cell(2, 4).Value = "Influenza";
        sheet.Cell(2, 5).Value = "Dr. Smith";
        sheet.Cell(2, 6).Value = "(555) 010-0100";

        // Row 3 (data row 2): SAME patient/prescriber/fax as row 2, a
        // second vaccine given the same day — "M/d/yyyy" text dates. DOB
        // is the SAME calendar date as row 2's serial (1968-06-11) —
        // grouping keys on patient name + DOB, so the two rows must
        // resolve to the identical DateOnly to merge into one PDF group;
        // the point of the differing FORMATS is to prove both parse to
        // that same date, not to make two different patients.
        sheet.Cell(3, 1).Value = "1/1/2026";
        sheet.Cell(3, 2).Value = "Doe, Jane";
        sheet.Cell(3, 3).Value = "6/11/1968";
        sheet.Cell(3, 4).Value = "Shingrix";
        sheet.Cell(3, 5).Value = "Dr. Smith";
        sheet.Cell(3, 6).Value = "(555) 010-0100";

        // Row 4 (data row 3): a different patient, no fax on file.
        sheet.Cell(4, 1).Value = "1/2/2026";
        sheet.Cell(4, 2).Value = "Roe, Sam";
        sheet.Cell(4, 3).Value = "6/15/1975";
        sheet.Cell(4, 4).Value = "Tdap";
        sheet.Cell(4, 5).Value = "Dr. Jones";
        sheet.Cell(4, 6).Value = "";

        workbook.SaveAs(path);
        return path;
    }

    [Fact]
    public void DefaultMapImportsAllThreeRowsWithNoRejectionAndCorrectFieldMapping()
    {
        WriteSyntheticWorkbook();
        var importer = new ReportImporter(new ImportLedger(Path.Combine(_tempDir, "imported.json")));

        var outcome = importer.Import(_tempDir, new FaxColumnMap());

        Assert.Empty(outcome.RejectedFiles);
        Assert.Equal(0, outcome.SkippedRowCount);
        Assert.Equal(3, outcome.NewRecords.Count);

        var jane = outcome.NewRecords.First(r => r.VaccineName == "Influenza");
        Assert.Equal("Jane", jane.PatientFirstName);
        Assert.Equal("Doe", jane.PatientLastName);
        Assert.Equal("Dr. Smith", jane.PrescriberName);
        Assert.Equal("(555) 010-0100", jane.PrescriberFax);
    }

    [Fact]
    public void ExcelSerialAndMSlashDSlashYyyyDatesBothParseCorrectlyForAdministeredOnAndDob()
    {
        WriteSyntheticWorkbook();
        var importer = new ReportImporter(new ImportLedger(Path.Combine(_tempDir, "imported.json")));

        var outcome = importer.Import(_tempDir, new FaxColumnMap());

        var janeFlu = outcome.NewRecords.Single(r => r.VaccineName == "Influenza");
        Assert.Equal(new DateOnly(2026, 1, 1), janeFlu.AdministeredDate); // serial 46023
        Assert.Equal(new DateOnly(1968, 6, 11), janeFlu.PatientDob); // serial 25000

        var janeShingrix = outcome.NewRecords.Single(r => r.VaccineName == "Shingrix");
        Assert.Equal(new DateOnly(2026, 1, 1), janeShingrix.AdministeredDate); // "1/1/2026"
        Assert.Equal(new DateOnly(1968, 6, 11), janeShingrix.PatientDob); // "6/11/1968" — same date as row 1's serial 25000
    }

    [Fact]
    public void GroupingMergesTheSamePatientAndPrescriberIntoOnePdfGroup()
    {
        WriteSyntheticWorkbook();
        var importer = new ReportImporter(new ImportLedger(Path.Combine(_tempDir, "imported.json")));
        var outcome = importer.Import(_tempDir, new FaxColumnMap());

        var groups = FaxGrouping.GroupByPatientAndPrescriber(outcome.NewRecords);

        Assert.Equal(2, groups.Count);
        var janeGroup = groups.Single(g => g.PatientFirstName == "Jane");
        Assert.Equal(2, janeGroup.Records.Count);
        Assert.Equal("Dr. Smith", janeGroup.PrescriberName);

        var samGroup = groups.Single(g => g.PatientFirstName == "Sam");
        Assert.Single(samGroup.Records);
    }

    [Fact]
    public void UsableFaxNormalizesToE164AndMissingFaxResolvesToNoUsableNumber()
    {
        WriteSyntheticWorkbook();
        var importer = new ReportImporter(new ImportLedger(Path.Combine(_tempDir, "imported.json")));
        var outcome = importer.Import(_tempDir, new FaxColumnMap());
        var groups = FaxGrouping.GroupByPatientAndPrescriber(outcome.NewRecords);

        var janeGroup = groups.Single(g => g.PatientFirstName == "Jane");
        // Notifyre's E.164 form — see FaxNumberNormalizer.ToE164OrNull and
        // NotifyreFaxClient.QueueAsync.
        Assert.Equal("+15550100100", FaxNumberNormalizer.ToE164OrNull(janeGroup.PrescriberFaxFromReport));

        // Will's brief: "reject rows with no usable fax (report them in
        // the summary as 'no fax on file')" — this is the same check
        // FaxRunOrchestrator.RunCoreAsync makes before queuing a group
        // (see its NeedsFaxNumber branch).
        var samGroup = groups.Single(g => g.PatientFirstName == "Sam");
        Assert.Null(FaxNumberNormalizer.ToDialableOrNull(samGroup.PrescriberFaxFromReport));
    }
}
