using System.Collections.ObjectModel;
using System.IO;
using System.Windows.Input;
using System.Windows.Threading;
using VaccineAssist.Desktop.Common;
using VaccineAssist.Desktop.Fax;
using VaccineAssist.Desktop.Logging;
using VaccineAssist.Desktop.Settings;
using VaccineAssist.Desktop.ViewModels;

namespace VaccineAssist.Desktop.Services;

/// <summary>
/// Owns the fax-send queue + status refresh for the WHOLE app session —
/// V-T65 R5 (Will, verbatim, 2026-09-29): "allow the app to work from the
/// background to send faxes since it may take some time" / a fax showing
/// stuck "InProcess" after it had actually gone through. Constructed ONCE
/// in App.xaml.cs alongside FaxRunOrchestrator/FaxRunScheduler and handed
/// to MainWindow, which passes the SAME instance into every
/// FaxSendViewModel it builds (see MainWindow.xaml.cs's ShowFaxSendWindow)
/// — closing Views/FaxSendWindow.xaml does not cancel a send or stop
/// polling, and reopening it re-binds to whatever this coordinator is
/// already doing.
///
/// FaxSendViewModel used to own all of this directly (V-T65 R4); it's now
/// a thin pass-through over an instance of this class so the window/tests
/// keep the exact same public surface while the actual state lives here.
///
/// SendAsync itself still calls FaxRunOrchestrator.RunAsync exactly like
/// before (no new send pipeline) — what's new is _refreshTimer, which
/// re-reads the (already-existing) fax ledger every few seconds while
/// anything is Queued/InProcess and updates Rows in place, so the window
/// reflects FaxRunScheduler's background FaxReceiptPoller ticks instead of
/// showing a one-time snapshot frozen at the moment Send returned.
/// </summary>
public sealed class FaxSendCoordinator : ObservableObject
{
    /// <summary>How often to re-read the local ledger.json and refresh
    /// Rows while anything is non-terminal — a cheap file read, NOT a
    /// Notifyre call (FaxRunScheduler/FaxReceiptPoller own the actual
    /// network polling cadence — see FaxPollSchedule). Short enough that
    /// the UI catches up quickly after FaxRunScheduler's own 15s tick
    /// updates the ledger.</summary>
    private static readonly TimeSpan RefreshInterval = TimeSpan.FromSeconds(5);

    private readonly FaxRunOrchestrator _orchestrator;
    private readonly AppSettings _settings;
    private readonly IFaxLedger _ledger;
    private readonly IFaxRunHistoryStore _historyStore;
    private readonly DispatcherTimer _refreshTimer;

    private FaxSendState _state = FaxSendState.NoFile;
    private string? _filePath;
    private string? _statusMessage;
    private string? _rejectionMessage;
    private string? _alreadySentMessage;
    private FaxRunSummary? _summary;
    private int _lastInProcessCount;

    public FaxSendCoordinator(
        FaxRunOrchestrator orchestrator,
        AppSettings settings,
        IFaxLedger ledger,
        IFaxRunHistoryStore historyStore)
    {
        _orchestrator = orchestrator;
        _settings = settings;
        _ledger = ledger;
        _historyStore = historyStore;

        Rows = new ObservableCollection<FaxRunRowSummary>();
        History = new ObservableCollection<FaxRunSummary>();
        SendCommand = new AsyncRelayCommand(SendAsync, () => State == FaxSendState.FileChosen);
        RetryCommand = new AsyncRelayCommand<FaxRunRowSummary>(RetryAsync, row =>
            row is not null && string.Equals(row.Status, nameof(FaxLedgerStatus.Failed), StringComparison.OrdinalIgnoreCase));

        _refreshTimer = new DispatcherTimer { Interval = RefreshInterval };
        _refreshTimer.Tick += (_, _) => RefreshRowsFromLedger();

        LoadHistory();
    }

    /// <summary>Raised whenever InProcessCount changes — TrayIconController
    /// subscribes to update the tray tooltip ("Faxes: N in process") while
    /// anything is in flight, regardless of whether FaxSendWindow is
    /// currently open.</summary>
    public event EventHandler? InProcessCountChanged;

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

    public string? FilePath
    {
        get => _filePath;
        private set => SetProperty(ref _filePath, value);
    }

    public string? FileName => string.IsNullOrEmpty(FilePath) ? null : Path.GetFileName(FilePath);

    public bool CanChooseFile => State != FaxSendState.Sending;

    public bool IsSending => State == FaxSendState.Sending;

    public string? StatusMessage
    {
        get => _statusMessage;
        private set => SetProperty(ref _statusMessage, value);
    }

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

    public bool HasRejection => !string.IsNullOrEmpty(RejectionMessage);

    /// <summary>V-T65 R5: set instead of a normal run when the picked file
    /// (by SHA-256, see FaxFileLedger) was already fully sent — see
    /// FaxRunSummary.AlreadySentMessage's own doc comment.</summary>
    public string? AlreadySentMessage
    {
        get => _alreadySentMessage;
        private set
        {
            if (SetProperty(ref _alreadySentMessage, value))
            {
                OnPropertyChanged(nameof(HasAlreadySentMessage));
            }
        }
    }

    public bool HasAlreadySentMessage => !string.IsNullOrEmpty(AlreadySentMessage);

    public FaxRunSummary? Summary
    {
        get => _summary;
        private set => SetProperty(ref _summary, value);
    }

    /// <summary>V-T65 R5 (Will, verbatim: "the summary should show number
    /// in process and then when it is done show the result") — computed
    /// live from Rows, not from Summary's frozen counts. See
    /// FaxSendSummaryLine's own doc comment.</summary>
    public string SummaryLine => FaxSendSummaryLine.Compute(Rows);

