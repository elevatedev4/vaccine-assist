using System.ComponentModel;
using System.Runtime.CompilerServices;

namespace VaccineAssist.Desktop.Common;

/// <summary>
/// Minimal INotifyPropertyChanged base class — deliberately no MVVM
/// framework/toolkit dependency (DI-light, matches this app's plain
/// manual-composition style; see App.xaml.cs). Mirrors the same
/// hand-rolled pattern rx-verify's ViewModels use.
/// </summary>
public abstract class ObservableObject : INotifyPropertyChanged
{
    public event PropertyChangedEventHandler? PropertyChanged;

    protected void OnPropertyChanged([CallerMemberName] string? propertyName = null)
    {
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(propertyName));
    }

    /// <summary>
    /// Sets the backing field and raises PropertyChanged only when the
    /// value actually changed. Returns true when it changed.
    /// </summary>
    protected bool SetProperty<T>(ref T field, T value, [CallerMemberName] string? propertyName = null)
    {
        if (Equals(field, value)) return false;
        field = value;
        OnPropertyChanged(propertyName);
        return true;
    }
}
