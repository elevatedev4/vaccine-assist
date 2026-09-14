namespace VaccineAssist.Desktop;

/// <summary>
/// Pure decision behind MainWindow.MainTabs_OnSelectionChanged's guard —
/// no WPF (Window/TabControl) dependency itself, so it's covered by fast
/// xUnit tests without needing a live Application/STA message loop (see
/// VaccineAssist.Desktop.Tests\MainWindowTabSelectionTests.cs and this
/// project's own "no WPF in the test project" convention — mirrors
/// Uia/PioneerRxPresenceDecision.cs's same "pure logic split out as its
/// own WPF-free static class" pattern, chosen over a static method
/// directly on MainWindow specifically so this stays callable/testable
/// without pulling MainWindow's own `: Window` base type into the test
/// project's compile).
///
/// THE 2026-09-14 BUG (Will, live — "Signed in, but the main window
/// couldn't be opened", confirmed via app.log): every launch that silently
/// restored a session threw a NullReferenceException at
/// EnsureCloudTabLoaded's very first line and fell back to LoginWindow.
/// Root cause: MainWindow.xaml sets DataEntryTabItem's IsSelected="True",
/// and TabControl auto-selects its first item (Scheduling) by default —
/// BOTH of those selection changes fire SelectionChanged SYNCHRONOUSLY
/// while InitializeComponent() is still parsing the REST of
/// MainWindow.xaml, i.e. before the constructor body has run at all and
/// before x:Name'd fields for TabItems/ContentControls declared LATER in
/// the document (Lots, Active vaccines, Ordering, Physicians) have even
/// been assigned yet. MainTabs_OnSelectionChanged was calling
/// EnsureCloudTabLoaded(LotsTabItem, LotsContent, ...) etc. with those
/// fields still null — tabItem.IsSelected threw.
///
/// Fix: MainTabs_OnSelectionChanged may run its lazy-load checks only once
/// BOTH of these hold true; the very first check instead runs from
/// MainWindow.Loaded (see MainWindow_OnLoaded), by which point every named
/// field in MainWindow.xaml is guaranteed assigned, rather than from the
/// XAML-triggered SelectionChanged that caused the crash.
/// </summary>
public static class MainWindowTabSelectionPolicy
{
    /// <param name="isWindowLoaded">True only once Window.Loaded has fired
    /// — by then every x:Name'd field in MainWindow.xaml is guaranteed
    /// assigned. False for every SelectionChanged fired while
    /// InitializeComponent() is still parsing the document (the exact
    /// crash scenario above).</param>
    /// <param name="isFromTabControlItself">SelectionChanged bubbles up
    /// from any Selector-derived control living inside a tab's own content
    /// (a ComboBox, ListBox, etc.) too — only an actual MainTabs selection
    /// change should run the lazy-load checks, not some unrelated control
    /// inside whichever tab happens to be showing.</param>
    public static bool ShouldHandleTabSelection(bool isWindowLoaded, bool isFromTabControlItself)
        => isWindowLoaded && isFromTabControlItself;
}
