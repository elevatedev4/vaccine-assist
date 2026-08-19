using System;
using System.Collections.Generic;
using System.Globalization;
using System.Windows.Data;

namespace VaccineAssist.Desktop.Common;

/// <summary>
/// Reads one vaccine's count out of ScheduleDisplayRow.CountsByVaccine for
/// a dynamically generated DataGrid column (SchedulingView.xaml.cs) — the
/// vaccine name is passed as ConverterParameter rather than baked into a
/// binding-path string (e.g. "CountsByVaccine[Name]"), which would break
/// on vaccine names containing characters the WPF PropertyPath indexer
/// parser treats specially (commas, brackets).
/// </summary>
public sealed class VaccineCountConverter : IValueConverter
{
    public object Convert(object? value, Type targetType, object? parameter, CultureInfo culture)
    {
        if (value is IReadOnlyDictionary<string, int> countsByVaccine &&
            parameter is string vaccineName &&
            countsByVaccine.TryGetValue(vaccineName, out var count))
        {
            return count;
        }

        return 0;
    }

    public object ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture) =>
        throw new NotSupportedException("VaccineCountConverter is one-way — the Scheduling grid is read-only.");
}
