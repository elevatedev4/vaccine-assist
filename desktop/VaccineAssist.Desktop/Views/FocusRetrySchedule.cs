using System;
using System.Collections.Generic;

namespace VaccineAssist.Desktop.Views;

/// <summary>
/// Pure, unit-testable delay schedule for AgePromptWindow's focus-retry
/// loop (V-T41 R6, Will's brief verbatim: "It's only working about half
/// the time right now... may need to refocus after a delayed amount of
/// milliseconds but before the user input starts").
///
/// AgePromptWindow makes one immediate foreground/focus attempt
/// synchronously from Loaded, then — unless that attempt is already
/// confirmed (GetForegroundWindow() matches this window's handle AND
/// Keyboard.FocusedElement is the age TextBox) — retries on a
/// DispatcherTimer using these four delays in order, each measured from
/// the PREVIOUS attempt (not from when the window opened): 50ms, then
/// 150ms, then 400ms, then 800ms later. No randomness/jitter —
/// deterministic, so the immediate attempt plus these four retries give
/// up to 5 total tries across roughly the first 1.4 seconds the window is
/// open, then retrying stops regardless of outcome (see
/// AgePromptWindow.ArmNextRetry).
/// </summary>
public static class FocusRetrySchedule
{
    public static readonly IReadOnlyList<TimeSpan> Delays = new[]
    {
        TimeSpan.FromMilliseconds(50),
        TimeSpan.FromMilliseconds(150),
        TimeSpan.FromMilliseconds(400),
        TimeSpan.FromMilliseconds(800),
    };
}
