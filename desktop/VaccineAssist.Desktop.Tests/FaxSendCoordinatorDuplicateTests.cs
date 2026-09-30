using System;
using System.IO;
using System.Threading.Tasks;
using VaccineAssist.Desktop.Fax;
using VaccineAssist.Desktop.Services;
using VaccineAssist.Desktop.Settings;
using VaccineAssist.Desktop.ViewModels;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>V-T65 R6 (Will, verbatim, 2026-09-29): "show an alert, allowing
/// them to continue and potentially send duplicates, cancel altogether, or
/// only send non-duplicates." Exercises FaxSendCoordinator.SendAsync's
/// Preview -> ConfirmDuplicates -> RunAsync flow directly (no WPF Window
/// involved — ConfirmDuplicates is a plain delegate, set here to a fake
/// the same way MainWindow.xaml.cs wires a real dialog).</summary>
public class FaxSendCoordinatorDuplicateTests : IDisposable
{
    private readonly string _tempDir;
    private readonly string _inputDir;
    private readonly string _faxRootDir;

    public FaxSendCoordinatorDuplicateTests()
    {
        _tempDir = Path.Combine(Path.GetTempPath(), "vaccine-assist-tests", Guid.NewGuid().ToString("n"));
        _inputDir = Path.Combine(_tempDir, "input");
        _faxRootDir = Path.Combine(_tempDir, "fax");
        Directory.CreateDirectory(_inputDir);
    }

    public void Dispose()
    {
        try { Directory.Delete(_tempDir, recursive: true); } catch { /* best-effort */ }
    }

    private FaxSendCoordinator MakeCoordinator(out FakeFaxClient faxClient)
    {
        var reportImporter = new ReportImporter();
        faxClient = new FakeFaxClient();
        var faxLedger = new FaxLedger(Path.Combine(_tempDir, "ledger.json"));
        var fileLedger = new FaxFileLedger(Path.Combine(_tempDir, "sent-files.json"));
        var orchestrator = new FaxRunOrchestrator(
            reportImporter, new VaccineRecordPdfBuilder(),
            faxClient, faxLedger, _faxRootDir, fileLedger);
        var historyStore = new FaxRunHistoryStore(Path.Combine(_faxRootDir, "runs"));
        var settings = new AppSettings
        {
            Fax = new FaxSettings
            {
                PharmacyName = "Test Pharmacy",
                PharmacyPhone = "5555550100",
                PharmacyFax = "5555550101",
                SenderEmail = "sender@example.com",
            },
        };

        return new FaxSendCoordinator(orchestrator, settings, faxLedger, historyStore);
    }

    private string WriteReport(string fileName, string vaccine = "Flu", string date = "2026-09-01") =>
        WriteReportAt(Path.Combine(_inputDir, fileName), vaccine, date);

    private static string WriteReportAt(string path, string vaccine, string date)
    {
        File.WriteAllText(path,
            "Patient Full Name Last then First,Patient Date of Birth,Dispensed Item Name,Immunization Administered On,Primary Care Prescriber,Primary Care Prescriber Fax\n" +
            $"\"Patient, Test\",1980-01-15,{vaccine},{date},Dr. Synthetic,5555550200\n");
        return path;
    }

    [Fact]
    public async Task NoDuplicatesNeverInvokesConfirmDuplicates()
    {
        var coordinator = MakeCoordinator(out var faxClient);
        var invoked = false;
        coordinator.ConfirmDuplicates = _ => { invoked = true; return FaxDuplicateChoice.SendAll; };
        coordinator.SetChosenFile(WriteReport("report.csv"));

        await coordinator.SendAsync();

        Assert.False(invoked);
        Assert.Single(faxClient.QueuedRequests);
    }

    [Fact]
    public async Task ConfirmDuplicatesSendAllSendsTheDuplicateAnyway()
    {
        var coordinator = MakeCoordinator(out var faxClient);
        coordinator.SetChosenFile(WriteReport("report1.csv"));
        await coordinator.SendAsync();

        coordinator.ConfirmDuplicates = matches =>
        {
            Assert.Single(matches);
            return FaxDuplicateChoice.SendAll;
        };
        coordinator.SetChosenFile(WriteReport("report2.csv"));
        await coordinator.SendAsync();

        Assert.Equal(2, faxClient.QueuedRequests.Count);
        Assert.Equal(FaxSendState.Done, coordinator.State);
    }

    [Fact]
    public async Task ConfirmDuplicatesSendOnlyNewSkipsTheDuplicateRow()
    {
        var coordinator = MakeCoordinator(out var faxClient);
        coordinator.SetChosenFile(WriteReport("report1.csv"));
        await coordinator.SendAsync();

        coordinator.ConfirmDuplicates = _ => FaxDuplicateChoice.SendOnlyNew;
        coordinator.SetChosenFile(WriteReport("report2.csv"));
        await coordinator.SendAsync();

        Assert.Single(faxClient.QueuedRequests); // the duplicate was never re-queued
        Assert.Contains(coordinator.Rows, r => r.Status.StartsWith("Skipped — duplicate of", StringComparison.Ordinal));
    }

    [Fact]
    public async Task CancellingTheDialogSendsNothingAndReturnsToFileChosen()
    {
        var coordinator = MakeCoordinator(out var faxClient);
        coordinator.SetChosenFile(WriteReport("report1.csv"));
        await coordinator.SendAsync();

        coordinator.ConfirmDuplicates = _ => null; // Will closed/cancelled the dialog
        coordinator.SetChosenFile(WriteReport("report2.csv"));
        await coordinator.SendAsync();

        Assert.Single(faxClient.QueuedRequests); // nothing new sent
        Assert.Equal(FaxSendState.FileChosen, coordinator.State);
    }

    [Fact]
    public async Task NoConfirmDuplicatesWiredDefensivelyCancelsRatherThanSendingSilently()
    {
        var coordinator = MakeCoordinator(out var faxClient);
        coordinator.SetChosenFile(WriteReport("report1.csv"));
        await coordinator.SendAsync();

        // ConfirmDuplicates never set (e.g. a bug in the wiring) — must
        // never fall through to sending duplicates without Will's say-so.
        coordinator.SetChosenFile(WriteReport("report2.csv"));
        await coordinator.SendAsync();

        Assert.Single(faxClient.QueuedRequests);
        Assert.Equal(FaxSendState.FileChosen, coordinator.State);
    }
}
