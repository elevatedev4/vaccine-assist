using System;
using System.Diagnostics;

namespace VaccineAssist.Desktop.Logging;

/// <summary>
/// Milliseconds from a hotkey press to each visible step of a macro flow,
/// written to app.log as "[Timing] Ctrl+Keypad 2: flu popup shown +120 ms".
/// Single UI thread use. Operational text only, never patient data.
/// </summary>
public static class FlowTiming
{
    private static Stopwatch? _clock;
    private static string _flow = "";

    public static void Start(string flow)
    {
        _flow = flow;
        _clock = Stopwatch.StartNew();
        AppFileLog.Log(FormatLine(flow, "hotkey pressed", 0));
    }

    public static void Mark(string step)
    {
        var clock = _clock;
        if (clock is null)
        {
            return;
        }

        AppFileLog.Log(FormatLine(_flow, step, clock.ElapsedMilliseconds));
    }

    public static string FormatLine(string flow, string step, long elapsedMs) =>
        $"[Timing] {flow}: {step} +{elapsedMs} ms";
}
