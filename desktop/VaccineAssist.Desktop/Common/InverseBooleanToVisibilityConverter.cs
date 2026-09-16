using System;
using System.Globalization;
using System.Windows;
using System.Windows.Data;

namespace VaccineAssist.Desktop.Common;

/// <summary>
/// The inverse of the built-in System.Windows.Controls.BooleanToVisibilityConverter
/// (true -> Collapsed, false -> Visible) — LoginWindow.xaml uses this for
/// the "Sign in" label (hidden while busy) and the built-in converter for
/// the in-button spinner (shown while busy), so the two never fight over
/// the same boolean the "wrong" way round. See LoginViewModel.IsBusy /
/// SetBusy's doc comment for why the spinner needs to stay visible for
/// the WHOLE sign-in + cloud-handoff flow, not just the raw auth call.
/// </summary>
public sealed class InverseBooleanToVisibilityConverter : IValueConverter
{
    public object Convert(object? value, Type targetType, object? parameter, CultureInfo culture) =>
        value is bool b && b ? Visibility.Collapsed : Visibility.Visible;

    public object ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture) =>
        throw new NotSupportedException("InverseBooleanToVisibilityConverter is one-way.");
}
