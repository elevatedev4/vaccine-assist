using System;
using System.Threading.Tasks;
using VaccineAssist.Desktop.Logging;

namespace VaccineAssist.Desktop.Services;

/// <summary>
/// What the clipboard held (as text) before a macro-picker flow put a vaccine
/// code on it. Restored when the flow is cancelled so a later manual paste
/// cannot enter the cancelled (non-preferred) code. A non-text clipboard is
/// restored by clearing it (the code is gone either way). Best-effort and
/// bounded (ClipboardRetry, about 1 s; reading uses half of that): every
/// failure is logged, never thrown. When the clipboard could not be read
/// (<see cref="Captured"/> false) nothing is restored, so a busy clipboard
/// never ends up wiped.
/// </summary>
public sealed record ClipboardSnapshot(string? Text, bool Captured = true)
{
    public static readonly TimeSpan CaptureBudget = TimeSpan.FromMilliseconds(500);

    public static ClipboardSnapshot Capture()
    {
        try
        {
            string? text = null;
            var read = ClipboardRetry.TryRun(
                () => { text = NativeClipboard.GetText(); },
                budget: CaptureBudget,
                onFailure: (attempt, ex) => AppFileLog.Log($"[FluPrompt] clipboard read attempt {attempt} failed: {ex.GetType().Name}"));
            if (!read)
            {
                AppFileLog.Log("[FluPrompt] could not read the clipboard before the picker; it will not be restored on cancel");
                return new ClipboardSnapshot((string?)null, false);
            }

            return new ClipboardSnapshot(text);
        }
        catch (Exception ex)
        {
            AppFileLog.LogException("ClipboardSnapshot.Capture", ex);
            return new ClipboardSnapshot((string?)null, false);
        }
    }

    public async Task RestoreAsync()
    {
        if (!Captured)
        {
            AppFileLog.Log("[FluPrompt] clipboard left as is after cancel (it could not be read earlier)");
            return;
        }

        var restored = await ClipboardRetry.TrySetAsync(
            _ => { if (Text is null) NativeClipboard.Clear(); else NativeClipboard.SetText(Text); },
            Text ?? "",
            onFailure: (attempt, ex) => AppFileLog.Log($"[FluPrompt] clipboard restore attempt {attempt} failed: {ex.GetType().Name}"));
        AppFileLog.Log(restored
            ? "[FluPrompt] clipboard restored after cancel"
            : "[FluPrompt] could not restore the clipboard after cancel");
    }
}
