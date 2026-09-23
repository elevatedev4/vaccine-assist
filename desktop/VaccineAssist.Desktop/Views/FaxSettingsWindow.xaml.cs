using System.Windows;
using System.Windows.Forms;
using VaccineAssist.Desktop.ViewModels;

namespace VaccineAssist.Desktop.Views;

public partial class FaxSettingsWindow : Window
{
    private readonly FaxSettingsViewModel _viewModel;

    public FaxSettingsWindow(FaxSettingsViewModel viewModel)
    {
        InitializeComponent();
        _viewModel = viewModel;
        DataContext = _viewModel;

        // PasswordBox.Password isn't bindable (same reasoning as
        // LoginWindow's PasswordInput) — prefill once from whatever the
        // ViewModel loaded from FaxCredentialStore.
        AccessPasswordBox.Password = _viewModel.AccessPassword;
    }

    private void SaveButton_OnClick(object sender, RoutedEventArgs e)
    {
        _viewModel.AccessPassword = AccessPasswordBox.Password;
        if (_viewModel.SaveCommand.CanExecute(null))
        {
            _viewModel.SaveCommand.Execute(null);
        }
    }

    private void TestConnectionButton_OnClick(object sender, RoutedEventArgs e)
    {
        _viewModel.AccessPassword = AccessPasswordBox.Password;
        if (_viewModel.TestConnectionCommand.CanExecute(null))
        {
            _viewModel.TestConnectionCommand.Execute(null);
        }
    }

    /// <summary>Uses System.Windows.Forms.FolderBrowserDialog — this
    /// project already takes a WinForms dependency for the tray icon (see
    /// the csproj's UseWindowsForms comment); no need for a second
    /// package just for a folder picker.</summary>
    private void BrowseInputFolder_OnClick(object sender, RoutedEventArgs e)
    {
        using var dialog = new FolderBrowserDialog
        {
            Description = "Choose the folder Vaccine Assist should watch for immunization reports",
            SelectedPath = string.IsNullOrWhiteSpace(_viewModel.InputFolder) ? "" : _viewModel.InputFolder,
        };

        if (dialog.ShowDialog() == DialogResult.OK)
        {
            _viewModel.SetInputFolder(dialog.SelectedPath);
        }
    }
}
