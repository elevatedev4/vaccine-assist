using System;
using System.Threading;
using System.Windows;

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

        using var singleInstanceMutex = new Mutex(
            initiallyOwned: true, name: SingleInstanceMutexName, out var createdNew);

        if (!createdNew)
        {
            MessageBox.Show(
                "Vaccine Assist is already running",
                "Vaccine Assist",
                MessageBoxButton.OK,
                MessageBoxImage.Information);
            return;
        }

        var app = new App();
        app.InitializeComponent();
        app.Run();
    }
}
