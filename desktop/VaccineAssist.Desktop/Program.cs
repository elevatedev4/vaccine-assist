using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading;
using System.Windows;
using VaccineAssist.Desktop.Logging;
using VaccineAssist.Desktop.Startup;
using VaccineAssist.Desktop.Versioning;

namespace VaccineAssist.Desktop;

/// <summary>
/// Explicit entry point, replacing the WPF SDK's auto-generated Main().
///
/// HOW THE GENERATED Main() WAS REPLACED: App.xaml's Build Action stays
/// "ApplicationDefinition" (so the XAML compiler still generates
/// App.InitializeComponent() from App.xaml — merged resource dictionaries,
/// etc. — and still honors x:Class="VaccineAssist.Desktop.App"). What the
/// XAML compiler normally ALSO generates is a `static void Main()` on the
/// same partial App class, wrapped by the WPF build targets in
/// `#if !DISABLE_XAML_GENERATED_MAIN`. VaccineAssist.Desktop.csproj now
/// defines that symbol (see its DefineConstants), which suppresses that
/// generated Main() — this is Microsoft's own documented mechanism for
/// supplying a custom entry point in a WPF app (the pattern Velopack's own
/// docs recommend for exactly this reason), NOT a hack. This Program.cs
/// then does by hand exactly what the generated Main() used to do
/// (`new App(); app.InitializeComponent(); app.Run();`), with the
/// Velopack bootstrap and single-instance mutex added in front of it.
///
/// App.xaml's StartupUri was already removed before this change (see that
/// file's own comment) — App.xaml.cs's OnStartup builds the composition
/// root by hand, so InitializeComponent() here does not auto-show a
/// window; it only wires up resources the same way it always did.
/// </summary>
internal static class Program
{
    /// <summary>Same mutex name/scope as rx-verify's overlay (see the
    /// installer plan) — "Global\" makes this per-machine (not just
    /// per-session), so an installed build and the old
    /// update-and-run.ps1 + shortcut checkout can never run at the same
    /// time on one PC. Will's hard requirement (G-Q5): "It is vital that
    /// the vaccine app is not interrupted" — this mutex is what prevents
    /// two copies from fighting over the same tray icon/hotkeys/fax
    /// scheduler.</summary>
    private const string SingleInstanceMutexName = "Global\\VaccineAssistDesktop-SingleInstance";

    [STAThread]
    private static void Main()
    {
        // MUST be the very first line (Velopack's own documented
        // requirement) — handles Velopack's install/update/uninstall
        // lifecycle hooks when this process was launched BY Velopack for
        // one of those events, then returns immediately for a normal
        // launch. Safe to call unconditionally, including when this build
        // was never installed by Setup.exe at all (dotnet build/publish +
        // update-and-run.ps1 + the existing desktop shortcut): Velopack
        // detects "not installed" internally and no-ops rather than
        // throwing. See VelopackUpdater.cs for the SEPARATE gate
        // (UpdateManager.IsInstalled) that keeps the actual update
        // check/download/apply calls out of that same unpackaged path.
        Velopack.VelopackApp.Build().Run();

        AppFileLog.Log($"[Startup] process start: pid {Environment.ProcessId}, build {BuildInfo.Current.Describe()}, {SinceProcessStartMs()} ms since process creation");

        using var singleInstanceMutex = new Mutex(
            initiallyOwned: true, name: SingleInstanceMutexName, out var createdNew);

        AppFileLog.Log(createdNew
            ? "[Startup] single-instance mutex: acquired"
            : "[Startup] single-instance mutex: held by another instance");

        if (!createdNew && !TryTakeOverFromExistingInstance(singleInstanceMutex))
        {
            AppFileLog.Log("[Startup] exiting: another instance keeps running");
            return;
        }

        var app = new App();
        app.InitializeComponent();

        // A second launch asks this instance to come to the front; the
        // answer comes from the UI thread, which is how a frozen instance
        // is told apart from a healthy one (see SingleInstancePolicy).
        using var activationListener = ActivationListener.TryStart(
            post => app.Dispatcher.BeginInvoke(post),
            app.ActivateFromAnotherLaunch);

        AppFileLog.Log($"[Startup] app.Run begins (+{SinceProcessStartMs()} ms since process start)");
        app.Run();

        // Explicit release on a clean shutdown (version switch / Exit) so a
        // relaunching copy never races a lingering handle. Best-effort: if
        // this thread somehow doesn't own it, process exit releases it anyway.
        try
        {
            singleInstanceMutex.ReleaseMutex();
        }
        catch (ApplicationException)
        {
        }
        catch (ObjectDisposedException)
        {
        }
    }

