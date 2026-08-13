using System.Windows;

namespace VaccineAssist.Desktop.Services;

/// <summary>
/// Thin wrapper over System.Windows.Clipboard so ViewModels don't take a
/// direct WPF dependency (keeps EntryViewModel trivially testable later,
/// even though this phase has no C# test project yet).
/// </summary>
public sealed class ClipboardService : IClipboardService
{
    public void SetText(string text)
    {
        Clipboard.SetText(text);
    }
}
