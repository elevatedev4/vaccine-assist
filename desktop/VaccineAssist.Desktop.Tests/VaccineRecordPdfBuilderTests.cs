using System;
using System.Collections.Generic;
using System.Linq;
using VaccineAssist.Desktop.Fax;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

public class VaccineRecordPdfBuilderTests
{
    private static readonly FaxSettings Settings = new()
    {
        PharmacyName = "Test Pharmacy",
        PharmacyPhone = "5555550100",
        PharmacyFax = "5555550101",
    };

    private static ImmunizationRecord MakeRecord(int dayOffset) => new()
    {
        PatientFirstName = "Test",
        PatientLastName = "Patient",
        VaccineName = $"Vaccine {dayOffset}",
        AdministeredDate = new DateOnly(2026, 9, 1).AddDays(dayOffset),
        Lot = $"LOT{dayOffset}",
        PrescriberName = "Dr. Synthetic",
    };

    private static PatientFaxGroup MakeGroup(int recordCount)
    {
        var records = Enumerable.Range(0, recordCount).Select(MakeRecord).ToList();
        return new PatientFaxGroup
        {
            PatientKey = "TEST|PATIENT|",
            PrescriberKey = "name:DR. SYNTHETIC",
            Records = records,
        };
    }

    [Fact]
    public void ProducesNonEmptyPdfBytes()
    {
        var builder = new VaccineRecordPdfBuilder();

        var result = builder.Build(MakeGroup(1), Settings);

        Assert.NotEmpty(result.PdfBytes);
        // %PDF is the standard file-signature header every PDF starts with.
        Assert.Equal("%PDF", System.Text.Encoding.ASCII.GetString(result.PdfBytes, 0, 4));
    }

    [Fact]
    public void FewVaccinesFitOnOnePage()
    {
        var builder = new VaccineRecordPdfBuilder();

        var result = builder.Build(MakeGroup(2), Settings);

        Assert.Equal(1, result.PageCount);
    }

    [Fact]
    public void ManyVaccinesSpanMultiplePages()
    {
        var builder = new VaccineRecordPdfBuilder();

        // Comfortably more rows than fit on a single Letter-sized page at
        // this table's row height.
        var result = builder.Build(MakeGroup(80), Settings);

        Assert.True(result.PageCount > 1, $"Expected more than 1 page for 80 records, got {result.PageCount}");
    }
}
