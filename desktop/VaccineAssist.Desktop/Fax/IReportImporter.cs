namespace VaccineAssist.Desktop.Fax;

public interface IReportImporter
{
    /// <summary>Reads ONE user-picked *.csv/*.xlsx (V-T65: tray icon ->
    /// Views/FaxSendWindow.xaml's file picker, then this runs when Will
    /// presses Send — no input folder, no scan) and validates its headers
    /// against <paramref name="columnMap"/>, parsing every row it accepts.
    /// V-T65 R6: no longer dedupes against a cross-run fingerprint ledger
    /// (that whole mechanism is gone — see ImportOutcome's doc comment);
    /// duplicate detection is FaxRunOrchestrator's job now. Does not touch
    /// any ledger or move/rename the file — see ReportImporter's doc
    /// comment.</summary>
    ImportOutcome ImportFile(string filePath, FaxColumnMap columnMap);
}
