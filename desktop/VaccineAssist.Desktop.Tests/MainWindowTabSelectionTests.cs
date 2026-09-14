using VaccineAssist.Desktop;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// Covers MainWindowTabSelectionPolicy.ShouldHandleTabSelection — the pure decision behind
/// the fix for the 2026-09-14 "signed in, but the main window couldn't be
/// opened" bug (confirmed via Will's app.log): a NullReferenceException at
/// EnsureCloudTabLoaded's first line, thrown on EVERY launch that silently
/// restored a session, because MainWindow.xaml's DataEntryTabItem
/// IsSelected="True" (plus TabControl's own first-item auto-select) fired
/// SelectionChanged synchronously WHILE InitializeComponent() was still
/// parsing the rest of the document — before x:Name'd fields for TabItems/
/// ContentControls declared later (Lots, Active vaccines, Ordering,
/// Physicians) were assigned.
///
/// See MainWindowTabSelectionPolicy.ShouldHandleTabSelection's own doc comment for the full
/// story; this test project can't construct a real MainWindow/TabControl
/// (WPF windows need a live Application + STA message loop this test
/// project doesn't set up — see its own csproj comment on why it stays
/// WPF-free), so it exercises the extracted pure bool logic directly.
/// </summary>
public class MainWindowTabSelectionTests
{
    [Fact]
    public void DoesNotHandleSelectionBeforeWindowIsLoaded()
    {
        // The exact crash scenario: SelectionChanged fires from the
        // TabControl itself, but the window (and therefore every x:Name'd
        // field MainTabs_OnSelectionChanged would go on to read) hasn't
        // finished loading yet.
        Assert.False(MainWindowTabSelectionPolicy.ShouldHandleTabSelection(isWindowLoaded: false, isFromTabControlItself: true));
    }

    [Fact]
    public void DoesNotHandleSelectionFromNestedControl()
    {
        // SelectionChanged bubbling up from a ComboBox/ListBox living
        // inside a tab's own content, after the window has loaded — should
        // still be ignored; only an actual MainTabs selection matters.
        Assert.False(MainWindowTabSelectionPolicy.ShouldHandleTabSelection(isWindowLoaded: true, isFromTabControlItself: false));
    }

    [Fact]
    public void DoesNotHandleSelectionWhenNeitherConditionHolds()
    {
        Assert.False(MainWindowTabSelectionPolicy.ShouldHandleTabSelection(isWindowLoaded: false, isFromTabControlItself: false));
    }

    [Fact]
    public void HandlesSelectionOnceWindowIsLoadedAndSourceIsTheTabControl()
    {
        Assert.True(MainWindowTabSelectionPolicy.ShouldHandleTabSelection(isWindowLoaded: true, isFromTabControlItself: true));
    }
}
