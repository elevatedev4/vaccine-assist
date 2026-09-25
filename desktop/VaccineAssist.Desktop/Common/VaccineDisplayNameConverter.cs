using System;
using System.Globalization;
using System.Windows.Data;
using VaccineAssist.Desktop.Services;

namespace VaccineAssist.Desktop.Common;

/// <summary>
/// XAML-binding wrapper around Services.VaccineDisplayName.For — see that
/// class's doc comment for the maker-prefix rule (V-T55, Will 2026-09-25).
/// Used on bindings that render a vaccine name straight from a shared
/// model (Models.Vaccine.Name, Models.VaccineProductOption.Name) so the
/// underlying value stays raw for matching/lookups while only what's
/// drawn on screen changes. One-way — there is no sensible "un-prefix a
/// name the user typed" use case in this app.
/// </summary>
public sealed class VaccineDisplayNameConverter : IValueConverter
{
    public object Convert(object? value, Type targetType, object? parameter, CultureInfo culture) =>
        VaccineDisplayName.For(value as string);

    public object ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture) =>
        throw new NotSupportedException("VaccineDisplayNameConverter is one-way — display-only, never bound back to a stored/matched value.");
}
