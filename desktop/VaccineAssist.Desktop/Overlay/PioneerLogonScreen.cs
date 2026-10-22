using System;

namespace VaccineAssist.Desktop.Overlay;

/// <summary>
/// PioneerRx's sign-in screen (Will, 2026-10-22: "Hide the overlay when the log
/// in screen is visible. The window title contains 'Logon to PioneerRx'").
/// The overlay must not sit on top of it. Pure title test; the window scan is
/// PioneerMainWindowLocator.IsLogonScreenVisible.
/// </summary>
public static class PioneerLogonScreen
{
    public const string TitleMarker = "Logon to PioneerRx";

    /// <summary>True when the window title contains the sign-in marker (case-insensitive). Null/empty is false.</summary>
    public static bool IsLogonTitle(string? title) =>
        !string.IsNullOrEmpty(title) && title.Contains(TitleMarker, StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// Processes whose windows can carry that title without being PioneerRx's
    /// sign-in (a browser tab or an e-mail reading about it), plus this app's
    /// own windows. Compared without ".exe", case-insensitively.
    /// </summary>
    public static readonly string[] ExcludedProcessNames =
    {
        "chrome", "msedge", "firefox", "brave", "opera", "iexplore", "outlook", "VaccineAssist.Desktop",
    };

    /// <summary>True when a window owned by this process must not count as the logon screen. A null/empty name (failed lookup) is not excluded.</summary>
    public static bool IsExcludedProcess(string? processName)
    {
        if (string.IsNullOrWhiteSpace(processName)) return false;
        var name = processName.Trim();
        if (name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) name = name[..^4];
        foreach (var excluded in ExcludedProcessNames)
        {
            if (string.Equals(name, excluded, StringComparison.OrdinalIgnoreCase)) return true;
        }

        return false;
    }
}
