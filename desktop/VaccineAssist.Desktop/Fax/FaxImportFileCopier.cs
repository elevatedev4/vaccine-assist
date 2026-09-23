using System.IO;

namespace VaccineAssist.Desktop.Fax;

/// <summary>
/// Pure, testable half of the tray menu's "Vaccine faxes → Import report
/// file…" row (Will, 2026-09-22 verbatim: "A user will import the report
/// into the app directly" — no SFTP drop, no cloud pull). Copies a
/// user-picked report file into the configured Fax.InputFolder so the
/// existing ReportImporter/FaxRunOrchestrator pipeline picks it up exactly
/// like a file that landed there any other way — nothing about import/
/// dedup/PDF-build/queue/ledger changes for this path. The WPF/OpenFileDialog
/// half (not unit-testable headlessly, same reasoning as TrayIconController)
/// lives in MainWindow.xaml.cs's ImportReportFileAndRunAsync.
/// </summary>
public static class FaxImportFileCopier
{
    /// <summary>Copies sourceFilePath into inputFolder (creating it if
    /// missing), overwriting any same-named file already there — the
    /// freshest picked report wins, matching how a re-dropped file would
    /// behave. Returns the destination path. Throws InvalidOperationException
    /// (a user-facing message, shown via MessageBox by the caller) when
    /// inputFolder is blank — Will hasn't configured Fax settings yet.</summary>
    public static string CopyIntoInputFolder(string sourceFilePath, string? inputFolder)
    {
        if (string.IsNullOrWhiteSpace(inputFolder))
        {
            throw new InvalidOperationException("Set an input folder in Fax settings first.");
        }

        Directory.CreateDirectory(inputFolder);
        var destinationPath = Path.Combine(inputFolder, Path.GetFileName(sourceFilePath));
        File.Copy(sourceFilePath, destinationPath, overwrite: true);
        return destinationPath;
    }
}
