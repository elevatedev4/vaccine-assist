using System;
using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Windows.Input;
using VaccineAssist.Desktop.Common;
using VaccineAssist.Desktop.Fax;
using VaccineAssist.Desktop.Services;

namespace VaccineAssist.Desktop.ViewModels;

/// <summary>
/// Backs Views/FaxSendWindow.xaml — V-T65 R4 (Will, verbatim, 2026-09-29):
/// "Tried using my sample report and it didn't send any faxes. I would
/// you to make the menu be called 'Vaccines-Send PCP faxes', have that
/// open a dialogue window where you can selec tht efile then push send
/// then see the results below." One window owns file selection AND
/// results, and nothing sends until Send is explicitly pressed.
///
/// V-T65 R5 (Will, verbatim, 2026-09-29: "allow the app to work from the
/// background to send faxes ... make sure the status is displayed
/// correctly"): this class is now a THIN pass-through over
/// FaxSendCoordinator, a singleton App.xaml.cs constructs once and
/// MainWindow reuses for every FaxSendViewModel it builds (see
/// MainWindow.xaml.cs's ShowFaxSendWindow) — the actual state (Rows,
/// Summary, the send queue, background status polling) lives on the
/// coordinator so it survives FaxSendWindow being closed and reopened.
/// Every property/command here simply forwards to it; PropertyChanged is
/// relayed 1:1 so existing bindings in FaxSendWindow.xaml need no change.
///
/// LEAK FIX (reviewer, V-T65 R5 REQUEST_CHANGES, 2026-09-29): FaxSendCoordinator
/// is a session-long singleton, but MainWindow.ShowFaxSendWindow builds a
/// brand-new FaxSendViewModel on every open — the _openFaxSendWindow guard
/// only stops two windows existing AT ONCE, it does nothing once the
/// window closes. Without unsubscribing, every open/close cycle rooted one
/// more VM (via the coordinator's PropertyChanged invocation list)
/// forever. IDisposable + a field-stored handler (not a lambda, so -=
/// actually removes it) fixes that; MainWindow's FaxSendWindow.Closed
/// handler calls Dispose() alongside its existing _openFaxSendWindow reset.
/// </summary>
public sealed class FaxSendViewModel : ObservableObject, IDisposable
{
    private readonly FaxSendCoordinator _coordinator;
    private readonly PropertyChangedEventHandler _coordinatorPropertyChangedHandler;
    private bool _disposed;

    public FaxSendViewModel(FaxSendCoordinator coordinator)
    {
        _coordinator = coordinator;
        // Stored in a field (not inlined as a lambda passed directly to
        // +=) specifically so Dispose() below has a delegate instance it
        // can pass to -= — an inline lambda can never be unsubscribed,
        // which was exactly the leak.
        _coordinatorPropertyChangedHandler = (_, e) => OnPropertyChanged(e.PropertyName);
        _coordinator.PropertyChanged += _coordinatorPropertyChangedHandler;
    }

    /// <summary>Detaches from the coordinator's PropertyChanged — called
    /// from FaxSendWindow's Closed handler (MainWindow.xaml.cs). The
    /// coordinator itself is untouched (it's the session-long singleton;
    /// only this per-window VM's subscription to it is torn down).
    /// Idempotent — safe to call more than once.</summary>
    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _coordinator.PropertyChanged -= _coordinatorPropertyChangedHandler;
    }

    public FaxSendState State => _coordinator.State;

    /// <summary>Full path of the currently-picked report file, or null
    /// before Will has chosen one — shown read-only in the file-path
    /// box.</summary>
    public string? FilePath => _coordinator.FilePath;

    /// <summary>Just the file name, for the totals/status line — never the
    /// full path (which can carry a Windows profile username).</summary>
    public string? FileName => _coordinator.FileName;

    /// <summary>False while a run is in flight, so "Choose file…" can't
    /// swap the file (or start a second OpenFileDialog) mid-send.</summary>
    public bool CanChooseFile => _coordinator.CanChooseFile;

    public bool IsSending => _coordinator.IsSending;

    public string? StatusMessage => _coordinator.StatusMessage;

    /// <summary>Non-null only when the last run's file was rejected
    /// outright (missing required column, unreadable file, etc.).</summary>
    public string? RejectionMessage => _coordinator.RejectionMessage;

    public bool HasRejection => _coordinator.HasRejection;

    /// <summary>V-T65 R5: non-null when the picked file was already fully
    /// sent (by content hash) — see FaxRunSummary.AlreadySentMessage.</summary>
    public string? AlreadySentMessage => _coordinator.AlreadySentMessage;

    public bool HasAlreadySentMessage => _coordinator.HasAlreadySentMessage;

    /// <summary>V-T65 R5 (Will, verbatim: "the summary should show number
    /// in process and then when it is done show the result") — "N in
    /// process · N sent · N failed" while anything is in flight, "Done: N
    /// sent, N failed" once it isn't.</summary>
    public string SummaryLine => _coordinator.SummaryLine;

    public FaxRunSummary? Summary => _coordinator.Summary;

    /// <summary>Per-row results — live-updated by the coordinator's
    /// background refresh, not just a one-time snapshot from Send.</summary>
    public ObservableCollection<FaxRunRowSummary> Rows => _coordinator.Rows;

    /// <summary>V-T65 R5's Send History section — past batches, newest
    /// first.</summary>
    public ObservableCollection<FaxRunSummary> History => _coordinator.History;

    public ICommand SendCommand => _coordinator.SendCommand;

    public ICommand RetryCommand => _coordinator.RetryCommand;

    /// <summary>Called by FaxSendWindow's code-behind right after
    /// OpenFileDialog returns a path.</summary>
    public void SetChosenFile(string path) => _coordinator.SetChosenFile(path);

    /// <summary>Public (rather than only wrapped in SendCommand) so tests
    /// can await it directly, same convention as this codebase's other
    /// ViewModels' *Async methods.</summary>
    public Task SendAsync() => _coordinator.SendAsync();

    public Task RetryAsync(FaxRunRowSummary? row) => _coordinator.RetryAsync(row);
}
