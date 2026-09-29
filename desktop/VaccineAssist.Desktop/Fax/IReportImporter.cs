namespace VaccineAssist.Desktop.Fax;

public interface IReportImporter
{
    /// <summary>Reads ONE user-picked *.csv/*.xlsx (V-T65: tray icon ->
    /// Views/FaxSendWindow.xaml's file picker, then this runs when Will
    /// presses Send — no input folder, no scan), validates its headers against
    /// <paramref name="columnMap"/>, parses it if accepted, and dedupes
    /// against the import ledger's fingerprints. Does NOT touch the
    /// ledger itself or move/rename the file — see ReportImporter's doc
    /// comment.</summary>
    ImportOutcome ImportFile(string filePath, FaxColumnMap columnMap);
}
