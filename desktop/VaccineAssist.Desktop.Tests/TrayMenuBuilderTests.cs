using System.Linq;
using VaccineAssist.Desktop.Tray;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// Unit tests for TrayMenuBuilder.Build() — the pure description of the
/// tray icon's context menu (Will, 2026-09-13). TrayIconController itself
/// (the System.Windows.Forms.NotifyIcon/ContextMenuStrip glue) isn't unit
/// tested, same reasoning as GlobalHotKey vs. HotKeyMessage: the OS-facing
/// wrapper is thin and untestable headlessly, so the actual menu
/// content/ordering logic lives here instead, where it can be.
/// </summary>
public class TrayMenuBuilderTests
{
    [Fact]
    public void BuildsExactlyFourItemsInOrder()
    {
        var items = TrayMenuBuilder.Build();

        Assert.Equal(4, items.Count);
        Assert.Equal(TrayMenuAction.Open, items[0].Action);
        Assert.Equal(TrayMenuAction.MacroCodesHint, items[1].Action);
        Assert.Equal(TrayMenuAction.SignOut, items[2].Action);
        Assert.Equal(TrayMenuAction.Exit, items[3].Action);
    }

    [Fact]
    public void OnlyTheMacroCodesHintItemIsDisabled()
    {
        var items = TrayMenuBuilder.Build();

        var hint = items.Single(i => i.Action == TrayMenuAction.MacroCodesHint);
        Assert.False(hint.Enabled);

        foreach (var item in items.Where(i => i.Action != TrayMenuAction.MacroCodesHint))
        {
            Assert.True(item.Enabled);
        }
    }

    [Fact]
    public void MentionsOnlyCtrlKeypad8NeverKeypad7()
    {
        // Will, verbatim: "For now, only show Ctrl+Keypad 8 as the option
        // because 7 isn't working yet and I don't want the staff to get
        // confused." Regression guard against ever reintroducing a
        // Keypad 7 mention here (e.g. by copy-pasting the data-entry
        // hotkey's own wording from EntryView.xaml).
        var items = TrayMenuBuilder.Build();

        Assert.Contains(items, i => i.Text.Contains("Ctrl+Keypad 8"));
        Assert.DoesNotContain(items, i => i.Text.Contains("Keypad 7"));
        Assert.DoesNotContain(items, i => i.Text.Contains("NumPad7"));
    }
}
