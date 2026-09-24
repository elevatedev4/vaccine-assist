using System.Collections.Generic;
using System.Globalization;
using VaccineAssist.Desktop.Fax;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

public class ReportRowParserTests
{
    // Separate first/last-name columns — decoupled from FaxColumnMap's own
    // default (Pioneer's combined "Last, First" column, see
    // PioneerColumnMapTests) so these generic parsing tests keep working
    // regardless of what the default column map looks like.
    private static readonly FaxColumnMap Map = new()
    {
        PatientFullNameHeader = null,
        PatientFirstNameHeader = "Patient First Name",
        PatientLastNameHeader = "Patient Last Name",
        VaccineNameHeader = "Vaccine",
        AdministeredDateHeader = "Date Administered",
        DobHeader = "DOB",
        LotHeader = "Lot Number",
        PrescriberNameHeader = "Prescriber Name",
    };

    private static ReportRow MakeRow(Dictionary<string, string> values) => new(values);

    [Fact]
    public void ParsesAFullyPopulatedRow()
    {
        var row = MakeRow(new Dictionary<string, string>
        {
            [Map.PatientFirstNameHeader] = "Test",
            [Map.PatientLastNameHeader] = "Patient",
            [Map.VaccineNameHeader] = "Flu",
            [Map.AdministeredDateHeader] = "2026-09-01",
            [Map.LotHeader!] = "LOT1",
            [Map.PrescriberNameHeader!] = "Dr. Synthetic",
        });

        var (record, reason) = ReportRowParser.Parse(row, Map, "test.csv");

        Assert.Null(reason);
        Assert.NotNull(record);
        Assert.Equal("Test", record!.PatientFirstName);
        Assert.Equal("Flu", record.VaccineName);
        Assert.Equal(new System.DateOnly(2026, 9, 1), record.AdministeredDate);
        Assert.Equal("LOT1", record.Lot);
        Assert.Equal("Dr. Synthetic", record.PrescriberName);
    }

    [Fact]
    public void MissingPatientNameIsSkippedWithReason()
    {
        var row = MakeRow(new Dictionary<string, string>
        {
            [Map.PatientFirstNameHeader] = "",
            [Map.PatientLastNameHeader] = "Patient",
            [Map.VaccineNameHeader] = "Flu",
            [Map.AdministeredDateHeader] = "2026-09-01",
        });

        var (record, reason) = ReportRowParser.Parse(row, Map, "test.csv");

        Assert.Null(record);
        Assert.Equal("missing patient name", reason);
    }

    [Fact]
    public void MissingVaccineNameIsSkippedWithReason()
    {
        var row = MakeRow(new Dictionary<string, string>
        {
            [Map.PatientFirstNameHeader] = "Test",
            [Map.PatientLastNameHeader] = "Patient",
            [Map.VaccineNameHeader] = "",
            [Map.AdministeredDateHeader] = "2026-09-01",
        });

        var (record, reason) = ReportRowParser.Parse(row, Map, "test.csv");

        Assert.Null(record);
        Assert.Equal("missing vaccine name", reason);
    }

    [Fact]
    public void UnparsableAdministeredDateIsSkippedWithReason()
    {
        var row = MakeRow(new Dictionary<string, string>
        {
            [Map.PatientFirstNameHeader] = "Test",
            [Map.PatientLastNameHeader] = "Patient",
            [Map.VaccineNameHeader] = "Flu",
            [Map.AdministeredDateHeader] = "not-a-date",
        });

        var (record, reason) = ReportRowParser.Parse(row, Map, "test.csv");

        Assert.Null(record);
        Assert.Equal("missing or unparsable administered date", reason);
    }

    // ---- Pioneer's real report shape (V-T53 401/column-map follow-up,
    // Will 2026-09-23) — the DEFAULT FaxColumnMap(), no overrides. ----

