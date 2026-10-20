using System;
using System.Threading.Tasks;
using System.Windows;
using VaccineAssist.Desktop.Logging;

namespace VaccineAssist.Desktop.Services;

/// <summary>
/// What the clipboard held (as text) before a macro-picker flow put a vaccine
/// code on it. Restored when the flow is cancelled so a later manual paste
/// cannot enter the cancelled (non-preferred) code. A non-text clipboard is
/// restored by clearing it (the code is gone either way). Best-effort: every
/// failure is logged, never thrown.
/// </summary>
public sealed record ClipboardSnapshot(string? Text)
{
    public static ClipboardSnapshot Capture()
    {
        try
        {
            return new ClipboardSnapshot(Clipboard.ContainsText() ? Clipboard.GetText() : null);
        }
        catch (Exception ex)
        {
            AppFileLog.LogException("ClipboardSnapshot.Capture", ex);
            return new ClipboardSnapshot((string?)null);
        }
    }

    public async Task RestoreAsync()
    {
        var restored = await ClipboardRetry.TrySetAsync(
            _ => { if (Text is null) Clipboard.Clear(); else Clipboard.SetText(Text); },
            Text ?? "",
            onFailure: (attempt, ex) => AppFileLog.Log($"[FluPrompt] clipboard restore attempt {attempt} failed: {ex.GetType().Name}"));
        AppFileLog.Log(restored
            ? "[FluPrompt] clipboard restored after cancel"
            : "[FluPrompt] could not restore the clipboard after cancel");
    }
}
