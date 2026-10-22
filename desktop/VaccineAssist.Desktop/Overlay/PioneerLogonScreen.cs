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
}