    [Fact]
    public void DefaultMapSplitsLastCommaFirstIntoFirstAndLastName()
    {
        var map = new FaxColumnMap();
        var row = MakeRow(new Dictionary<string, string>
        {
            [map.PatientFullNameHeader!] = "Doe, Jane",
            [map.VaccineNameHeader] = "Influenza",
            [map.AdministeredDateHeader] = "2026-09-01",
        });

        var (record, reason) = ReportRowParser.Parse(row, map, "report.xlsx");

        Assert.Null(reason);
        Assert.NotNull(record);
        Assert.Equal("Jane", record!.PatientFirstName);
        Assert.Equal("Doe", record.PatientLastName);
    }

    [Fact]
    public void DefaultMapWithNoCommaInFullNameIsSkippedAsMissingPatientName()
    {
        var map = new FaxColumnMap();
        var row = MakeRow(new Dictionary<string, string>
        {
            [map.PatientFullNameHeader!] = "Doe",
            [map.VaccineNameHeader] = "Influenza",
            [map.AdministeredDateHeader] = "2026-09-01",
        });

        var (record, reason) = ReportRowParser.Parse(row, map, "report.xlsx");

        Assert.Null(record);
        Assert.Equal("missing patient name", reason);
    }

    [Fact]
    public void DefaultMapParsesAnExcelDateSerialForAdministeredDateAndDob()
    {
        var map = new FaxColumnMap();
        const int administeredSerial = 46000;
        const int dobSerial = 25000;
        var row = MakeRow(new Dictionary<string, string>
        {
            [map.PatientFullNameHeader!] = "Doe, Jane",
            [map.VaccineNameHeader] = "Influenza",
            [map.AdministeredDateHeader] = administeredSerial.ToString(CultureInfo.InvariantCulture),
            [map.DobHeader!] = dobSerial.ToString(CultureInfo.InvariantCulture),
        });

        var (record, _) = ReportRowParser.Parse(row, map, "report.xlsx");

        Assert.NotNull(record);
        // Excel's (bug-compatible) day-zero, matching
        // ReportRowParser.TryParseDate's own serial-number fallback.
        Assert.Equal(ExcelSerialToDateOnly(administeredSerial), record!.AdministeredDate);
        Assert.Equal(ExcelSerialToDateOnly(dobSerial), record.PatientDob);
    }

    private static System.DateOnly ExcelSerialToDateOnly(int serial) =>
        System.DateOnly.FromDateTime(new System.DateTime(1899, 12, 30).AddDays(serial));

    [Fact]
    public void DefaultMapParsesAnMSlashDSlashYyyyStringForAdministeredDateAndDob()
    {
        var map = new FaxColumnMap();
        var row = MakeRow(new Dictionary<string, string>
        {
            [map.PatientFullNameHeader!] = "Doe, Jane",
            [map.VaccineNameHeader] = "Influenza",
            [map.AdministeredDateHeader] = "9/1/2026",
            [map.DobHeader!] = "3/4/1968",
        });

        var (record, _) = ReportRowParser.Parse(row, map, "report.xlsx");

        Assert.NotNull(record);
        Assert.Equal(new System.DateOnly(2026, 9, 1), record!.AdministeredDate);
        Assert.Equal(new System.DateOnly(1968, 3, 4), record.PatientDob);
    }

    [Fact]
    public void DefaultMapReadsDispensedItemNameAndPrimaryCarePrescriberColumns()
    {
        var map = new FaxColumnMap();
        var row = MakeRow(new Dictionary<string, string>
        {
            [map.PatientFullNameHeader!] = "Doe, Jane",
            [map.VaccineNameHeader] = "Shingrix",
            [map.AdministeredDateHeader] = "2026-09-01",
            [map.PrescriberNameHeader!] = "Dr. Synthetic",
            [map.PrescriberFaxHeader!] = "(555) 010-0100",
        });

        var (record, _) = ReportRowParser.Parse(row, map, "report.xlsx");

        Assert.NotNull(record);
        Assert.Equal("Shingrix", record!.VaccineName);
        Assert.Equal("Dr. Synthetic", record.PrescriberName);
        Assert.Equal("(555) 010-0100", record.PrescriberFax);
    }
}
