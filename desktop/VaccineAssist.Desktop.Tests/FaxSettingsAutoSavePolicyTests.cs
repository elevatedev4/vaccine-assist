using VaccineAssist.Desktop.Fax;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// V-T65 (Will's brief, verbatim, 2026-09-29): "Everything else should
/// save as it is typed" — a text field debounces ~300ms, a selection
/// change (the Provider dropdown) saves immediately. See
/// FaxSettingsAutoSavePolicy's own doc comment for why this pure decision
/// is factored out of FaxSettingsViewModel's DispatcherTimer wiring.
/// </summary>
public class FaxSettingsAutoSavePolicyTests
{
    [Fact]
    public void TextChangeDebouncesFor300Milliseconds()
    {
        var delay = FaxSettingsAutoSavePolicy.DebounceDelayFor(FaxSettingsAutoSavePolicy.ChangeKind.Text);

        Assert.Equal(FaxSettingsAutoSavePolicy.TextDebounceDelay, delay);
        Assert.Equal(300, delay.TotalMilliseconds);
    }

    [Fact]
    public void SelectionChangeSavesImmediatelyWithNoDebounce()
    {
        var delay = FaxSettingsAutoSavePolicy.DebounceDelayFor(FaxSettingsAutoSavePolicy.ChangeKind.Selection);

        Assert.Equal(System.TimeSpan.Zero, delay);
    }
}
