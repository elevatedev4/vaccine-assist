namespace VaccineAssist.Desktop.Fax;

/// <summary>
/// Pure decision logic for FaxSettingsViewModel's auto-save behavior
/// (V-T65, Will 2026-09-29 verbatim: "Everything else should save as it
/// is typed ... It's very unintuitive to have a hidden save button where
/// you have to scroll all the way to the bottom"). Factored out so the
/// actual timing rule is directly unit-testable without
/// FaxSettingsViewModel's WPF-adjacent DispatcherTimer — same reasoning as
/// NotifyreKeyPersistencePolicy's own doc comment.
/// </summary>
public static class FaxSettingsAutoSavePolicy
{
    /// <summary>A text box keystroke debounces (Will: "~300 ms"); a
    /// dropdown/selection change saves immediately — there's no "still
    /// typing" state to wait out.</summary>
    public enum ChangeKind
    {
        Text,
        Selection,
    }

    public static readonly TimeSpan TextDebounceDelay = TimeSpan.FromMilliseconds(300);

    /// <summary>How long to wait after a change of this kind before
    /// actually persisting — TimeSpan.Zero means "save right now, don't
    /// start a debounce timer at all."</summary>
    public static TimeSpan DebounceDelayFor(ChangeKind kind) =>
        kind == ChangeKind.Selection ? TimeSpan.Zero : TextDebounceDelay;
}
