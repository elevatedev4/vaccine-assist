using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using VaccineAssist.Desktop.Fax;
using VaccineAssist.Desktop.Services;
using VaccineAssist.Desktop.Settings;
using VaccineAssist.Desktop.ViewModels;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// V-T65 R4 (Will, verbatim, 2026-09-29): "have that open a dialogue
/// window where you can selec tht efile then push send then see the
/// results below." Exercises FaxSendViewModel's NoFile -> FileChosen ->
/// Sending -> Done state machine as pure logic (a real FaxRunOrchestrator
/// wired to fakes/temp-dir doubles — same MakeOrchestrator convention as
/// FaxRunOrchestratorTests — no WPF Window/OpenFileDialog involved at
/// all, matching the "Windows test project can't run on macOS, keep the
/// pure logic separately testable" brief).
///
/// V-T65 R5: FaxSendViewModel is now a thin pass-through over
/// FaxSendCoordinator (see that class's doc comment) — MakeViewModel below
/// builds a coordinator wired to the same temp-dir fakes/doubles and wraps
/// it, so every existing assertion here still exercises the real state
/// machine, just one layer down.
/// </summary>
public class FaxSendViewModelTests : IDisposable
{
    private readonly string _tempDir;
    private readonly string _inputDir;
    private readonly string _faxRootDir;

    public FaxSendViewModelTests()
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

    private FaxRunOrchestrator MakeOrchestrator(out FakeFaxClient faxClient, out FaxLedger faxLedger)
    {
        var importLedger = new ImportLedger(Path.Combine(_tempDir, "imported.json"));
        var reportImporter = new ReportImporter(importLedger);
        faxClient = new FakeFaxClient();
        faxLedger = new FaxLedger(Path.Combine(_tempDir, "ledger.json"));
        var fileLedger = new FaxFileLedger(Path.Combine(_tempDir, "sent-files.json"));

        return new FaxRunOrchestrator(
            reportImporter, new VaccineRecordPdfBuilder(),
            faxClient, faxLedger, importLedger, _faxRootDir, fileLedger);
    }

    private FaxSendViewModel MakeViewModel(FaxRunOrchestrator orchestrator, FaxLedger faxLedger) =>
        MakeViewModel(orchestrator, faxLedger, out _);

    private FaxSendViewModel MakeViewModel(FaxRunOrchestrator orchestrator, FaxLedger faxLedger, out FaxSendCoordinator coordinator)
    {
        var historyStore = new FaxRunHistoryStore(Path.Combine(_faxRootDir, "runs"));
        coordinator = new FaxSendCoordinator(orchestrator, MakeSettings(), faxLedger, historyStore);
        return new FaxSendViewModel(coordinator);
    }

    private static AppSettings MakeSettings() => new()
    {
        Fax = new FaxSettings
        {
            PharmacyName = "Test Pharmacy",
            PharmacyPhone = "5555550100",
            PharmacyFax = "5555550101",
            SenderEmail = "sender@example.com",
        },
    };

    // Headers match FaxColumnMap's DEFAULT (Pioneer's real export) — same
    // shape as FaxRunOrchestratorTests.WriteReport.
    private string WriteReport(string fileName, string prescriberFax = "5555550200", string prescriberName = "Dr. Synthetic")
    {
        var path = Path.Combine(_inputDir, fileName);
        File.WriteAllText(path,
            "Patient Full Name Last then First,Patient Date of Birth,Dispensed Item Name,Immunization Administered On,Primary Care Prescriber,Primary Care Prescriber Fax\n" +
            $"\"Patient, Test\",1980-01-15,Flu,2026-09-01,{prescriberName},{prescriberFax}\n");
        return path;
    }

    [Fact]
    public void StartsInNoFileWithSendDisabled()
    {
        var orchestrator = MakeOrchestrator(out _, out var faxLedger);
        var vm = MakeViewModel(orchestrator, faxLedger);

        Assert.Equal(FaxSendState.NoFile, vm.State);
        Assert.Null(vm.FilePath);
        Assert.False(vm.SendCommand.CanExecute(null));
        Assert.Empty(vm.Rows);
    }

    [Fact]
    public void ChoosingAFileMovesToFileChosenAndEnablesSend()
    {
        var reportPath = WriteReport("report.csv");
        var orchestrator = MakeOrchestrator(out _, out var faxLedger);
        var vm = MakeViewModel(orchestrator, faxLedger);

        vm.SetChosenFile(reportPath);

        Assert.Equal(FaxSendState.FileChosen, vm.State);
        Assert.Equal(reportPath, vm.FilePath);
        Assert.True(vm.SendCommand.CanExecute(null));
    }

