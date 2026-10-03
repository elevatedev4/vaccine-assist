using System;

namespace VaccineAssist.Desktop.Settings;

/// <summary>
/// Pure 90-day expiry math split out of LoginViewModel so it's
/// unit-testable without any WPF/Supabase/IO/DPAPI dependencies — same
/// reasoning as AutoLoginDecision.cs. Will, 2026-09-13 (verbatim): "you
/// should make that last for 90 days without requiring a login again,
/// even if the program is restarted of course."
/// </summary>
public static class SessionExpiry
{
    /// <summary>How long a persisted session (from the last INTERACTIVE
    /// sign-in) stays valid before the app falls back to autologin.json,
    /// then the manual Login window.</summary>
    public const int MaxAgeDays = 90;

    /// <summary>
    /// False ONLY when the session is <see cref="MaxAgeDays"/> or more old
    /// as of <paramref name="nowUtc"/>. A negative age (issuedAtUtc is in
    /// the future — the workstation clock was stepped back, e.g. a CMOS
    /// battery reset or a bad NTP sync) is tolerated and counts as age
    /// zero: deleting a good 90-day session over clock skew is exactly
    /// the sign-in this feature exists to prevent. SessionKeeper clamps
    /// the stored anchor to "now" in that case, so a rolled-back clock can
    /// never stretch the ceiling past 90 days from when it was noticed.
    /// </summary>
    public static bool IsValid(DateTime issuedAtUtc, DateTime nowUtc)
    {
        var age = nowUtc - issuedAtUtc;
        return age < TimeSpan.FromDays(MaxAgeDays);
    }
}