    /// <summary>Milliseconds since this process was created (log lines for startup timing); -1 when unknown.</summary>
    internal static long SinceProcessStartMs()
    {
        try
        {
            using var me = Process.GetCurrentProcess();
            return (long)(DateTime.Now - me.StartTime).TotalMilliseconds;
        }
        catch (Exception)
        {
            return -1;
        }
    }

    /// <summary>
    /// This launch did not get the mutex. A healthy instance is told to come
    /// to the front (as before: this launch exits). A frozen one holds the
    /// mutex forever, so after a Yes the frozen process(es) of this user and
    /// session are ended and the mutex is taken. True = the mutex is ours.
    /// Every step is logged.
    /// </summary>
    private static bool TryTakeOverFromExistingInstance(Mutex mutex)
    {
        try
        {
            var acknowledged = InstanceSignals.TrySignalExisting(TimeSpan.FromSeconds(3));
            AppFileLog.Log($"[Startup] activation signal acknowledged by the running instance: {acknowledged}");

            var others = new List<OtherInstance>();
            var processes = new List<Process>();
            if (!acknowledged)
            {
                others = SingleInstanceProbe.Probe(out processes);
                foreach (var other in others)
                {
                    AppFileLog.Log($"[Startup] other instance pid {other.ProcessId}: {other.Health}, may close: {other.Killable}");
                }
            }

            var decision = SingleInstancePolicy.Decide(false, acknowledged, others);
            AppFileLog.Log($"[Startup] single-instance decision: {decision}");

            switch (decision)
            {
                case SingleInstanceDecision.ActivatedExisting:
                    return false;

                case SingleInstanceDecision.OfferRecovery:
                    return OfferRecoveryAndTakeOver(mutex, others, processes);

                default:
                    MessageBox.Show(
                        "Vaccine Assist is already running",
                        "Vaccine Assist",
                        MessageBoxButton.OK,
                        MessageBoxImage.Information);
                    return false;
            }
        }
        catch (Exception ex)
        {
            AppFileLog.LogException("Program.TryTakeOverFromExistingInstance", ex);
            return false;
        }
    }

    private static bool OfferRecoveryAndTakeOver(Mutex mutex, List<OtherInstance> others, List<Process> processes)
    {
        var yes = VersionDialogs.Confirm(
            "Vaccine Assist is already open but not responding. Close it and start again?",
            VersionDialogs.Caption);
        AppFileLog.Log($"[Startup] frozen-instance prompt answered: {(yes ? "Yes" : "No")}");
        if (!yes)
        {
            return false;
        }

        foreach (var process in processes)
        {
            var info = others.Find(o => o.ProcessId == process.Id);
            if (info is null || !SingleInstancePolicy.ShouldEnd(info))
            {
                continue;
            }

            try
            {
                process.Kill();
                var exited = process.WaitForExit(5000);
                AppFileLog.Log($"[Startup] ended frozen instance pid {info.ProcessId}, exited: {exited}");
            }
            catch (Exception ex)
            {
                AppFileLog.LogException($"Program.EndFrozenInstance pid {info.ProcessId}", ex);
            }
        }

        // A killed owner leaves the mutex abandoned: waiting on it hands us ownership.
        var acquired = false;
        try
        {
            acquired = mutex.WaitOne(TimeSpan.FromSeconds(5));
        }
        catch (AbandonedMutexException)
        {
            acquired = true;
        }

        AppFileLog.Log($"[Startup] single-instance mutex after closing the frozen instance: {(acquired ? "acquired" : "still held")}");
        if (!acquired)
        {
            VersionDialogs.ShowNotice(
                "Couldn't close the frozen Vaccine Assist. End VaccineAssist.Desktop.exe in Task Manager, or restart this PC, then try again.");
        }

        return acquired;
    }
}