    [Fact]
    public async Task NothingSendsUntilSendIsPressed()
    {
        // V-T65 R4's core requirement: picking a file must NOT trigger a
        // send by itself — only SendAsync (SendCommand) may.
        var reportPath = WriteReport("report.csv");
        var orchestrator = MakeOrchestrator(out var faxClient, out var faxLedger);
        var vm = MakeViewModel(orchestrator, faxLedger);

        vm.SetChosenFile(reportPath);
        Assert.Empty(faxClient.QueuedRequests);

        await vm.SendAsync();

        Assert.Single(faxClient.QueuedRequests);
    }

    [Fact]
    public async Task SendingPopulatesRowsAndMovesToDoneWithATotalsMessage()
    {
        var reportPath = WriteReport("report.csv");
        var orchestrator = MakeOrchestrator(out _, out var faxLedger);
        var vm = MakeViewModel(orchestrator, faxLedger);
        vm.SetChosenFile(reportPath);

        await vm.SendAsync();

        Assert.Equal(FaxSendState.Done, vm.State);
        Assert.Single(vm.Rows);
        // FakeFaxClient's QueueAsync succeeds but GetStatusAsync defaults
        // to InProcess (no StatusResults entry configured) — same
        // "marks the ledger InProcess" behavior FaxRunOrchestratorTests'
        // SuccessfulRunQueuesTheFaxAndMarksTheLedgerInProcess asserts.
        Assert.Equal(1, vm.Summary!.InProcess);
        Assert.Equal(0, vm.Summary!.Sent);
        Assert.Contains("0 sent", vm.StatusMessage);
        Assert.Null(vm.RejectionMessage);
        Assert.False(vm.HasRejection);
    }

    [Fact]
    public async Task ARejectedFileSurfacesTheRejectionReasonRatherThanLookingLikeNothingHappened()
    {
        // Task A finding: the old FaxRunSummaryWindow never displayed
        // FaxRunSummary.RejectedFiles at all — a missing-required-column
        // file looked exactly like "nothing happened." FaxSendViewModel
        // must surface it.
        var path = Path.Combine(_inputDir, "bad.csv");
        File.WriteAllText(path, "Not,The,Right,Headers\nx,y,z,w\n");
        var orchestrator = MakeOrchestrator(out var faxClient, out var faxLedger);
        var vm = MakeViewModel(orchestrator, faxLedger);
        vm.SetChosenFile(path);

        await vm.SendAsync();

        Assert.Empty(faxClient.QueuedRequests);
        Assert.Empty(vm.Rows);
        Assert.True(vm.HasRejection);
        Assert.NotNull(vm.RejectionMessage);
        Assert.Contains("Missing required column", vm.RejectionMessage);
        // Still Done, not stuck Sending — a rejected file is a completed
        // (if unsuccessful) run, not an in-flight one.
        Assert.Equal(FaxSendState.Done, vm.State);
    }

    [Fact]
    public async Task PickingANewFileAfterARunClearsThePreviousResults()
    {
        var firstReport = WriteReport("report1.csv");
        var orchestrator = MakeOrchestrator(out _, out var faxLedger);
        var vm = MakeViewModel(orchestrator, faxLedger);
        vm.SetChosenFile(firstReport);
        await vm.SendAsync();
        Assert.Single(vm.Rows);

        var secondReport = WriteReport("report2.csv", prescriberFax: "5555550300");
        vm.SetChosenFile(secondReport);

        Assert.Equal(FaxSendState.FileChosen, vm.State);
        Assert.Empty(vm.Rows);
        Assert.Null(vm.Summary);
        Assert.Null(vm.StatusMessage);
    }

    [Fact]
    public async Task RetryCommandOnlyEnabledForFailedRows()
    {
        var reportPath = WriteReport("report.csv");
        var orchestrator = MakeOrchestrator(out var faxClient, out var faxLedger);
        faxClient.QueueResults.Enqueue(new FaxQueueResult(false, null, "vendor rejected the number"));
        var vm = MakeViewModel(orchestrator, faxLedger);
        vm.SetChosenFile(reportPath);

        await vm.SendAsync();

        var failedRow = vm.Rows.Single();
        Assert.Equal(nameof(FaxLedgerStatus.Failed), failedRow.Status);
        Assert.True(vm.RetryCommand.CanExecute(failedRow));

        await vm.RetryAsync(failedRow);

        Assert.Equal(nameof(FaxLedgerStatus.InProcess), failedRow.Status);
        Assert.False(vm.RetryCommand.CanExecute(failedRow));
    }

    // ---- V-T65 R5 (Will, verbatim, 2026-09-29): "it still shows status
    // 'InProcess' in the app. Need to make sure this stuff updates ...
    // allow the app to work from the background to send faxes ... Need to
    // also be able to get back to send history." ----

