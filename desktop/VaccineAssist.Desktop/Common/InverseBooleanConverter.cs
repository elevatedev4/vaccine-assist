using System;
using System.Globalization;
using System.Windows.Data;

namespace VaccineAssist.Desktop.Common;

/// <summary>
/// Plain bool inversion — used by LoginWindow.xaml to disable the
/// email/password inputs while LoginViewModel.IsBusy is true (Will,
/// 2026-09-16: "lock the signin button with a spinner ... " — the brief
/// also calls for disabling the inputs, not just the button, while a
/// sign-in is in flight).
/// </summary>
public sealed class InverseBooleanConverter : IValueConverter
{
    public object Convert(object? value, Type targetType, object? parameter, CultureInfo culture) =>
        value is bool b ? !b : true;

    public object ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture) =>
        value is bool b ? !b : false;
}
