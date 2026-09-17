namespace VaccineAssist.Desktop.Views;

/// <summary>
/// Pure formatting for CloudPageView.PerformDesktopHandoffAsync's
/// navigation-failure log line (Will's brief, 2026-09-16 — "log the
/// concrete reason when [the late-recovery handoff] fails"). Takes the
/// WebErrorStatus's name and an optional HTTP status as plain values
/// rather than a CoreWebView2NavigationCompletedEventArgs — no WebView2
/// dependency itself, so it's covered by fast xUnit tests without needing
/// a real WebView2 control. Mirrors Uia/PioneerRxPresenceDecision.cs's
/// "pure decision, tested directly" shape (this project has no
/// InternalsVisibleTo, so testable pure logic lives in its own small
/// public class like that one).
/// </summary>
public static class DesktopHandoffFailureDescription
{
    /// <summary>
    /// <paramref name="httpStatusCode"/> is null when the installed
    /// WebView2 Runtime doesn't expose
    /// CoreWebView2NavigationCompletedEventArgs.HttpStatusCode (an older
    /// Evergreen Runtime than this SDK's max API set) or when no
    /// navigation ever completed at all (a hard timeout) — either way, the
    /// WebErrorStatus name alone is still useful in the log.
    /// </summary>
    public static string Describe(string webErrorStatusName, int? httpStatusCode)
        => httpStatusCode is int code
            ? $"WebErrorStatus={webErrorStatusName}, HttpStatusCode={code}"
            : $"WebErrorStatus={webErrorStatusName}";
}
