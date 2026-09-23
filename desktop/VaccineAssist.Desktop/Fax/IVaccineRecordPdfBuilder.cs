namespace VaccineAssist.Desktop.Fax;

/// <summary>Built PDF bytes plus the page count it rendered to — the
/// PDF-builder tests assert PageCount directly rather than re-parsing
/// the bytes.</summary>
public sealed record VaccinePdfResult(byte[] PdfBytes, int PageCount);

public interface IVaccineRecordPdfBuilder
{
    /// <summary>Builds the one-PDF-per-patient-per-prescriber vaccine
    /// administration record for the prescriber (Will's brief: header,
    /// patient block, vaccine table, prescriber block, footer — no cover
    /// page).</summary>
    VaccinePdfResult Build(PatientFaxGroup group, FaxSettings faxSettings);
}
