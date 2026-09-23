namespace VaccineAssist.Desktop.Fax;

/// <summary>Row-fingerprint ledger (imported.json) that stops the same
/// administration from being faxed twice across runs — see
/// ImmunizationRecord.Fingerprint and ReportImporter.</summary>
public interface IImportLedger
{
    IReadOnlySet<string> LoadFingerprints();

    void AddFingerprints(IEnumerable<string> fingerprints);
}
