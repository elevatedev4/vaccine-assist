using System.Windows.Threading;
using VaccineAssist.Desktop.Logging;

namespace VaccineAssist.Desktop.Fax;

/// <summary>
/// WPF-adjacent wiring around FaxRunOrchestrator's receipt poller (V-T65,
/// 2026-09-29 — replaces the old daily-timer/"Run now" scheduler: "Get rid
/// of all the shit ... the automatic pulling and folder ... One file
/// selector, then send faxes"). Sending is now a direct, one-shot user
/// action (tray icon -> file picker -> immediately process + send — see
/// MainWindow.xaml.cs), so the only thing left to own on a recurring timer
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
        : this(orchestrator, TimeSpan.FromMinutes(10))
    {
    }

    /// <summary>Injectable interval seam for tests that need a shorter
    /// tick than production's real 10-minute cadence.</summary>
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
