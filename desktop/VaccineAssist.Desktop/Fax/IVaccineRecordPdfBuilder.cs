namespace VaccineAssist.Desktop.Fax;

/// <summary>Built PDF bytes plus the page count it rendered to — the
/// PDF-builder tests assert PageCount directly rather than re-parsing
/// the bytes.</summary>
public sealed record VaccinePdfResult(byte[] PdfBytes, int PageCount);

public interface IVaccineRecordPdfBuilder
{
    /// <summary>Builds the one-fax-per-patient-per-prescriber vaccine
    /// administration notification letter (fax-report-layout brief,
    /// 2026-09-28: title, pharmacy block, "To:" block, body paragraph,
    /// 4-column vaccine table, signature — matches Will's current fax
    /// example — no cover page). <paramref name="resolvedFaxNumber"/> is
    /// the dialable digits FaxRunOrchestrator actually queues this fax
    /// to (report column or PrescriberDirectory fallback, whichever
    /// resolved it) — shown in the "To:" block's Fax line via
    /// FaxNumberNormalizer.ToDisplay so the letter always names the
    /// number it was actually sent to, never a stale/report-only
    /// value.</summary>
    VaccinePdfResult Build(PatientFaxGroup group, FaxSettings faxSettings, string resolvedFaxNumber);
}
