namespace VaccineAssist.Desktop.Fax;

public interface IReportImporter
{
    /// <summary>Reads every new *.csv/*.xlsx in <paramref name="inputFolder"/>,
    /// validates each file's headers against <paramref name="columnMap"/>,
    /// parses accepted files, and dedupes against the import ledger's
    /// fingerprints. Does NOT move files or touch the ledger itself — see
    /// ReportImporter's doc comment for why that's a separate, explicit
    /// step (MoveAcceptedFiles/RecordFingerprints) rather than a side
    /// effect of Import.</summary>
    ImportOutcome Import(string inputFolder, FaxColumnMap columnMap);

    /// <summary>Moves every accepted file to
    /// <paramref name="inputFolder"/>\processed\<paramref name="runDate"/>\ —
    /// called only after the records Import returned have been
    /// successfully queued/faxed (see FaxRunOrchestrator), so a run that
    /// fails partway through doesn't lose the source file.</summary>
    void MoveAcceptedFiles(IReadOnlyList<string> acceptedFilePaths, string inputFolder, DateOnly runDate);
}