    /// <summary>How many current rows are still Queued/InProcess — drives
    /// the tray tooltip via InProcessCountChanged.</summary>
    public int InProcessCount => Rows.Count(r =>
        r.Status == nameof(FaxLedgerStatus.InProcess) || r.Status == nameof(FaxLedgerStatus.Queued));

    public ObservableCollection<FaxRunRowSummary> Rows { get; }

    /// <summary>V-T65 R5's Send History section — past batches read back
    /// from fax\runs\*.json (FaxRunHistoryStore), newest first. Reloaded
    /// after every SendAsync/RetryAsync so a just-finished run shows up
    /// immediately without reopening the window.</summary>
    public ObservableCollection<FaxRunSummary> History { get; }

    public ICommand SendCommand { get; }

    public ICommand RetryCommand { get; }

    public void SetChosenFile(string path)
    {
        if (State == FaxSendState.Sending) return;

        FilePath = path;
        OnPropertyChanged(nameof(FileName));
        Rows.Clear();
        Summary = null;
        RejectionMessage = null;
        AlreadySentMessage = null;
        StatusMessage = null;
        State = FaxSendState.FileChosen;
        StopRefreshIfIdle();
    }

    public async Task SendAsync()
    {
        if (string.IsNullOrWhiteSpace(FilePath)) return;

        State = FaxSendState.Sending;
        Rows.Clear();
        Summary = null;
        RejectionMessage = null;
        AlreadySentMessage = null;
        StatusMessage = "Sending…";

        FaxRunSummary? summary;
        try
        {
            summary = await _orchestrator.RunAsync(FilePath, _settings.Fax);
        }
        catch (Exception ex)
        {
            AppFileLog.LogException("FaxSendCoordinator.SendAsync", ex);
            StatusMessage = $"Couldn't process that file: {ex.Message}";
            State = FaxSendState.FileChosen;
            return;
        }

        if (summary is null)
        {
            StatusMessage = "A run is already in progress. Try again in a moment.";
            State = FaxSendState.FileChosen;
            return;
        }

        Summary = summary;

        if (!string.IsNullOrEmpty(summary.AlreadySentMessage))
        {
            AlreadySentMessage = summary.AlreadySentMessage;
            StatusMessage = null;
            State = FaxSendState.Done;
            LoadHistory();
            return;
        }

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
        OnPropertyChanged(nameof(SummaryLine));
        LoadHistory();
        UpdateInProcessCountAndTimer();
    }

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

        var index = Rows.IndexOf(row);
        if (index >= 0)
        {
            Rows[index] = row;
        }

        OnPropertyChanged(nameof(SummaryLine));
        UpdateInProcessCountAndTimer();
    }

    /// <summary>Forces an immediate ledger re-read/Rows refresh instead of
    /// waiting for the next timer tick — the timer's own handler just calls
    /// this. Public so tests (and, if ever needed, a manual "Refresh"
    /// action) can trigger it deterministically instead of sleeping past a
    /// real DispatcherTimer interval.</summary>
    public void RefreshNow() => RefreshRowsFromLedger();

    /// <summary>Re-reads ledger.json (cheap local file, not a Notifyre
    /// call) and updates any row whose LedgerEntryId's Status/Error has
    /// changed since the last refresh — this is what makes a fax that
    /// FaxRunScheduler's background poll resolved to Sent/Failed show that
    /// in the window without Will having to close and reopen it. Rows with
    /// no LedgerEntryId (a "Skipped (no prescriber fax)" or "Skipped —
    /// already sent" row) are never fax entries and are left alone.</summary>
    private void RefreshRowsFromLedger()
    {
        if (Rows.Count == 0)
        {
            _refreshTimer.Stop();
            return;
        }

        var entries = _ledger.Load().ToDictionary(e => e.Id, e => e);
        var anyRowChanged = false;

        // Index-based (not foreach) deliberately — the body below replaces
        // items in Rows in place (Rows[i] = row), and mutating an
        // ObservableCollection while a foreach enumerator over it is live
        // is exactly the kind of thing that's safest never to rely on.
        for (var i = 0; i < Rows.Count; i++)
        {
            var row = Rows[i];
            if (string.IsNullOrEmpty(row.LedgerEntryId)) continue;
            if (!entries.TryGetValue(row.LedgerEntryId, out var entry)) continue;

            var newStatus = entry.Status.ToString();
            if (row.Status == newStatus && row.Error == entry.Error) continue;

            row.Status = newStatus;
            row.Error = entry.Error;
            // Same "replace in place" trick RetryAsync already uses —
            // FaxRunRowSummary isn't INotifyPropertyChanged, so the
            // DataGrid only re-reads a row's cells on a CollectionChanged
            // Replace notification, not on a plain field mutation.
            Rows[i] = row;
            anyRowChanged = true;
        }

        if (anyRowChanged)
        {
            OnPropertyChanged(nameof(SummaryLine));
        }

        UpdateInProcessCountAndTimer();
    }

    private void UpdateInProcessCountAndTimer()
    {
        var current = InProcessCount;
        if (current != _lastInProcessCount)
        {
            _lastInProcessCount = current;
            InProcessCountChanged?.Invoke(this, EventArgs.Empty);
        }

        if (current > 0)
        {
            _refreshTimer.Start();
        }
        else
        {
            StopRefreshIfIdle();
        }
    }

    private void StopRefreshIfIdle()
    {
        if (InProcessCount == 0)
        {
            _refreshTimer.Stop();
        }
    }

    private void LoadHistory()
    {
        try
        {
            var recent = _historyStore.LoadRecent();
            History.Clear();
            foreach (var item in recent)
            {
                History.Add(item);
            }
        }
        catch (Exception ex)
        {
            AppFileLog.LogException("FaxSendCoordinator.LoadHistory", ex);
        }
    }
}