    [Fact]
    public async Task RefreshNowPicksUpAStatusChangeFaxRunSchedulerWroteInTheBackground()
    {
        // Simulates FaxRunScheduler's own background FaxReceiptPoller tick
        // updating ledger.json between refreshes — the window must reflect
        // that without Will closing and reopening it.
        var reportPath = WriteReport("report.csv");
        var orchestrator = MakeOrchestrator(out _, out var faxLedger);
        var vm = MakeViewModel(orchestrator, faxLedger, out var coordinator);
        vm.SetChosenFile(reportPath);
        await vm.SendAsync();

        var row = vm.Rows.Single();
        Assert.Equal(nameof(FaxLedgerStatus.InProcess), row.Status);
        Assert.Contains("1 in process", vm.SummaryLine);

        var entries = faxLedger.Load();
        entries.Single(e => e.Id == row.LedgerEntryId).Status = FaxLedgerStatus.Sent;
        faxLedger.Save(entries);

        coordinator.RefreshNow();

        Assert.Equal(nameof(FaxLedgerStatus.Sent), row.Status);
        Assert.Equal("Done: 1 sent, 0 failed", vm.SummaryLine);
    }

    [Fact]
    public async Task InProcessCountChangedFiresWhenARowResolves()
    {
        var reportPath = WriteReport("report.csv");
        var orchestrator = MakeOrchestrator(out _, out var faxLedger);
        var vm = MakeViewModel(orchestrator, faxLedger, out var coordinator);
        var raised = 0;
        coordinator.InProcessCountChanged += (_, _) => raised++;
        vm.SetChosenFile(reportPath);

        await vm.SendAsync(); // 0 -> 1 in-process: one raise
        Assert.Equal(1, coordinator.InProcessCount);

        var entries = faxLedger.Load();
        entries.Single().Status = FaxLedgerStatus.Sent;
        faxLedger.Save(entries);
        coordinator.RefreshNow(); // 1 -> 0 in-process: another raise

        Assert.Equal(0, coordinator.InProcessCount);
        Assert.True(raised >= 2);
    }

    [Fact]
    public async Task ReopeningTheWindowReusesTheSameCoordinatorsLiveState()
    {
        // MainWindow.ShowFaxSendWindow builds a NEW FaxSendViewModel every
        // time but always wraps the SAME FaxSendCoordinator — closing the
        // window must not lose an in-flight send, and a second VM must see
        // it immediately.
        var reportPath = WriteReport("report.csv");
        var orchestrator = MakeOrchestrator(out var faxClient, out var faxLedger);
        var firstVm = MakeViewModel(orchestrator, faxLedger, out var coordinator);
        firstVm.SetChosenFile(reportPath);
        await firstVm.SendAsync();

        // "Close" the first window (drop the VM) and "reopen" it — same
        // production pattern as MainWindow's ShowFaxSendWindow.
        var secondVm = new FaxSendViewModel(coordinator);

        Assert.Equal(FaxSendState.Done, secondVm.State);
        Assert.Single(secondVm.Rows);
        // Same underlying ObservableCollection — the coordinator's, not a
        // fresh snapshot — so both VMs see the identical row instance.
        Assert.Same(firstVm.Rows.Single(), secondVm.Rows.Single());
        Assert.Single(faxClient.QueuedRequests); // reopening never re-sends

        // Reviewer fix (V-T65 R5 REQUEST_CHANGES, 2026-09-29): closing the
        // first window (MainWindow.xaml.cs's FaxSendWindow.Closed handler)
        // disposes its VM — that must actually unsubscribe from the
        // session-long coordinator, or every open/close cycle leaks one
        // more VM forever.
        var firstVmNotifications = 0;
        var secondVmNotifications = 0;
        firstVm.PropertyChanged += (_, _) => firstVmNotifications++;
        secondVm.PropertyChanged += (_, _) => secondVmNotifications++;

        firstVm.Dispose();
        var secondReport = WriteReport("report2.csv", prescriberFax: "5555550300");
        coordinator.SetChosenFile(secondReport); // a real coordinator change, same as picking a new file

        Assert.Equal(0, firstVmNotifications); // disposed — must not still be listening
        Assert.True(secondVmNotifications > 0); // still attached — must still be listening

        // Disposing twice (e.g. Closed firing more than once) must not throw.
        firstVm.Dispose();
    }

    [Fact]
    public async Task SendHistoryShowsThePastBatchRightAfterSending()
    {
        var reportPath = WriteReport("report.csv");
        var orchestrator = MakeOrchestrator(out _, out var faxLedger);
        var vm = MakeViewModel(orchestrator, faxLedger);
        vm.SetChosenFile(reportPath);

        await vm.SendAsync();

        var batch = Assert.Single(vm.History);
        Assert.Equal("report.csv", batch.FileName);
        Assert.Equal(1, batch.InProcess);
    }
}
