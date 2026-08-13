using System;
using System.Windows;
using VaccineAssist.Desktop.Services;
using VaccineAssist.Desktop.ViewModels;
using VaccineAssist.Desktop.Views;

namespace VaccineAssist.Desktop;

/// <summary>
/// Shell hosting the three post-login screens. Navigation is plain
/// imperative code-behind (no navigation framework, no DataTemplate
/// view-model-first matching) — consistent with this app's DI-light,
/// manually-composed style (see App.xaml.cs).
/// </summary>
public partial class MainWindow : Window
{
    private readonly VaccinesViewModel _vaccinesViewModel;
    private readonly LotsViewModel _lotsViewModel;
    private readonly EntryViewModel _entryViewModel;
    private readonly IAuthService _authService;

    public MainWindow(
        VaccinesViewModel vaccinesViewModel,
        LotsViewModel lotsViewModel,
        EntryViewModel entryViewModel,
        IAuthService authService)
    {
        InitializeComponent();
        _vaccinesViewModel = vaccinesViewModel;
        _lotsViewModel = lotsViewModel;
        _entryViewModel = entryViewModel;
        _authService = authService;

        MainContent.Content = new VaccinesView(_vaccinesViewModel);
    }

    /// <summary>Raised after a successful sign-out — App.xaml.cs shows a
    /// fresh LoginWindow and closes this one.</summary>
    public event EventHandler? LoggedOut;

    private void VaccinesButton_OnClick(object sender, RoutedEventArgs e)
    {
        MainContent.Content = new VaccinesView(_vaccinesViewModel);
    }

    private void LotsButton_OnClick(object sender, RoutedEventArgs e)
    {
        MainContent.Content = new LotsView(_lotsViewModel);
    }

    private void EntryButton_OnClick(object sender, RoutedEventArgs e)
    {
        MainContent.Content = new EntryView(_entryViewModel);
    }

    private async void LogoutButton_OnClick(object sender, RoutedEventArgs e)
    {
        await _authService.SignOutAsync();
        LoggedOut?.Invoke(this, EventArgs.Empty);
    }
}
