using System.Collections.ObjectModel;
using System.IO;
using System.Windows.Input;
using VaccineAssist.Desktop.Common;
using VaccineAssist.Desktop.Fax;
using VaccineAssist.Desktop.Logging;
using VaccineAssist.Desktop.Settings;

namespace VaccineAssist.Desktop.ViewModels;

/// <summary>
/// Backs Views/FaxSendWindow.xaml — V-T65 R4 (Will, verbatim, 2026-09-29):
/// "Tried using my sample report and it didn't send any faxes. I would
/// you to make the menu be called 'Vaccines-Send PCP faxes', have that
/// open a dialogue window where you can selec tht efile then push send
/// then see the results below." Replaces the old immediate-send-on-pick
/// flow (MainWindow.ImportReportFileAndSendAsync) and the separate
/// FaxRunSummaryWindow — one window now owns file selection AND results,
/// and nothing sends until Send is explicitly pressed.
///
/// Reuses FaxRunOrchestrator.RunAsync verbatim (no new pipeline
/// abstraction) — this ViewModel only adds the NoFile -> FileChosen ->
/// Sending -> Done state machine (see FaxSendState) around that one call,
/// plus the same per-row RetryCommand FaxRunSummaryViewModel had.
///
/// Also surfaces RejectedFiles (V-T65 R4 Task A finding): the old summary
/// window never displayed FaxRunSummary.RejectedFiles at all, so a
/// missing-required-column rejection showed as an all-zero summary with
/// no visible explanation — indistinguishable from "nothing happened."
/// RejectionMessage below is bound in the window whenever a run comes
/// back with a rejected file.
/// </summary>
public sealed class FaxSendViewModel : ObservableObject
{
    private readonly FaxRunOrchestrator _orchestrator;
    private readonly AppSettings _settings;

    private FaxSendState _state = FaxSendState.NoFile;
    private string? _filePath;
    private string? _statusMessage;
    private string? _rejectionMessage;
    private FaxRunSummary? _summary;

    public FaxSendViewModel(FaxRunOrchestrator orchestrator, AppSettings settings)
    {
        _orchestrator = orchestrator;
        _settings = settings;

        Rows = new ObservableCollection<FaxRunRowSummary>();
        SendCommand = new AsyncRelayCommand(SendAsync, () => State == FaxSendState.FileChosen);
        RetryCommand = new AsyncRelayCommand<FaxRunRowSummary>(RetryAsync, row =>
            row is not null && string.Equals(row.Status, nameof(FaxLedgerStatus.Failed), System.StringComparison.OrdinalIgnoreCase));
    }

    public FaxSendState State
    {
        get => _state;
        private set
        {
            if (SetProperty(ref _state, value))
            {
                OnPropertyChanged(nameof(CanChooseFile));
                OnPropertyChanged(nameof(IsSending));
                (SendCommand as AsyncRelayCommand)?.RaiseCanExecuteChanged();
            }
        }
    }

    /// <summary>Full path of the currently-picked report file, or null
    /// before Will has chosen one — shown read-only in the file-path
    /// box.</summary>
    public string? FilePath
    {
        get => _filePath;
        private set => SetProperty(ref _filePath, value);
    }

    /// <summary>Just the file name, for the totals/status line — never the
    /// full path (which can carry a Windows profile username).</summary>
    public string? FileName => string.IsNullOrEmpty(FilePath) ? null : Path.GetFileName(FilePath);

    /// <summary>False while a run is in flight, so "Choose file…" can't
    /// swap the file (or start a second OpenFileDialog) mid-send.</summary>
    public bool CanChooseFile => State != FaxSendState.Sending;

    public bool IsSending => State == FaxSendState.Sending;

    public string? StatusMessage
    {
        get => _statusMessage;
        private set => SetProperty(ref _statusMessage, value);
    }

    /// <summary>Non-null only when the last run's file was rejected
    /// outright (missing required column, unreadable file, etc.) — see
    /// class doc comment.</summary>
    public string? RejectionMessage
    {
        get => _rejectionMessage;
        private set
        {
            if (SetProperty(ref _rejectionMessage, value))
            {
                OnPropertyChanged(nameof(HasRejection));
            }
        }
    }

