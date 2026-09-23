using System.Windows.Threading;
using VaccineAssist.Desktop.Logging;
using VaccineAssist.Desktop.Settings;

namespace VaccineAssist.Desktop.Fax;

/// <summary>
/// WPF-adjacent wiring around FaxRunOrchestrator — Will's brief: "an
/// in-app timer fires at a configured local time (default 18:30) once
/// per day, plus tray menu 'Vaccine faxes -> Run now'." Owns two
/// DispatcherTimers for the whole signed-in session, same "MainWindow
/// constructs it once, Start() on Loaded, Dispose() on Closed" lifetime
/// as TrayIconController/PioneerOverlayController (see MainWindow.xaml.cs).
/// </summary>
public sealed class FaxRunScheduler : IDisposable
{
    private readonly FaxRunOrchestrator _orchestrator;
    private readonly Func<AppSettings> _settingsProvider;
    private readonly IFaxRunMarker _runMarker;
    private readonly DispatcherTimer _dailyCheckTimer;
    private readonly DispatcherTimer _receiptPollTimer;

    /// <summary>Raised on the UI thread whenever a run (scheduled or
    /// manual) actually executed — MainWindow shows FaxRunSummaryWindow
    /// and a tray balloon from this.</summary>
    public event EventHandler<FaxRunSummary>? RunCompleted;

    public FaxRunScheduler(FaxRunOrchestrator orchestrator, Func<AppSettings> settingsProvider, IFaxRunMarker runMarker)
        : this(orchestrator, settingsProvider, runMarker, TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(10))
    {
    }

    /// <summary>Injectable interval seam for tests that need a shorter
    /// tick than production's real 1-minute/10-minute cadence.</summary>
    public FaxRunScheduler(
        FaxRunOrchestrator orchestrator,
        Func<AppSettings> settingsProvider,
        IFaxRunMarker runMarker,
        TimeSpan dailyCheckInterval,
        TimeSpan receiptPollInterval)
    {
        _orchestrator = orchestrator;
        _settingsProvider = settingsProvider;
        _runMarker = runMarker;

        _dailyCheckTimer = new DispatcherTimer { Interval = dailyCheckInterval };
        _dailyCheckTimer.Tick += async (_, _) => await SafeAsync(CheckDailyRunAsync, "FaxRunScheduler.CheckDailyRun");

        _receiptPollTimer = new DispatcherTimer { Interval = receiptPollInterval };
        _receiptPollTimer.Tick += async (_, _) => await SafeAsync(() => _orchestrator.PollReceiptsOnlyAsync(), "FaxRunScheduler.ReceiptPoll");
    }

    public void Start()
    {
        _dailyCheckTimer.Start();
        _receiptPollTimer.Start();
    }

    /// <summary>Tray menu's "Vaccine faxes -> Run now" — always works
    /// regardless of FaxSettings.DailyRunEnabled, per the brief.</summary>
    public async Task RunNowAsync()
    {
        await SafeAsync(RunAndRecordAsync, "FaxRunScheduler.RunNow");
    }

    private async Task CheckDailyRunAsync()
    {
        var settings = _settingsProvider();
        if (!settings.Fax.DailyRunEnabled) return;

        var runTime = FaxScheduleDecision.ParseRunTime(settings.Fax.DailyRunTime);
        var lastRun = _runMarker.LoadLastRunLocalDate();
        if (!FaxScheduleDecision.ShouldRunNow(runTime, lastRun, DateTime.Now)) return;

        await RunAndRecordAsync();
    }

    private async Task RunAndRecordAsync()
    {
        var settings = _settingsProvider();
        var summary = await _orchestrator.RunAsync(settings.Fax);
        if (summary is null) return; // already running — see FaxRunOrchestrator.RunAsync

        _runMarker.SaveLastRunLocalDate(DateOnly.FromDateTime(DateTime.Now));
        RunCompleted?.Invoke(this, summary);
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
        _dailyCheckTimer.Stop();
        _receiptPollTimer.Stop();
    }
}
