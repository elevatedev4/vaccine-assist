using System.Windows.Threading;
using VaccineAssist.Desktop.Logging;

namespace VaccineAssist.Desktop.Fax;

/// <summary>
/// WPF-adjacent wiring around FaxRunOrchestrator's receipt poller (V-T65,
/// 2026-09-29 — replaces the old daily-timer/"Run now" scheduler: "Get rid
/// of all the shit ... the automatic pulling and folder ... One file
/// selector, then send faxes"). Sending is now a direct, one-shot user
/// action (tray icon -> Views/FaxSendWindow.xaml's file picker + explicit
/// Send button — see MainWindow.xaml.cs's ShowFaxSendWindow), so the only
/// thing left to own on a recurring timer
/// is the background receipt poll that updates Sent/Failed status after a
/// run. Same "MainWindow constructs it once, Start() on Loaded, Dispose()
/// on Closed" lifetime as TrayIconController/PioneerOverlayController (see
/// MainWindow.xaml.cs).
/// </summary>
public sealed class FaxRunScheduler : IDisposable
{
    private readonly FaxRunOrchestrator _orchestrator;
    private readonly DispatcherTimer _receiptPollTimer;

    public FaxRunScheduler(FaxRunOrchestrator orchestrator)
        : this(orchestrator, TimeSpan.FromSeconds(15))
    {
    }

    /// <summary>V-T65 R5 (Will, verbatim, 2026-09-29: "it still shows
    /// status 'InProcess' in the app. Need to make sure this stuff
    /// updates."): shrunk from 10 minutes to 15 seconds — FaxReceiptPoller
    /// no longer checks every pending entry on every tick; each entry's own
    /// check cadence is gated by FaxPollSchedule (15s/60s/give-up-after-2h),
    /// so ticking this timer faster just means a fax that resolves quickly
    /// shows that in the app within ~15s instead of up to 10 minutes later,
    /// without hammering Notifyre for faxes still genuinely in flight.
    /// Also the injectable interval seam for tests.</summary>
    public FaxRunScheduler(FaxRunOrchestrator orchestrator, TimeSpan receiptPollInterval)
    {
        _orchestrator = orchestrator;

        _receiptPollTimer = new DispatcherTimer { Interval = receiptPollInterval };
        _receiptPollTimer.Tick += async (_, _) => await SafeAsync(() => _orchestrator.PollReceiptsOnlyAsync(), "FaxRunScheduler.ReceiptPoll");
    }

    public void Start()
    {
        _receiptPollTimer.Start();
    }

    private static async Task SafeAsync(Func<Task> action, string context)
    {
        try
        {
            await action();
        }
        catch (Exception ex)
        {
            // Same backstop posture as AsyncRelayCommand.Execute — a
            // DispatcherTimer.Tick handler is necessarily async void;
            // an unhandled exception here would otherwise take down the
            // whole app via DispatcherUnhandledException with no clean
            // recovery for "just this one timer."
            AppFileLog.LogException(context, ex);
        }
    }

    public void Dispose()
    {
        _receiptPollTimer.Stop();
    }
}
