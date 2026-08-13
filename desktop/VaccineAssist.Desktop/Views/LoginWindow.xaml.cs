using System;
using System.Windows;
using VaccineAssist.Desktop.ViewModels;

namespace VaccineAssist.Desktop.Views;

public partial class LoginWindow : Window
{
    private readonly LoginViewModel _viewModel;

    public LoginWindow(LoginViewModel viewModel)
    {
        InitializeComponent();
        _viewModel = viewModel;
        DataContext = _viewModel;
    }

    /// <summary>
    /// PasswordBox.Password isn't a bindable DependencyProperty (by design,
    /// to avoid clear-text passwords living in the visual tree's binding
    /// data), so it's read here and handed to the view model right before
    /// invoking the command — see LoginViewModel.PendingPassword.
    /// </summary>
    private void SignInButton_OnClick(object sender, RoutedEventArgs e)
    {
        _viewModel.PendingPassword = PasswordInput.Password;
        if (_viewModel.SignInCommand.CanExecute(null))
        {
            _viewModel.SignInCommand.Execute(null);
        }
    }
}
