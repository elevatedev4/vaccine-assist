using System;
using System.Collections.Generic;

namespace VaccineAssist.Desktop.Uia;

/// <summary>
/// V-T41 ROUND 4 REVIEW FIX (BLOCKER — safety reviewer, PHI): the Priority
/// dialog's redacted raw UIA dump (SendF3AndDismissPreEntryDialogsStep.
/// DumpPriorityDialogRedacted) used to log any element Name that was
/// ≤ 20 characters and contained no digits — a real patient name like
/// "Smith, Jane" passes both of those tests and would have been logged in
/// full. Pure (string in, string out) so the redaction rule itself is
/// directly unit-testable without any UIA dependency — see
/// PriorityDialogRedactionTests.cs.
///
/// Replaced with an ALLOW-LIST: a name is only ever logged verbatim when
/// it EXACTLY matches (case-insensitive, trimmed) one of a small set of
/// known, non-patient UI words this dialog and its controls are expected
/// to use — every other name, however short or plausible-looking, logs as
/// `len=N`. Same "structure over content" convention WindowInfoDiagnostics
/// already uses for window titles (there: length only, always; here: an
/// allow-listed exact word, or length).
/// </summary>
public static class PriorityDialogRedaction
{
    /// <summary>Known non-patient UI words expected inside the Priority
    /// dialog and its controls: the dialog's own likely values/labels
    /// (Priority, Vaccine, Normal, Waiter, Delivery, Mail — plausible
    /// "priority" list items per Will's own framing of this dialog),
    /// common confirm/cancel wording, and control-type words a raw UIA
    /// walk can surface as an element's Name on some frameworks.</summary>
    private static readonly HashSet<string> AllowList = new(StringComparer.OrdinalIgnoreCase)
    {
        // Dialog-specific values/labels.
        "Priority", "Vaccine", "Normal", "Waiter", "Delivery", "Mail",
        // Confirm/cancel wording (brief point 2c's own button-name list, plus the rest).
        "OK", "Cancel", "Select", "Save", "Continue", "Accept", "Close", "Yes", "No", "Open",
        // Control-type words that can surface as an element's own Name.
        "Button", "ComboBox", "List", "ListItem", "DataGrid", "DataItem", "Edit", "Custom", "Window", "Pane", "Text",
    };

    /// <summary>`name=''` for empty/null, `name='<word>'` only when the
    /// TRIMMED name exactly matches an allow-listed word, otherwise
    /// `len=N` (N is the ORIGINAL, untrimmed name's length — never the
    /// name itself).</summary>
    public static string Redact(string? name)
    {
        if (string.IsNullOrEmpty(name)) return "name=''";

        var trimmed = name.Trim();
        if (AllowList.Contains(trimmed)) return $"name='{trimmed}'";

        return $"len={name.Length}";
    }
}
