using System.IO;
using VaccineAssist.Desktop.Logging;

namespace VaccineAssist.Desktop.Fax;

/// <summary>Shared "move a ledger entry's PDF into its terminal
/// subfolder" logic — used by both FaxRunOrchestrator (an immediate
/// vendor-side Failed on Queue_Fax) and FaxReceiptPoller (a later
/// Sent/Failed transition from Get_FaxStatus). PDFs are written to
/// fax\outbox\<yyyyMMdd>\<id>.pdf (see FaxRunOrchestrator); this walks up
/// from that file to the shared fax\ root so sent\/failed\ land as
/// siblings of outbox\, not nested inside a specific run's date
/// folder.</summary>
internal static class FaxOutboxPaths
{
    public static void MoveToTerminalFolder(FaxLedgerEntry entry, string subfolder)
    {
        if (string.IsNullOrWhiteSpace(entry.PdfPath) || !File.Exists(entry.PdfPath)) return;

        try
        {
            var faxRoot = FindFaxRoot(entry.PdfPath);
            var destinationDir = Path.Combine(faxRoot, subfolder);
            if (!Directory.Exists(destinationDir))
            {
                Directory.CreateDirectory(destinationDir);
            }

            var destination = Path.Combine(destinationDir, Path.GetFileName(entry.PdfPath));
            if (File.Exists(destination))
            {
                File.Delete(destination);
            }
            File.Move(entry.PdfPath, destination);
            entry.PdfPath = destination;
        }
        catch (Exception ex)
        {
            AppFileLog.LogException("FaxOutboxPaths.MoveToTerminalFolder", ex);
        }
    }

    private static string FindFaxRoot(string pdfPath)
    {
        var outboxDateDir = Path.GetDirectoryName(pdfPath) ?? "";
        var outboxDir = Path.GetDirectoryName(outboxDateDir) ?? outboxDateDir;
        return Path.GetDirectoryName(outboxDir) ?? outboxDir;
    }
}
