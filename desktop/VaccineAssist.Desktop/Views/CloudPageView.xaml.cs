using System;
using System.Diagnostics;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Navigation;
using VaccineAssist.Desktop.Logging;
using VaccineAssist.Desktop.Services;

namespace VaccineAssist.Desktop.Views;

/// <summary>
/// Hosts one cloud-app page inside a desktop tab — see this control's
/// XAML doc comment for the full brief context. MainWindow.xaml.cs
/// constructs one instance per tab the first time that tab is selected
/// (lazy — a fresh workstation shouldn't spin up five WebView2 browser
/// processes at launch just because Will's primary ask is "minimize it
/// immediately and drive it with hotkeys," which never touches these
/// tabs at all) and never rebuilds it after that first load.
/// </summary>
public partial class CloudPageView : UserControl
{
    private readonly string _url;
    private bool _initialized;

    /// <param name="cloudApiBaseUrl">AppSettings.CloudApiBaseUrl, e.g. https://vaccine-assist.vercel.app.</param>
    /// <param name="relativePath">The cloud route to load, e.g. "/lots" — see cloud/app's actual route folders (not every tab name matches 1:1; "Scheduling" is cloud's /appointments, for example).</param>
    public CloudPageView(string cloudApiBaseUrl, string relativePath)
    {
        InitializeComponent();
        _url = BuildUrl(cloudApiBaseUrl, relativePath);
        Loaded += CloudPageView_OnLoaded;
    }

    private static string BuildUrl(string cloudApiBaseUrl, string relativePath)
    {
        var baseUrl = (cloudApiBaseUrl ?? "").TrimEnd('/');
        return $"{baseUrl}{relativePath}";
    }

    /// <summary>
    /// Loaded can fire more than once for a UserControl (e.g. if it's ever
    /// removed and re-added to the visual tree) — _initialized guards
    /// against re-running EnsureCoreWebView2Async/Navigate on a control
    /// that already has a live WebView2, which MainWindow's lazy
    /// "only build this once, on first tab selection" pattern doesn't
    /// currently do but this guard is cheap insurance against regressing
    /// that into a double-init.
    /// </summary>
    private async void CloudPageView_OnLoaded(object sender, RoutedEventArgs e)
    {
        if (_initialized)
        {
            return;
        }
        _initialized = true;

        await InitializeWebViewAsync();
    }

    private async System.Threading.Tasks.Task InitializeWebViewAsync()
    {
        try
        {
            WebView.Visibility = Visibility.Visible;
            FailurePanel.Visibility = Visibility.Collapsed;

            var environment = await SharedCloudWebView2Environment.GetAsync();
            await WebView.EnsureCoreWebView2Async(environment);
            WebView.CoreWebView2.Navigate(_url);
        }
        catch (Exception ex)
        {
            AppFileLog.LogException("CloudPageView.WebView2Init", ex);
            ShowInitFailure(ex);
        }
    }

    private void ShowInitFailure(Exception ex)
    {
        WebView.Visibility = Visibility.Collapsed;
        FailurePanel.Visibility = Visibility.Visible;
        FailureDetailTextBlock.Text = $"{ex.GetType().Name}: {ex.Message}";
    }

    /// <summary>Lets staff retry without restarting the whole app — unlike
    /// MacroCodesWindow (a one-shot popup that's simply reopened via the
    /// hotkey), this control is a long-lived tab.</summary>
    private async void RetryButton_OnClick(object sender, RoutedEventArgs e)
    {
        _initialized = true; // Loaded already ran once; this bypasses it entirely
        await InitializeWebViewAsync();
    }

    private void DownloadLink_OnRequestNavigate(object sender, RequestNavigateEventArgs e)
    {
        try
        {
            Process.Start(new ProcessStartInfo(e.Uri.AbsoluteUri) { UseShellExecute = true });
        }
        catch (Exception ex)
        {
            AppFileLog.LogException("CloudPageView.OpenDownloadLink", ex);
        }
        e.Handled = true;
    }
}
