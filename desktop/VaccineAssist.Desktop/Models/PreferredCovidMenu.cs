using System;
using System.Collections.Generic;

namespace VaccineAssist.Desktop.Models;

/// <summary>One row of the "Preferred COVID vaccine (12+)" menu: the stored value ("pfizer" / "moderna") and its menu text.</summary>
public sealed record PreferredCovidMenuOption(string Value, string Label);

/// <summary>
/// The single copy of the "Preferred COVID vaccine (12+)" menu contents, shared by
/// the tray icon's right-click menu (WinForms) and the blue Pioneer icon's menu
/// (WPF) so the title, the options and the "which row is checked" rule can never
/// drift apart. Ages 3-11 are always Moderna kids, so they have no row.
/// </summary>
public static class PreferredCovidMenu
{
    public const string Title = "Preferred COVID vaccine (12+)";

    public static IReadOnlyList<PreferredCovidMenuOption> Options { get; } = new[]
    {
        new PreferredCovidMenuOption(PreferredCovidSetting.AdultPfizer, "Pfizer (Comirnaty)"),
        new PreferredCovidMenuOption(PreferredCovidSetting.AdultModerna, "Moderna (Mnexspike)"),
    };

    /// <summary>The option value that is checked for a stored setting; anything unrecognised (or null) is Pfizer, the app default.</summary>
    public static string Selected(string? current)
        => PreferredCovidSetting.NormalizeAdult(current) ?? PreferredCovidSetting.AdultPfizer;

    public static bool IsChecked(string optionValue, string? current)
        => string.Equals(optionValue, Selected(current), StringComparison.Ordinal);
}
