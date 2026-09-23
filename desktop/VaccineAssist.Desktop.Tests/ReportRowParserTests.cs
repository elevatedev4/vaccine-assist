using System.Collections.Generic;
using VaccineAssist.Desktop.Fax;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

public class ReportRowParserTests
{
    private static readonly FaxColumnMap Map = new();

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
}
