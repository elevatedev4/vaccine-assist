using System;
using VaccineAssist.Desktop.Logging;

namespace VaccineAssist.Desktop.Services;

/// <summary>
/// Thin wrapper over the clipboard so ViewModels don't take a direct WPF
/// dependency. SetText is bounded (ClipboardRetry, about 1 s in total) and
/// throws InvalidOperationException when another program keeps the clipboard
/// locked, so callers can tell the user instead of the UI freezing.
/// </summary>
public sealed class ClipboardService : IClipboardService
{
    public void SetText(string text)
    {
        var ok = ClipboardRetry.TrySet(
            NativeClipboard.SetText,
            text,
            onFailure: (attempt, ex) => AppFileLog.Log($"[Clipboard] set attempt {attempt} failed: {ex.GetType().Name} {ex.Message}"));
        if (!ok)
        {
            throw new InvalidOperationException("The clipboard is busy (another program is holding it).");
        }
    }
}
