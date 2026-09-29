using System.Windows;
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
        // ViewModel loaded from FaxCredentialStore, for SRFax's password
        // field. The Notifyre API token box is deliberately NOT prefilled
        // (Notifyre-key-visibility follow-up, Will 2026-09-28: "never
        // display the full token" — it always starts blank; the
        // NotifyreKeyStatusText line next to it says whether one is
        // already saved).
        AccessPasswordBox.Password = _viewModel.AccessPassword;
    }

    /// <summary>V-T65: the ONLY explicit Save button left on this window —
    /// everything else auto-saves (see FaxSettingsViewModel.AutoSaveFieldsAsync).</summary>
    private void SaveCredentialsButton_OnClick(object sender, RoutedEventArgs e)
    {
        _viewModel.AccessPassword = AccessPasswordBox.Password;
        _viewModel.ApiToken = ApiTokenBox.Password;
        if (_viewModel.SaveCredentialsCommand.CanExecute(null))
        {
            _viewModel.SaveCredentialsCommand.Execute(null);
        }

        // The ViewModel's own ApiToken resets to "" once Save persists it
        // (Notifyre-key-visibility follow-up) — mirror that in the actual
        // PasswordBox too, since Password isn't bindable and would
        // otherwise still show the just-saved paste.
        ApiTokenBox.Password = "";
    }

    private void TestConnectionButton_OnClick(object sender, RoutedEventArgs e)
    {
        _viewModel.AccessPassword = AccessPasswordBox.Password;
        _viewModel.ApiToken = ApiTokenBox.Password;
        if (_viewModel.TestConnectionCommand.CanExecute(null))
        {
            _viewModel.TestConnectionCommand.Execute(null);
        }
    }

    /// <summary>Notifyre-key-visibility follow-up (Will, 2026-09-28):
    /// "Add a 'Forget key' button that clears the stored token (confirm
    /// dialog)." The confirm lives here (a UI concern) — ForgetKeyCommand
    /// itself just does the clearing once confirmed.</summary>
    private void ForgetKeyButton_OnClick(object sender, RoutedEventArgs e)
    {
        var result = System.Windows.MessageBox.Show(
            this,
            "Remove the saved Notifyre API key? You'll need to paste it again before the next fax send.",
            "Vaccine Assist",
            MessageBoxButton.YesNo,
            MessageBoxImage.Warning);
        if (result != MessageBoxResult.Yes) return;

        if (_viewModel.ForgetKeyCommand.CanExecute(null))
        {
            _viewModel.ForgetKeyCommand.Execute(null);
        }

        // The box may have had a not-yet-saved paste in it — clear it too
        // so nothing left in the UI implies a key survived the forget.
        ApiTokenBox.Password = "";
    }
}
