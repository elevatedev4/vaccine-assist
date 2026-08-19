namespace VaccineAssist.Desktop.Uia;

/// <summary>
/// Pure combination of the two independently-cheap signals
/// PioneerRxPresence checks — no Win32/FlaUI dependency itself, so it's
/// covered by fast xUnit tests (mirrors rx-verify's
/// Integrated/PioneerPresence.cs, same shape).
/// </summary>
public static class PioneerRxPresenceDecision
{
    /// <summary>
    /// True if PioneerRx looks present right now, by either signal:
    /// the CURRENT FOREGROUND window's title starts with one of
    /// PioneerRxTitles.TargetWindowTitlePrefixes
    /// (<paramref name="foregroundTitleMatches"/>), or a PioneerRx
    /// process is simply running somewhere, foreground or not
    /// (<paramref name="processIsRunning"/>).
    /// </summary>
    public static bool IsPresent(bool foregroundTitleMatches, bool processIsRunning)
        => foregroundTitleMatches || processIsRunning;
}
