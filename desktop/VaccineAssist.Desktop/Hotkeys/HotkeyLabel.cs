using System;

namespace VaccineAssist.Desktop.Hotkeys;

/// <summary>
/// Pure label maths for the macro-codes hotkey hints (Will 2026-10-30: "The
/// hotkeys for the vaccines should appear as underlined letters in the word,
/// not as [X] brackets after"). The page script underlines the hotkey letter
/// inside a product's own name; WHICH character to underline is decided here
/// so it is unit-tested instead of living only in JavaScript.
/// </summary>
public static class HotkeyLabel
{
    /// <summary>
    /// Zero-based index of the first case-insensitive occurrence of
    /// <paramref name="key"/> inside <paramref name="name"/>, or -1 when the
    /// key is not one character long or does not occur in the name (the page
    /// then falls back to a "[K]" badge so the key is still shown).
    /// </summary>
    public static int UnderlineIndex(string? name, string? key)
    {
        if (string.IsNullOrEmpty(name) || key is null || key.Length != 1) return -1;
        return name.IndexOf(key, StringComparison.OrdinalIgnoreCase);
    }
}
