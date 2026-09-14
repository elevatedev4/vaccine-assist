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
    /// True when <paramref name="issuedAtUtc"/> is neither in the future
    /// (clamped to false rather than "valid forever" — a clock rollback
    /// shouldn't grant an even-longer session) nor more than
    /// <see cref="MaxAgeDays"/> old as of <paramref name="nowUtc"/>.
    /// </summary>
    public static bool IsValid(DateTime issuedAtUtc, DateTime nowUtc)
    {
        var age = nowUtc - issuedAtUtc;
        return age >= TimeSpan.Zero && age < TimeSpan.FromDays(MaxAgeDays);
    }
}