    /// <summary>Drives Visibility bindings in the window (no null-check
    /// converter needed) — true only when a run's whole FILE was
    /// rejected (see class doc comment on why this is surfaced at all).</summary>
    public bool HasRejection => !string.IsNullOrEmpty(RejectionMessage);

    public FaxRunSummary? Summary
    {
        get => _summary;
        private set => SetProperty(ref _summary, value);
    }

    /// <summary>Per-row results — filled in once RunAsync returns (empty
    /// during Sending; FaxRunOrchestrator.RunAsync has no progress
    /// callback to report rows incrementally, and this brief is explicit
    /// about reusing it as-is with no new abstraction).</summary>
    public ObservableCollection<FaxRunRowSummary> Rows { get; }

    public ICommand SendCommand { get; }

    public ICommand RetryCommand { get; }

    /// <summary>Called by FaxSendWindow's code-behind right after
    /// OpenFileDialog returns a path. Re-picking a file after a run has
    /// completed (or failed) clears the previous run's results, exactly
    /// like starting over.</summary>
    public void SetChosenFile(string path)
    {
        if (State == FaxSendState.Sending) return; // Choose file is disabled during Sending anyway — defence in depth.

        FilePath = path;
        OnPropertyChanged(nameof(FileName));
        Rows.Clear();
        Summary = null;
        RejectionMessage = null;
        StatusMessage = null;
        State = FaxSendState.FileChosen;
    }

    /// <summary>The Send button's handler — public (rather than private,
    /// wrapped only in SendCommand) so tests can await it directly instead
    /// of polling an async-void ICommand.Execute, same convention as this
    /// codebase's other ViewModels' *Async methods (e.g.
    /// PhysiciansViewModel.LoadAsync).</summary>
    public async Task SendAsync()
    {
        if (string.IsNullOrWhiteSpace(FilePath)) return;

        State = FaxSendState.Sending;
        Rows.Clear();
        Summary = null;
        RejectionMessage = null;
        StatusMessage = "Sending…";

        FaxRunSummary? summary;
        try
        {
            summary = await _orchestrator.RunAsync(FilePath, _settings.Fax);
        }
        catch (System.Exception ex)
        {
            AppFileLog.LogException("FaxSendViewModel.SendAsync", ex);
            StatusMessage = $"Couldn't process that file: {ex.Message}";
            // Back to FileChosen (not NoFile) — the file is still picked,
            // Will can just press Send again after fixing whatever broke.
            State = FaxSendState.FileChosen;
            return;
        }

        if (summary is null)
        {
            // A run was already in progress — see FaxRunOrchestrator.RunAsync.
            StatusMessage = "A run is already in progress. Try again in a moment.";
            State = FaxSendState.FileChosen;
            return;
        }

        Summary = summary;
        foreach (var row in summary.Rows)
        {
            Rows.Add(row);
        }

        if (summary.RejectedFiles.Count > 0)
        {
            RejectionMessage = string.Join(" ", summary.RejectedFiles);
        }

        StatusMessage = $"{summary.Sent} sent, {summary.Failed} failed, {summary.SkippedNoFax} skipped (no prescriber fax)";
        State = FaxSendState.Done;
    }

    /// <summary>Public for the same test-await reason as SendAsync above.</summary>
    public async Task RetryAsync(FaxRunRowSummary? row)
    {
        if (row is null) return;

        var succeeded = await _orchestrator.RetryFailedAsync(row.LedgerEntryId, _settings.Fax);
        if (succeeded)
        {
            row.Status = nameof(FaxLedgerStatus.InProcess);
            row.Error = null;
            StatusMessage = $"Requeued fax for {row.PatientInitials}.";
        }
        else
        {
            StatusMessage = $"Retry failed for {row.PatientInitials} — no fax number on file for this entry.";
        }

        // Rebuild the row so the DataGrid (bound to Rows, not directly to
        // Summary.Rows) picks up the mutated Status/Error — same
        // FaxRunRowSummary-is-a-plain-mutable-class reasoning as
        // FaxRunSummaryViewModel's own RetryAsync had.
        var index = Rows.IndexOf(row);
        if (index >= 0)
        {
            Rows[index] = row;
        }
    }
}
