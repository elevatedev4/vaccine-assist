using System.Globalization;

namespace VaccineAssist.Desktop.Fax;

/// <summary>
/// Pure "should the daily run fire now" logic, split out of
/// FaxRunScheduler so it's unit-testable without a real DispatcherTimer —
/// same reasoning as Settings/SessionExpiry.cs. Will's brief: "an in-app
/// timer fires at a configured local time (default 18:30) once per day."
/// </summary>
public static class FaxScheduleDecision
{
    /// <summary>Parses "HH:mm" (24h). Falls back to 18:30 for anything
    /// unparsable rather than never firing at all.</summary>
    public static TimeOnly ParseRunTime(string? configured)
    {
        if (!string.IsNullOrWhiteSpace(configured) &&
            TimeOnly.TryParseExact(configured, "HH:mm", CultureInfo.InvariantCulture, DateTimeStyles.None, out var parsed))
        {
            return parsed;
        }
        return new TimeOnly(18, 30);
    }

    /// <summary>True when the local clock has reached-or-passed
    /// <paramref name="runTime"/> today AND the daily run hasn't already
    /// completed today (<paramref name="lastRunLocalDate"/> is null or an
    /// earlier date than <paramref name="nowLocal"/>'s date). A clock that
    /// jumps backward (or a workstation left off past the run time, then
    /// turned back on) does not re-fire the SAME day's run twice.</summary>
    public static bool ShouldRunNow(TimeOnly runTime, DateOnly? lastRunLocalDate, DateTime nowLocal)
    {
        var today = DateOnly.FromDateTime(nowLocal);
        if (lastRunLocalDate == today) return false;
        return TimeOnly.FromDateTime(nowLocal) >= runTime;
    }
}
